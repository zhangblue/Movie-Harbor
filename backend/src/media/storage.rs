use super::{
    MediaError,
    validation::{self, MediaKind, UploadPolicy},
};
use axum::body::Bytes;
use rustix::{
    fd::{AsFd, OwnedFd},
    fs::{
        AtFlags, CWD, Mode, OFlags, RenameFlags, fsync, mkdirat, openat, renameat_with, statat,
        unlinkat,
    },
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    ffi::OsStr,
    future::Future,
    io::{self, Read, Seek},
    path::{Component, Path, PathBuf},
    pin::Pin,
    sync::Arc,
};
use tokio::io::AsyncWriteExt;
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};
use uuid::Uuid;

pub trait ChunkSource {
    fn next_chunk(
        &mut self,
    ) -> Pin<Box<dyn Future<Output = Result<Option<Bytes>, MediaError>> + Send + '_>>;
}

impl ChunkSource for axum::extract::multipart::Field<'_> {
    fn next_chunk(
        &mut self,
    ) -> Pin<Box<dyn Future<Output = Result<Option<Bytes>, MediaError>> + Send + '_>> {
        Box::pin(async move {
            self.chunk().await.map_err(|error| {
                if error.status() == axum::http::StatusCode::PAYLOAD_TOO_LARGE {
                    MediaError::TooLarge
                } else {
                    MediaError::Multipart(error.to_string())
                }
            })
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum StorageEvent {
    FileSynced(String),
    DirectorySynced(String),
    BeforePromote(String),
    Promoted(String),
    BeforeRemovalLock,
    BeforeStage(String),
    AfterStageRename(String),
    BeforeUnlink(String),
    Unlinked(String),
    BeforeDirectorySync(String),
    DatabaseCommitted(String),
    RecoveryCycleCompleted,
}

pub trait StorageHooks: Send + Sync {
    fn on_event(&self, _event: &StorageEvent) -> io::Result<()> {
        Ok(())
    }

    /// 在原子移入隔离区前采样，用于确定性注入删除后的持久化故障。
    /// 生产环境的钩子保持禁用。
    fn fail_next_post_unlink_sync(&self) -> bool {
        false
    }

    /// 在原子移动前采样，用于确定性注入暂存后的持久化故障。
    /// 生产环境的钩子保持禁用。
    fn fail_next_post_stage_sync(&self) -> bool {
        false
    }
}

struct NoopHooks;
impl StorageHooks for NoopHooks {}

#[derive(Clone)]
pub struct LocalMediaStorage {
    root: Arc<PathBuf>,
    root_fd: Arc<OwnedFd>,
    incoming_fd: Arc<OwnedFd>,
    quarantine_fd: Arc<OwnedFd>,
    operations_fd: Arc<OwnedFd>,
    // 同一存储实例及其克隆共用变更锁；上传、替换、删除及恢复协调持锁，避免归属判断相互交错。
    mutations: Arc<AsyncMutex<()>>,
    hooks: Arc<dyn StorageHooks>,
}

pub(crate) struct RemovalSource {
    pub storage_key: String,
    leaf: Arc<OwnedFd>,
    file_name: String,
    device: u64,
    inode: u64,
}

pub(crate) struct RemovalOperation {
    pub(crate) name: String,
    directory: Arc<OwnedFd>,
}

pub(crate) struct PersistedRemovalOperation {
    pub operation: RemovalOperation,
    pub manifest: Vec<u8>,
}

impl std::fmt::Debug for LocalMediaStorage {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("LocalMediaStorage")
            .field("root", &self.root)
            .finish_non_exhaustive()
    }
}

#[derive(Debug)]
pub struct StoredFile {
    pub storage_key: String,
    pub mime_type: String,
    pub byte_size: i64,
    pub checksum_sha256: String,
    cleanup: Option<PendingCleanup>,
}

impl StoredFile {
    pub(crate) fn take_mutation_guard(&mut self) -> Result<OwnedMutexGuard<()>, MediaError> {
        // 替换流程接走已有锁守卫，连续保护新文件登记与旧文件暂存，无需释放后重新抢锁。
        self.cleanup
            .as_mut()
            .and_then(|cleanup| cleanup._mutation_guard.take())
            .ok_or_else(|| io::Error::other("stored file has no mutation guard").into())
    }

    pub(crate) fn return_mutation_guard(
        &mut self,
        guard: OwnedMutexGuard<()>,
    ) -> Result<(), MediaError> {
        let cleanup = self
            .cleanup
            .as_mut()
            .ok_or_else(|| io::Error::other("stored file has no pending cleanup"))?;
        if cleanup._mutation_guard.is_some() {
            return Err(io::Error::other("stored file already has a mutation guard").into());
        }
        cleanup._mutation_guard = Some(guard);
        Ok(())
    }

    pub(crate) fn begin_database_write(&mut self) {
        // 数据库写入开始后，取消或连接错误可能使结果未知；Drop 必须保留正式文件及恢复标记。
        if let Some(cleanup) = &mut self.cleanup {
            cleanup.destructive = false;
        }
    }

    pub(crate) fn database_failure_is_known(&mut self) {
        // 只有调用方已确认数据库失败，才重新允许 Drop 删除本次未登记的正式文件。
        if let Some(cleanup) = &mut self.cleanup {
            cleanup.destructive = true;
        }
    }

    pub(crate) fn notify_database_committed(&self) -> Result<(), MediaError> {
        if let Some(cleanup) = &self.cleanup {
            cleanup
                .hooks
                .on_event(&StorageEvent::DatabaseCommitted(self.storage_key.clone()))?;
        }
        Ok(())
    }

    pub(crate) fn mark_registered(&mut self) -> Result<(), MediaError> {
        if let Some(mut cleanup) = self.cleanup.take() {
            // 登记成功后先解除正式文件的清理责任；即使移除标记失败，也不能删除数据库已引用的文件。
            cleanup.formal = None;
            cleanup.remove_marker()?;
        }
        Ok(())
    }
}

#[derive(Debug)]
pub(crate) struct IncomingEntry {
    pub name: String,
    pub modified_unix_seconds: i64,
}

struct FormalCleanup {
    directory: Arc<OwnedFd>,
    file_name: String,
    storage_key: String,
    device: u64,
    inode: u64,
    byte_size: u64,
    checksum_sha256: String,
}

struct PendingCleanup {
    incoming: Arc<OwnedFd>,
    quarantine: Arc<OwnedFd>,
    temp_name: Option<String>,
    marker_name: Option<String>,
    formal: Option<FormalCleanup>,
    hooks: Arc<dyn StorageHooks>,
    destructive: bool,
    _mutation_guard: Option<OwnedMutexGuard<()>>,
}

impl std::fmt::Debug for PendingCleanup {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PendingCleanup")
            .field("temp_name", &self.temp_name)
            .field("marker_name", &self.marker_name)
            .field(
                "formal",
                &self.formal.as_ref().map(|formal| &formal.storage_key),
            )
            .finish()
    }
}

impl PendingCleanup {
    fn new(
        incoming: Arc<OwnedFd>,
        quarantine: Arc<OwnedFd>,
        temp_name: String,
        hooks: Arc<dyn StorageHooks>,
        mutation_guard: OwnedMutexGuard<()>,
    ) -> Self {
        Self {
            incoming,
            quarantine,
            temp_name: Some(temp_name),
            marker_name: None,
            formal: None,
            hooks,
            destructive: true,
            _mutation_guard: Some(mutation_guard),
        }
    }

    fn promoted(
        &mut self,
        directory: Arc<OwnedFd>,
        file_name: String,
        storage_key: String,
        marker: &PendingMarker,
    ) {
        // 原子移动后清理目标从临时名切换为正式文件，并保留校验时的身份，防止误删同名替代文件。
        self.temp_name = None;
        self.formal = Some(FormalCleanup {
            directory,
            file_name,
            storage_key,
            device: marker.device,
            inode: marker.inode,
            byte_size: marker.byte_size,
            checksum_sha256: marker.checksum_sha256.clone(),
        });
    }

    fn remove_marker(&mut self) -> Result<(), MediaError> {
        if let Some(name) = self.marker_name.take() {
            remove_if_present(&self.incoming, &name)?;
            sync_fd(&self.incoming)?;
            self.hooks
                .on_event(&StorageEvent::DirectorySynced(".incoming".into()))?;
        }
        Ok(())
    }
}

impl Drop for PendingCleanup {
    fn drop(&mut self) {
        // 析构只能尽力收尾，不能向调用方返回错误或改写数据库结果；正式文件清理还取决于结果是否明确。
        if let Some(name) = self.temp_name.take() {
            let _ = remove_if_present(&self.incoming, &name);
            let _ = sync_fd(&self.incoming);
        }
        let formal_removed = if !self.destructive {
            false
        } else if let Some(formal) = self.formal.take() {
            remove_owned_from_leaf(
                &formal.directory,
                &formal.file_name,
                &formal.storage_key,
                DeletionIdentity {
                    device: Some(formal.device),
                    inode: Some(formal.inode),
                    byte_size: formal.byte_size,
                    checksum_sha256: &formal.checksum_sha256,
                },
                &self.quarantine,
                &self.hooks,
            )
            .is_ok()
        } else {
            true
        };
        // 正式文件删除或同步失败时刻意保留标记，交给启动恢复重试，避免静默遗留文件。
        // 数据库结果未知时也保留标记，待恢复流程查询数据库后再决定是否删除。
        if formal_removed {
            let _ = self.remove_marker();
        }
    }
}

struct StoreSpec<'a> {
    resource_id: Uuid,
    kind: MediaKind,
    declared_mime: &'a str,
    format: validation::ExpectedFormat,
    max_bytes: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub(crate) struct PendingMarker {
    version: u8,
    pub storage_key: String,
    device: u64,
    inode: u64,
    byte_size: u64,
    checksum_sha256: String,
}

struct DeletionIdentity<'a> {
    device: Option<u64>,
    inode: Option<u64>,
    byte_size: u64,
    checksum_sha256: &'a str,
}

#[derive(Debug, Deserialize, Serialize)]
struct QuarantineClaim {
    version: u8,
    storage_key: String,
    device: u64,
    inode: u64,
    byte_size: u64,
    checksum_sha256: String,
}

impl LocalMediaStorage {
    pub(crate) fn validate_storage_key(&self, storage_key: &str) -> Result<(), MediaError> {
        parse_storage_key(storage_key).map(|_| ())
    }

    pub async fn initialize(root: impl AsRef<Path>) -> Result<Self, MediaError> {
        Self::initialize_with_hooks(root, Arc::new(NoopHooks)).await
    }

    pub async fn initialize_with_hooks(
        root: impl AsRef<Path>,
        hooks: Arc<dyn StorageHooks>,
    ) -> Result<Self, MediaError> {
        tokio::fs::create_dir_all(root.as_ref()).await?;
        let canonical = tokio::fs::canonicalize(root.as_ref()).await?;
        let root_fd = open_directory(&CWD, canonical.as_os_str())?;
        // 根目录须由后端账号拥有且不允许组或其他用户写入，防止外部写入者替换受控目录项。
        verify_exclusive_directory(&root_fd, false)?;
        // 子目录通过不跟随符号链接的目录描述符打开；新建时使用 0700 并同步根目录项。
        let incoming_fd = match open_directory(&root_fd, OsStr::new(".incoming")) {
            Ok(fd) => fd,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                mkdirat(&root_fd, ".incoming", directory_mode()).map_err(io::Error::from)?;
                fsync(&root_fd).map_err(io::Error::from)?;
                open_directory(&root_fd, OsStr::new(".incoming"))?
            }
            Err(error) => return Err(error.into()),
        };
        let quarantine_fd = match open_directory(&root_fd, OsStr::new(".quarantine")) {
            Ok(fd) => fd,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                mkdirat(&root_fd, ".quarantine", directory_mode()).map_err(io::Error::from)?;
                fsync(&root_fd).map_err(io::Error::from)?;
                open_directory(&root_fd, OsStr::new(".quarantine"))?
            }
            Err(error) => return Err(error.into()),
        };
        // 隔离区与操作清单目录还要求既有权限严格为 0700，保护临时占有的文件及恢复依据。
        verify_exclusive_directory(&quarantine_fd, true)?;
        let operations_fd = match open_directory(&root_fd, OsStr::new(".operations")) {
            Ok(fd) => fd,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                mkdirat(&root_fd, ".operations", directory_mode()).map_err(io::Error::from)?;
                fsync(&root_fd).map_err(io::Error::from)?;
                open_directory(&root_fd, OsStr::new(".operations"))?
            }
            Err(error) => return Err(error.into()),
        };
        verify_exclusive_directory(&operations_fd, true)?;
        // 实例对外提供服务前，先恢复隔离区中身份可证明且原位置空缺的文件；此阶段不查询数据库。
        recover_quarantine_claims(&root_fd, &quarantine_fd)?;
        sync_fd(&root_fd)?;
        hooks.on_event(&StorageEvent::DirectorySynced(String::new()))?;
        Ok(Self {
            root: Arc::new(canonical),
            root_fd: Arc::new(root_fd),
            incoming_fd: Arc::new(incoming_fd),
            quarantine_fd: Arc::new(quarantine_fd),
            operations_fd: Arc::new(operations_fd),
            mutations: Arc::new(AsyncMutex::new(())),
            hooks,
        })
    }

    pub fn root(&self) -> &Path {
        self.root.as_ref()
    }

    /// 通过目录描述符逐级解析持久化存储键，并验证目标是可读的普通文件。
    /// 此过程不跟随符号链接，也不信任直接拼接的路径。
    pub fn is_accessible_regular_file(&self, storage_key: &str) -> Result<bool, MediaError> {
        let (kind, shard, file) = parse_storage_key(storage_key)?;
        let kind_fd = match open_directory(&self.root_fd, OsStr::new(kind)) {
            Ok(fd) => fd,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(error.into()),
        };
        let shard_fd = match open_directory(&kind_fd, OsStr::new(shard)) {
            Ok(fd) => fd,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(error.into()),
        };
        let file = match openat(
            &shard_fd,
            file,
            OFlags::RDONLY | OFlags::NONBLOCK | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        ) {
            Ok(file) => file,
            Err(error) if error == rustix::io::Errno::NOENT => return Ok(false),
            Err(error) => return Err(io::Error::from(error).into()),
        };
        let stat = rustix::fs::fstat(file).map_err(io::Error::from)?;
        Ok(rustix::fs::FileType::from_raw_mode(stat.st_mode) == rustix::fs::FileType::RegularFile)
    }

    pub async fn store<S: ChunkSource + Send>(
        &self,
        resource_id: Uuid,
        kind: MediaKind,
        original_name: &str,
        declared_mime: &str,
        policy: &UploadPolicy,
        mut source: S,
    ) -> Result<StoredFile, MediaError> {
        let format = validation::validate_metadata(kind, original_name, declared_mime, policy)?;
        // 锁随清理责任移入 StoredFile，覆盖流式写入、正式落盘及调用方随后的数据库登记。
        let mutation_guard = self.mutations.clone().lock_owned().await;
        let temp_name = format!("{}.part", Uuid::new_v4().simple());
        let mut cleanup = PendingCleanup::new(
            self.incoming_fd.clone(),
            self.quarantine_fd.clone(),
            temp_name.clone(),
            self.hooks.clone(),
            mutation_guard,
        );
        let spec = StoreSpec {
            resource_id,
            kind,
            declared_mime,
            format,
            max_bytes: policy.max_bytes(),
        };
        self.write_and_promote(&temp_name, spec, &mut source, &mut cleanup)
            .await
    }

    async fn write_and_promote<S: ChunkSource + Send>(
        &self,
        temp_name: &str,
        spec: StoreSpec<'_>,
        source: &mut S,
        cleanup: &mut PendingCleanup,
    ) -> Result<StoredFile, MediaError> {
        let simple = spec.resource_id.simple().to_string();
        let kind = spec.kind.directory();
        let shard = &simple[..2];
        let file_name = format!("{}.{}", simple, spec.format.extension);
        let key = format!("{kind}/{shard}/{file_name}");
        // 先准备按用途和资源 ID 前两位分层的目标目录，新建目录项由辅助函数同步后再使用。
        let kind_fd = self.open_or_create_child(&self.root_fd, kind, "")?;
        let shard_fd = Arc::new(self.open_or_create_child(&kind_fd, shard, kind)?);

        let temp_fd = openat(
            &self.incoming_fd,
            temp_name,
            OFlags::RDWR | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            file_mode(),
        )
        .map_err(io::Error::from)?;
        let std_file = std::fs::File::from(temp_fd);
        let mut file = tokio::fs::File::from_std(std_file);
        let mut byte_size = 0_u64;
        let mut digest = Sha256::new();
        // 分块累计大小和摘要，溢出或超限立即退出；数据逐块写入，避免把大视频完整留在内存。
        while let Some(chunk) = source.next_chunk().await? {
            byte_size = byte_size
                .checked_add(chunk.len() as u64)
                .ok_or(MediaError::TooLarge)?;
            if byte_size > spec.max_bytes {
                return Err(MediaError::TooLarge);
            }
            digest.update(&chunk);
            file.write_all(&chunk).await?;
            file.flush().await?;
        }
        // flush 完成缓冲写入，sync_all 才建立文件数据的持久化边界；之后仍须校验真实内容才能提升。
        file.sync_all().await?;
        self.hooks
            .on_event(&StorageEvent::FileSynced(format!(".incoming/{temp_name}")))?;
        let mut file = file.into_std().await;
        validation::validate_content(spec.format, &mut file, byte_size)?;
        let validated_stat = rustix::fs::fstat(&file).map_err(io::Error::from)?;
        if rustix::fs::FileType::from_raw_mode(validated_stat.st_mode)
            != rustix::fs::FileType::RegularFile
        {
            return Err(MediaError::InvalidStorageKey);
        }
        let checksum_sha256 = format!("{:x}", digest.finalize());

        // 在提升前持久化标记，使已经移动到正式目录、但尚未登记到数据库的文件可由启动恢复判定。
        let marker_name = format!("{}.pending", spec.resource_id.simple());
        let marker = PendingMarker {
            version: 1,
            storage_key: key.clone(),
            device: validated_stat.st_dev as u64,
            inode: validated_stat.st_ino as u64,
            byte_size,
            checksum_sha256: checksum_sha256.clone(),
        };
        self.write_marker(&marker_name, &marker)?;
        cleanup.marker_name = Some(marker_name);
        self.hooks
            .on_event(&StorageEvent::BeforePromote(key.clone()))?;

        // 钩子可模拟并发替换目录的攻击；提升前重检名称与已打开目录的身份绑定，发现替换即拒绝。
        // 后续修改仍相对已打开的目录描述符执行，配合 O_NOFOLLOW 避免重新解析被替换的路径。
        if !same_named_directory(&self.root_fd, kind, &kind_fd)?
            || !same_named_directory(&kind_fd, shard, &shard_fd)?
        {
            return Err(MediaError::InvalidStorageKey);
        }
        renameat_with(
            &self.incoming_fd,
            temp_name,
            &shard_fd,
            file_name.as_str(),
            RenameFlags::NOREPLACE,
        )
        .map_err(io::Error::from)?;
        cleanup.promoted(shard_fd.clone(), file_name.clone(), key.clone(), &marker);
        // 移动后再次核对类型、设备、inode 和大小，确认正式名称仍指向刚才验证的文件。
        let promoted_stat = statat(&shard_fd, file_name.as_str(), AtFlags::SYMLINK_NOFOLLOW)
            .map_err(io::Error::from)?;
        if rustix::fs::FileType::from_raw_mode(promoted_stat.st_mode)
            != rustix::fs::FileType::RegularFile
            || promoted_stat.st_dev as u64 != marker.device
            || promoted_stat.st_ino as u64 != marker.inode
            || promoted_stat.st_size as u64 != marker.byte_size
        {
            return Err(MediaError::InvalidStorageKey);
        }
        drop(file);
        self.hooks.on_event(&StorageEvent::Promoted(key.clone()))?;
        // 重命名成功不等于目录项已持久化；同步目标和来源目录，持久化正式名称及临时名称的消失。
        self.sync_directory(&shard_fd, format!("{kind}/{shard}"))?;
        self.sync_directory(&self.incoming_fd, ".incoming".into())?;

        Ok(StoredFile {
            storage_key: key,
            mime_type: spec.declared_mime.to_owned(),
            byte_size: i64::try_from(byte_size).map_err(|_| MediaError::TooLarge)?,
            checksum_sha256,
            cleanup: Some(std::mem::replace(
                cleanup,
                PendingCleanup {
                    incoming: self.incoming_fd.clone(),
                    quarantine: self.quarantine_fd.clone(),
                    temp_name: None,
                    marker_name: None,
                    formal: None,
                    hooks: self.hooks.clone(),
                    destructive: true,
                    _mutation_guard: None,
                },
            )),
        })
    }

    fn write_marker(&self, name: &str, marker: &PendingMarker) -> Result<(), MediaError> {
        // 先写入并同步独占临时文件，再以不可覆盖的重命名发布标记，避免恢复读取半份 JSON。
        let temporary_name = format!("{}.part", Uuid::new_v4().simple());
        let result = (|| {
            let marker_fd = openat(
                &self.incoming_fd,
                temporary_name.as_str(),
                OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                file_mode(),
            )
            .map_err(io::Error::from)?;
            let mut marker_file = std::fs::File::from(marker_fd);
            use std::io::Write;
            let encoded = serde_json::to_vec(marker).map_err(io::Error::other)?;
            marker_file.write_all(&encoded)?;
            marker_file.sync_all()?;
            self.hooks.on_event(&StorageEvent::FileSynced(format!(
                ".incoming/{temporary_name}"
            )))?;
            self.sync_directory(&self.incoming_fd, ".incoming".into())?;
            renameat_with(
                &self.incoming_fd,
                temporary_name.as_str(),
                &self.incoming_fd,
                name,
                RenameFlags::NOREPLACE,
            )
            .map_err(io::Error::from)?;
            self.sync_directory(&self.incoming_fd, ".incoming".into())?;
            self.hooks
                .on_event(&StorageEvent::FileSynced(format!(".incoming/{name}")))?;
            Ok(())
        })();
        if result.is_err() {
            let _ = remove_if_present(&self.incoming_fd, &temporary_name);
            let _ = sync_fd(&self.incoming_fd);
        }
        result
    }

    fn open_or_create_child<F: AsFd>(
        &self,
        parent: &F,
        name: &str,
        parent_label: &str,
    ) -> Result<OwnedFd, MediaError> {
        match open_directory(parent, OsStr::new(name)) {
            Ok(fd) => Ok(fd),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                mkdirat(parent, name, directory_mode()).map_err(io::Error::from)?;
                self.sync_directory(parent, parent_label.to_owned())?;
                Ok(open_directory(parent, OsStr::new(name))?)
            }
            Err(error) => Err(error.into()),
        }
    }

    fn sync_directory<F: AsFd>(&self, fd: &F, label: String) -> Result<(), MediaError> {
        self.hooks
            .on_event(&StorageEvent::BeforeDirectorySync(label.clone()))?;
        sync_fd(fd)?;
        self.hooks.on_event(&StorageEvent::DirectorySynced(label))?;
        Ok(())
    }

    pub(crate) async fn lock_removal(&self) -> Result<OwnedMutexGuard<()>, MediaError> {
        // 删除和操作清单恢复由调用方持有同一把锁，贯穿暂存、数据库决策以及恢复或最终清理。
        self.hooks.on_event(&StorageEvent::BeforeRemovalLock)?;
        Ok(self.mutations.clone().lock_owned().await)
    }

    pub(crate) fn prepare_removal(
        &self,
        storage_key: &str,
    ) -> Result<Option<RemovalSource>, MediaError> {
        // 缺失文件按幂等删除处理；存在时只接受受控普通文件，保存目录描述符和身份供暂存前重检。
        let (kind, shard, file_name) = parse_storage_key(storage_key)?;
        let kind_fd = match open_directory(&self.root_fd, OsStr::new(kind)) {
            Ok(fd) => fd,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(MediaError::InvalidStorageKey),
        };
        let leaf = match open_directory(&kind_fd, OsStr::new(shard)) {
            Ok(fd) => fd,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(MediaError::InvalidStorageKey),
        };
        let opened = match openat(
            &leaf,
            file_name,
            OFlags::RDONLY | OFlags::NONBLOCK | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        ) {
            Ok(fd) => fd,
            Err(rustix::io::Errno::NOENT) => return Ok(None),
            Err(_) => return Err(MediaError::InvalidStorageKey),
        };
        let stat = rustix::fs::fstat(&opened).map_err(io::Error::from)?;
        if rustix::fs::FileType::from_raw_mode(stat.st_mode) != rustix::fs::FileType::RegularFile {
            return Err(MediaError::InvalidStorageKey);
        }
        Ok(Some(RemovalSource {
            storage_key: storage_key.to_owned(),
            leaf: Arc::new(leaf),
            file_name: file_name.to_owned(),
            device: stat.st_dev as u64,
            inode: stat.st_ino as u64,
        }))
    }

    pub(crate) fn create_removal_operation(
        &self,
        operation_id: Uuid,
        manifest: &[u8],
    ) -> Result<RemovalOperation, MediaError> {
        // 操作目录先持久化，再同步清单内容并原子发布 manifest.json；调用方拿到结果后才开始暂存。
        let name = operation_id.simple().to_string();
        mkdirat(&self.operations_fd, name.as_str(), directory_mode()).map_err(io::Error::from)?;
        sync_fd(&self.operations_fd)?;
        let directory = Arc::new(open_directory(&self.operations_fd, OsStr::new(&name))?);
        let temporary = "manifest.part";
        let fd = openat(
            &directory,
            temporary,
            OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            file_mode(),
        )
        .map_err(io::Error::from)?;
        let mut file = std::fs::File::from(fd);
        use std::io::Write;
        file.write_all(manifest)?;
        file.sync_all()?;
        renameat_with(
            &directory,
            temporary,
            &directory,
            "manifest.json",
            RenameFlags::NOREPLACE,
        )
        .map_err(io::Error::from)?;
        sync_fd(&directory)?;
        Ok(RemovalOperation { name, directory })
    }

    pub(crate) fn stage_removal_source(
        &self,
        operation: &RemovalOperation,
        source: &RemovalSource,
        staged_name: &str,
    ) -> Result<(), MediaError> {
        let fail_post_stage_sync = self.hooks.fail_next_post_stage_sync();
        self.hooks
            .on_event(&StorageEvent::BeforeStage(source.storage_key.clone()))?;
        // 预检与暂存之间可能有同名替换；移动前确认仍是预检时的普通文件，并禁止覆盖已有暂存名。
        let before = statat(
            &source.leaf,
            source.file_name.as_str(),
            AtFlags::SYMLINK_NOFOLLOW,
        )
        .map_err(io::Error::from)?;
        if rustix::fs::FileType::from_raw_mode(before.st_mode) != rustix::fs::FileType::RegularFile
            || before.st_dev as u64 != source.device
            || before.st_ino as u64 != source.inode
        {
            return Err(MediaError::InvalidStorageKey);
        }
        renameat_with(
            &source.leaf,
            source.file_name.as_str(),
            &operation.directory,
            staged_name,
            RenameFlags::NOREPLACE,
        )
        .map_err(io::Error::from)?;
        self.hooks
            .on_event(&StorageEvent::AfterStageRename(source.storage_key.clone()))?;
        if fail_post_stage_sync {
            return Err(io::Error::other("injected post-stage sync failure").into());
        }
        // 两侧目录都同步后才报告暂存完成；移动已发生但同步失败时，由操作清单支持后续恢复。
        sync_fd(&source.leaf)?;
        sync_fd(&operation.directory)?;
        Ok(())
    }

    pub(crate) fn restore_removal_source(
        &self,
        operation: &RemovalOperation,
        source: &RemovalSource,
        staged_name: &str,
    ) -> Result<(), MediaError> {
        // 恢复不覆盖原位置新出现的文件；暂存名已不存在时允许幂等返回，其余错误交给调用方处理。
        match renameat_with(
            &operation.directory,
            staged_name,
            &source.leaf,
            source.file_name.as_str(),
            RenameFlags::NOREPLACE,
        ) {
            Ok(()) => {
                sync_fd(&operation.directory)?;
                sync_fd(&source.leaf)?;
                Ok(())
            }
            Err(rustix::io::Errno::NOENT) => Ok(()),
            Err(error) => Err(io::Error::from(error).into()),
        }
    }

    pub(crate) fn finish_removal_source(
        &self,
        operation: &RemovalOperation,
        staged_name: &str,
    ) -> Result<(), MediaError> {
        // 调用方确认数据库已提交或已无引用后，才删除清单中的暂存普通文件并同步目录项。
        let opened = match openat(
            &operation.directory,
            staged_name,
            OFlags::RDONLY | OFlags::NONBLOCK | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        ) {
            Ok(fd) => fd,
            Err(rustix::io::Errno::NOENT) => return Ok(()),
            Err(_) => return Err(MediaError::InvalidStorageKey),
        };
        let stat = rustix::fs::fstat(opened).map_err(io::Error::from)?;
        if rustix::fs::FileType::from_raw_mode(stat.st_mode) != rustix::fs::FileType::RegularFile {
            return Err(MediaError::InvalidStorageKey);
        }
        unlinkat(&operation.directory, staged_name, AtFlags::empty()).map_err(io::Error::from)?;
        sync_fd(&operation.directory)?;
        Ok(())
    }

    pub(crate) fn close_removal_operation(
        &self,
        operation: &RemovalOperation,
    ) -> Result<(), MediaError> {
        // 只在目录中不再有暂存数据或未知条目时删除清单，避免丢失仍需恢复文件的唯一操作依据。
        let directory =
            rustix::fs::Dir::read_from(&operation.directory).map_err(io::Error::from)?;
        for entry in directory {
            let entry = entry.map_err(io::Error::from)?;
            let name = entry.file_name().to_string_lossy();
            if name != "." && name != ".." && name != "manifest.json" {
                return Err(
                    io::Error::other("removal operation still contains staged data").into(),
                );
            }
        }
        remove_if_present(&operation.directory, "manifest.json")?;
        sync_fd(&operation.directory)?;
        unlinkat(
            &self.operations_fd,
            operation.name.as_str(),
            AtFlags::REMOVEDIR,
        )
        .map_err(io::Error::from)?;
        sync_fd(&self.operations_fd)?;
        Ok(())
    }

    pub(crate) fn persisted_removal_operations(
        &self,
    ) -> Result<Vec<PersistedRemovalOperation>, MediaError> {
        // 只枚举受控操作目录；已发布清单交给 removal::recover 按数据库引用决定恢复还是完成删除。
        let directory = rustix::fs::Dir::read_from(&self.operations_fd).map_err(io::Error::from)?;
        let mut operations = Vec::new();
        for entry in directory {
            let entry = entry.map_err(io::Error::from)?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if !valid_claim_base(&name) {
                continue;
            }
            let operation_directory = Arc::new(
                open_directory(&self.operations_fd, OsStr::new(&name))
                    .map_err(|_| MediaError::InvalidStorageKey)?,
            );
            let manifest = match openat(
                &operation_directory,
                "manifest.json",
                OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                Mode::empty(),
            ) {
                Ok(manifest) => manifest,
                Err(rustix::io::Errno::NOENT) => {
                    // 尚未发布清单的目录仅允许为空或含 manifest.part，不能据此删除其他残留数据。
                    self.clean_unpublished_removal_operation(&name, &operation_directory)?;
                    continue;
                }
                Err(_) => return Err(MediaError::InvalidStorageKey),
            };
            let stat = rustix::fs::fstat(&manifest).map_err(io::Error::from)?;
            if rustix::fs::FileType::from_raw_mode(stat.st_mode)
                != rustix::fs::FileType::RegularFile
            {
                return Err(MediaError::InvalidStorageKey);
            }
            // 多读一个字节识别超限清单；损坏或超限时拒绝恢复，不扩大到无清单文件的清理。
            let mut reader = std::fs::File::from(manifest).take(65_537);
            let mut encoded = Vec::new();
            reader.read_to_end(&mut encoded)?;
            if encoded.len() > 65_536 {
                return Err(MediaError::InvalidStorageKey);
            }
            operations.push(PersistedRemovalOperation {
                operation: RemovalOperation {
                    name,
                    directory: operation_directory,
                },
                manifest: encoded,
            });
        }
        Ok(operations)
    }

    fn clean_unpublished_removal_operation(
        &self,
        name: &str,
        operation: &OwnedFd,
    ) -> Result<(), MediaError> {
        let directory = rustix::fs::Dir::read_from(operation).map_err(io::Error::from)?;
        let mut has_manifest_part = false;
        for entry in directory {
            let entry = entry.map_err(io::Error::from)?;
            let entry_name = entry.file_name().to_string_lossy();
            if entry_name == "." || entry_name == ".." {
                continue;
            }
            if entry_name != "manifest.part" || has_manifest_part {
                return Err(MediaError::InvalidStorageKey);
            }
            let part = openat(
                operation,
                "manifest.part",
                OFlags::RDONLY | OFlags::NONBLOCK | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                Mode::empty(),
            )
            .map_err(|_| MediaError::InvalidStorageKey)?;
            let stat = rustix::fs::fstat(part).map_err(io::Error::from)?;
            if rustix::fs::FileType::from_raw_mode(stat.st_mode)
                != rustix::fs::FileType::RegularFile
            {
                return Err(MediaError::InvalidStorageKey);
            }
            has_manifest_part = true;
        }
        if has_manifest_part {
            remove_if_present(operation, "manifest.part")?;
            sync_fd(operation)?;
        }
        unlinkat(&self.operations_fd, name, AtFlags::REMOVEDIR).map_err(io::Error::from)?;
        sync_fd(&self.operations_fd)?;
        Ok(())
    }

    pub(crate) fn validate_persisted_removal_entry(
        &self,
        operation: &RemovalOperation,
        staged_name: &str,
    ) -> Result<bool, MediaError> {
        if !is_staged_removal_name(staged_name) {
            return Err(MediaError::InvalidStorageKey);
        }
        let staged = match openat(
            &operation.directory,
            staged_name,
            OFlags::RDONLY | OFlags::NONBLOCK | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        ) {
            Ok(staged) => staged,
            Err(rustix::io::Errno::NOENT) => return Ok(false),
            Err(_) => return Err(MediaError::InvalidStorageKey),
        };
        let stat = rustix::fs::fstat(staged).map_err(io::Error::from)?;
        if rustix::fs::FileType::from_raw_mode(stat.st_mode) != rustix::fs::FileType::RegularFile {
            return Err(MediaError::InvalidStorageKey);
        }
        Ok(true)
    }

    pub(crate) fn restore_persisted_removal(
        &self,
        operation: &RemovalOperation,
        storage_key: &str,
        staged_name: &str,
    ) -> Result<(), MediaError> {
        // 数据库仍引用该文件时恢复公开位置；若暂存副本已不在，必须确认正式位置已有普通文件。
        let staged_exists = self.validate_persisted_removal_entry(operation, staged_name)?;
        let (kind, shard, file) = parse_storage_key(storage_key)?;
        let kind_fd = open_directory(&self.root_fd, OsStr::new(kind))
            .map_err(|_| MediaError::InvalidStorageKey)?;
        let shard_fd = open_directory(&kind_fd, OsStr::new(shard))
            .map_err(|_| MediaError::InvalidStorageKey)?;
        if !staged_exists {
            let existing = openat(
                &shard_fd,
                file,
                OFlags::RDONLY | OFlags::NONBLOCK | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                Mode::empty(),
            )
            .map_err(|_| MediaError::InvalidStorageKey)?;
            let stat = rustix::fs::fstat(existing).map_err(io::Error::from)?;
            return if rustix::fs::FileType::from_raw_mode(stat.st_mode)
                == rustix::fs::FileType::RegularFile
            {
                Ok(())
            } else {
                Err(MediaError::InvalidStorageKey)
            };
        }
        match renameat_with(
            &operation.directory,
            staged_name,
            &shard_fd,
            file,
            RenameFlags::NOREPLACE,
        ) {
            Ok(()) => {
                sync_fd(&operation.directory)?;
                sync_fd(&shard_fd)?;
                Ok(())
            }
            Err(rustix::io::Errno::NOENT) => Err(MediaError::InvalidStorageKey),
            Err(_) => Err(MediaError::InvalidStorageKey),
        }
    }

    pub(crate) async fn remove_pending_owned(
        &self,
        marker: &PendingMarker,
    ) -> Result<bool, MediaError> {
        // 调用方已确认没有数据库登记；拿锁后重读标记，避免使用等待期间已被替换或移除的恢复依据。
        let _mutation_guard = self.mutations.lock().await;
        let (_, _, file) = parse_storage_key(&marker.storage_key)?;
        let marker_name = format!(
            "{}.pending",
            file.rsplit_once('.')
                .map(|(stem, _)| stem)
                .ok_or(MediaError::InvalidStorageKey)?
        );
        if self.read_pending_marker(&marker_name).ok().as_ref() != Some(marker) {
            return Ok(false);
        }
        self.remove_registered_if_owned(
            &marker.storage_key,
            DeletionIdentity {
                device: Some(marker.device),
                inode: Some(marker.inode),
                byte_size: marker.byte_size,
                checksum_sha256: &marker.checksum_sha256,
            },
        )?;
        Ok(true)
    }

    fn remove_registered_if_owned(
        &self,
        storage_key: &str,
        owner: DeletionIdentity<'_>,
    ) -> Result<(), MediaError> {
        let (kind, shard, file) = parse_storage_key(storage_key)?;
        let kind_fd = match open_directory(&self.root_fd, OsStr::new(kind)) {
            Ok(fd) => fd,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(_) => return Err(MediaError::InvalidStorageKey),
        };
        let shard_fd = match open_directory(&kind_fd, OsStr::new(shard)) {
            Ok(fd) => fd,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(_) => return Err(MediaError::InvalidStorageKey),
        };
        remove_owned_from_leaf(
            &shard_fd,
            file,
            storage_key,
            owner,
            &self.quarantine_fd,
            &self.hooks,
        )
    }

    pub(crate) fn incoming_entries(&self) -> Result<Vec<IncomingEntry>, MediaError> {
        // 启动上传恢复只看到受控名称的普通文件，由上层按年龄和数据库登记状态处理，不扫描正式目录。
        let directory = rustix::fs::Dir::read_from(&self.incoming_fd).map_err(io::Error::from)?;
        let mut entries = Vec::new();
        for entry in directory {
            let entry = entry.map_err(io::Error::from)?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if !is_controlled_incoming_name(&name) {
                continue;
            }
            let stat = statat(&self.incoming_fd, name.as_str(), AtFlags::SYMLINK_NOFOLLOW)
                .map_err(io::Error::from)?;
            if rustix::fs::FileType::from_raw_mode(stat.st_mode)
                != rustix::fs::FileType::RegularFile
            {
                continue;
            }
            entries.push(IncomingEntry {
                name,
                modified_unix_seconds: stat.st_mtime,
            });
        }
        Ok(entries)
    }

    pub(crate) fn read_pending_marker(&self, name: &str) -> Result<PendingMarker, MediaError> {
        // 名称、长度、版本、摘要格式和资源 ID 必须共同匹配，任何不可信标记都不能成为删除授权。
        if !is_pending_name(name) {
            return Err(MediaError::InvalidStorageKey);
        }
        let fd = openat(
            &self.incoming_fd,
            name,
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(io::Error::from)?;
        let mut reader = std::fs::File::from(fd).take(1025);
        let mut encoded = Vec::new();
        reader.read_to_end(&mut encoded)?;
        if encoded.len() > 1024 {
            return Err(MediaError::InvalidStorageKey);
        }
        let marker: PendingMarker =
            serde_json::from_slice(&encoded).map_err(|_| MediaError::InvalidStorageKey)?;
        if marker.version != 1 || !valid_sha256(&marker.checksum_sha256) {
            return Err(MediaError::InvalidStorageKey);
        }
        let (_, _, file_name) = parse_storage_key(&marker.storage_key)?;
        let resource = file_name
            .rsplit_once('.')
            .map(|(stem, _)| stem)
            .ok_or(MediaError::InvalidStorageKey)?;
        if name.strip_suffix(".pending") != Some(resource) {
            return Err(MediaError::InvalidStorageKey);
        }
        Ok(marker)
    }

    pub(crate) async fn remove_incoming(&self, name: &str) -> Result<(), MediaError> {
        let _mutation_guard = self.mutations.lock().await;
        if !is_controlled_incoming_name(name) {
            return Err(MediaError::InvalidStorageKey);
        }
        remove_if_present(&self.incoming_fd, name)?;
        sync_fd(&self.incoming_fd)?;
        self.hooks
            .on_event(&StorageEvent::DirectorySynced(".incoming".into()))?;
        Ok(())
    }

    pub(crate) fn notify_recovery_cycle_completed(&self) -> Result<(), MediaError> {
        self.hooks.on_event(&StorageEvent::RecoveryCycleCompleted)?;
        Ok(())
    }
}

fn open_directory<F: AsFd>(parent: &F, name: &OsStr) -> io::Result<OwnedFd> {
    // 受控子目录逐级相对已打开的父目录解析；要求目录类型并拒绝符号链接，避免跳出受控层级。
    openat(
        parent,
        name,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(Into::into)
}

#[cfg(unix)]
fn verify_exclusive_directory(directory: &OwnedFd, require_private_mode: bool) -> io::Result<()> {
    let stat = rustix::fs::fstat(directory).map_err(io::Error::from)?;
    let permissions = stat.st_mode & 0o777;
    let owned_by_backend = stat.st_uid == rustix::process::geteuid().as_raw();
    let safe_permissions = permissions & 0o022 == 0
        && (!require_private_mode || permissions == directory_mode().bits());
    if owned_by_backend && safe_permissions {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "media root must be owned by the backend OS account and must not be group/world writable; .quarantine must be mode 0700",
        ))
    }
}

fn recover_quarantine_claims(root: &OwnedFd, quarantine: &OwnedFd) -> Result<(), MediaError> {
    // 只处理有合法 claim 的隔离副本；设备、inode、大小和内容摘要均匹配且原位置空缺才恢复。
    // 无关、损坏或身份不符的条目原地保留，不能把启动恢复变成对隔离区的无差别清理。
    let entries = rustix::fs::Dir::read_from(quarantine).map_err(io::Error::from)?;
    for entry in entries {
        let entry = entry.map_err(io::Error::from)?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(base) = name
            .strip_suffix(".claim")
            .filter(|base| valid_claim_base(base))
        else {
            continue;
        };
        let Some(claim) = read_quarantine_claim(quarantine, &name)? else {
            continue;
        };
        let data_name = format!("{base}.data");
        let data_fd = match openat(
            quarantine,
            data_name.as_str(),
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        ) {
            Ok(fd) => fd,
            Err(rustix::io::Errno::NOENT) => {
                remove_if_present(quarantine, &name)?;
                sync_fd(quarantine)?;
                continue;
            }
            Err(error) => return Err(io::Error::from(error).into()),
        };
        let stat = rustix::fs::fstat(&data_fd).map_err(io::Error::from)?;
        let mut data = std::fs::File::from(data_fd);
        if rustix::fs::FileType::from_raw_mode(stat.st_mode) != rustix::fs::FileType::RegularFile
            || stat.st_dev as u64 != claim.device
            || stat.st_ino as u64 != claim.inode
            || stat.st_size as u64 != claim.byte_size
            || hash_opened_file(&mut data)? != claim.checksum_sha256
        {
            continue;
        }
        let Ok((kind, shard, file)) = parse_storage_key(&claim.storage_key) else {
            continue;
        };
        let Ok(kind_fd) = open_directory(root, OsStr::new(kind)) else {
            continue;
        };
        let Ok(shard_fd) = open_directory(&kind_fd, OsStr::new(shard)) else {
            continue;
        };
        match statat(&shard_fd, file, AtFlags::SYMLINK_NOFOLLOW) {
            Err(rustix::io::Errno::NOENT) => {}
            Ok(_) | Err(_) => continue,
        }
        renameat_with(
            quarantine,
            data_name.as_str(),
            &shard_fd,
            file,
            RenameFlags::NOREPLACE,
        )
        .map_err(io::Error::from)?;
        sync_fd(quarantine)?;
        sync_fd(&shard_fd)?;
        remove_if_present(quarantine, &name)?;
        sync_fd(quarantine)?;
    }
    Ok(())
}

fn read_quarantine_claim(
    quarantine: &OwnedFd,
    name: &str,
) -> Result<Option<QuarantineClaim>, MediaError> {
    let fd = openat(
        quarantine,
        name,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(io::Error::from)?;
    let mut reader = std::fs::File::from(fd).take(2049);
    let mut encoded = Vec::new();
    reader.read_to_end(&mut encoded)?;
    if encoded.len() > 2048 {
        return Ok(None);
    }
    let Ok(claim) = serde_json::from_slice::<QuarantineClaim>(&encoded) else {
        return Ok(None);
    };
    Ok((claim.version == 1 && valid_sha256(&claim.checksum_sha256)).then_some(claim))
}

fn valid_claim_base(base: &str) -> bool {
    // 操作目录和 claim 基名限定为系统生成的 UUID 简写，不接管其他名称的文件或目录。
    base.len() == 32
        && base
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn is_staged_removal_name(name: &str) -> bool {
    // 清单中的暂存名只允许八位十进制序号加 .data，拒绝路径分量和未知命名格式。
    name.len() == 13
        && name.ends_with(".data")
        && name[..8].bytes().all(|byte| byte.is_ascii_digit())
}

#[cfg(not(unix))]
fn verify_exclusive_directory(_directory: &OwnedFd, _require_private_mode: bool) -> io::Result<()> {
    Ok(())
}

fn same_named_directory<F: AsFd>(
    parent: &F,
    name: &str,
    opened: &OwnedFd,
) -> Result<bool, MediaError> {
    // 不跟随同名符号链接，比较名称当前指向对象与已持有描述符的设备和 inode，识别目录替换。
    let named = statat(parent, name, AtFlags::SYMLINK_NOFOLLOW).map_err(io::Error::from)?;
    let held = rustix::fs::fstat(opened).map_err(io::Error::from)?;
    Ok(named.st_dev == held.st_dev && named.st_ino == held.st_ino)
}

fn sync_fd<F: AsFd>(fd: &F) -> io::Result<()> {
    fsync(fd).map_err(Into::into)
}

fn file_mode() -> Mode {
    Mode::RUSR | Mode::WUSR
}

fn directory_mode() -> Mode {
    Mode::RUSR | Mode::WUSR | Mode::XUSR
}

fn remove_if_present<F: AsFd>(parent: &F, name: &str) -> io::Result<()> {
    match unlinkat(parent, name, AtFlags::empty()) {
        Ok(()) | Err(rustix::io::Errno::NOENT) => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn remove_owned_from_leaf<F: AsFd>(
    leaf: &F,
    file: &str,
    storage_key: &str,
    owner: DeletionIdentity<'_>,
    quarantine: &OwnedFd,
    hooks: &Arc<dyn StorageHooks>,
) -> Result<(), MediaError> {
    let directory_label = storage_key
        .rsplit_once('/')
        .map(|(directory, _)| directory)
        .ok_or(MediaError::InvalidStorageKey)?;
    let sync_leaf = || -> Result<(), MediaError> {
        hooks.on_event(&StorageEvent::BeforeDirectorySync(
            directory_label.to_owned(),
        ))?;
        sync_fd(leaf)?;
        hooks.on_event(&StorageEvent::DirectorySynced(directory_label.to_owned()))?;
        Ok(())
    };
    let original_fd = match openat(
        leaf,
        file,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    ) {
        Ok(fd) => fd,
        Err(rustix::io::Errno::NOENT) => {
            clear_completed_quarantine_claims(quarantine, storage_key)?;
            sync_fd(quarantine)?;
            sync_leaf()?;
            return Ok(());
        }
        Err(error) => return Err(io::Error::from(error).into()),
    };
    // 始终对已打开文件做身份和内容校验，不能仅凭相同存储键认定当前文件属于这次清理。
    let original_stat = rustix::fs::fstat(&original_fd).map_err(io::Error::from)?;
    let mut original_file = std::fs::File::from(original_fd);
    let matches_owner = rustix::fs::FileType::from_raw_mode(original_stat.st_mode)
        == rustix::fs::FileType::RegularFile
        && owner
            .device
            .is_none_or(|device| original_stat.st_dev as u64 == device)
        && owner
            .inode
            .is_none_or(|inode| original_stat.st_ino as u64 == inode)
        && original_stat.st_size as u64 == owner.byte_size
        && hash_opened_file(&mut original_file)? == owner.checksum_sha256;
    if !matches_owner {
        return Err(MediaError::InvalidStorageKey);
    }

    // 耗时的内容校验在故障注入边界前完成；之后的隔离占有、固定字段身份重检、删除和同步
    // 在 mutations 锁保护的同步临界区内执行。随机隔离名配合不可覆盖的重命名避免同名冲突。
    let quarantine_base = Uuid::new_v4().simple().to_string();
    let quarantine_name = format!("{quarantine_base}.data");
    let claim_name = format!("{quarantine_base}.claim");
    write_quarantine_claim(
        quarantine,
        &claim_name,
        &QuarantineClaim {
            version: 1,
            storage_key: storage_key.to_owned(),
            device: original_stat.st_dev as u64,
            inode: original_stat.st_ino as u64,
            byte_size: original_stat.st_size as u64,
            checksum_sha256: owner.checksum_sha256.to_owned(),
        },
    )?;
    let fail_post_unlink_sync = hooks.fail_next_post_unlink_sync();
    if let Err(error) = hooks.on_event(&StorageEvent::BeforeUnlink(storage_key.to_owned())) {
        remove_if_present(quarantine, &claim_name)?;
        sync_fd(quarantine)?;
        return Err(error.into());
    }
    if let Err(error) = renameat_with(
        leaf,
        file,
        quarantine,
        quarantine_name.as_str(),
        RenameFlags::NOREPLACE,
    ) {
        remove_if_present(quarantine, &claim_name)?;
        sync_fd(quarantine)?;
        return Err(io::Error::from(error).into());
    }
    let claimed_stat = statat(
        quarantine,
        quarantine_name.as_str(),
        AtFlags::SYMLINK_NOFOLLOW,
    )
    .map_err(io::Error::from)?;
    let claimed_is_original = rustix::fs::FileType::from_raw_mode(claimed_stat.st_mode)
        == rustix::fs::FileType::RegularFile
        && claimed_stat.st_dev == original_stat.st_dev
        && claimed_stat.st_ino == original_stat.st_ino
        && claimed_stat.st_size == original_stat.st_size;
    if !claimed_is_original {
        // 重命名可能捕获校验后被换入的文件；身份不符时尝试放回，绝不能按旧文件的授权将其删除。
        let restored = renameat_with(
            quarantine,
            quarantine_name.as_str(),
            leaf,
            file,
            RenameFlags::NOREPLACE,
        );
        sync_fd(quarantine)?;
        sync_fd(leaf)?;
        if restored.is_err() {
            // 原位置被并发占用而无法恢复时，把无关条目保留在私有隔离区，不能将其销毁。
            return Err(MediaError::InvalidStorageKey);
        }
        remove_if_present(quarantine, &claim_name)?;
        sync_fd(quarantine)?;
        return Err(MediaError::InvalidStorageKey);
    }
    // 删除并同步两侧目录后才移除 claim；删除或这两次同步失败时保留恢复依据，供下次安全判定。
    unlinkat(quarantine, quarantine_name.as_str(), AtFlags::empty()).map_err(io::Error::from)?;
    if fail_post_unlink_sync {
        return Err(io::Error::other("injected post-unlink directory fsync failure").into());
    }
    sync_fd(quarantine)?;
    sync_fd(leaf)?;
    remove_if_present(quarantine, &claim_name)?;
    sync_fd(quarantine)?;
    drop(original_file);
    hooks.on_event(&StorageEvent::Unlinked(storage_key.to_owned()))?;
    hooks.on_event(&StorageEvent::DirectorySynced(directory_label.to_owned()))?;
    Ok(())
}

fn hash_opened_file(file: &mut std::fs::File) -> Result<String, MediaError> {
    file.seek(std::io::SeekFrom::Start(0))?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 8192];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn write_quarantine_claim(
    quarantine: &OwnedFd,
    name: &str,
    claim: &QuarantineClaim,
) -> Result<(), MediaError> {
    // claim 必须先持久化再移动媒体文件；临时写入、文件同步、原子发布和目录同步缺一不可。
    let temporary_name = format!("{}.part", Uuid::new_v4().simple());
    let result = (|| {
        let fd = openat(
            quarantine,
            temporary_name.as_str(),
            OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            file_mode(),
        )
        .map_err(io::Error::from)?;
        let mut file = std::fs::File::from(fd);
        use std::io::Write;
        file.write_all(&serde_json::to_vec(claim).map_err(io::Error::other)?)?;
        file.sync_all()?;
        renameat_with(
            quarantine,
            temporary_name.as_str(),
            quarantine,
            name,
            RenameFlags::NOREPLACE,
        )
        .map_err(io::Error::from)?;
        sync_fd(quarantine)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = remove_if_present(quarantine, &temporary_name);
        let _ = sync_fd(quarantine);
    }
    result
}

fn clear_completed_quarantine_claims(
    quarantine: &OwnedFd,
    storage_key: &str,
) -> Result<(), MediaError> {
    // 只清除同一存储键且隔离数据已不存在的有效 claim；未知记录和仍有数据的记录继续保留。
    let entries = rustix::fs::Dir::read_from(quarantine).map_err(io::Error::from)?;
    for entry in entries {
        let entry = entry.map_err(io::Error::from)?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(base) = name
            .strip_suffix(".claim")
            .filter(|base| valid_claim_base(base))
        else {
            continue;
        };
        let Some(claim) = read_quarantine_claim(quarantine, &name)? else {
            continue;
        };
        if claim.storage_key != storage_key {
            continue;
        }
        let data_name = format!("{base}.data");
        if matches!(
            statat(quarantine, data_name.as_str(), AtFlags::SYMLINK_NOFOLLOW),
            Err(rustix::io::Errno::NOENT)
        ) {
            remove_if_present(quarantine, &name)?;
        }
    }
    Ok(())
}

fn valid_sha256(checksum: &str) -> bool {
    // 摘要只接受完整的小写十六进制，非法格式不能参与恢复时的所有权证明。
    checksum.len() == 64
        && checksum
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn is_controlled_incoming_name(name: &str) -> bool {
    is_part_name(name) || is_pending_name(name)
}

fn is_part_name(name: &str) -> bool {
    is_uuid_suffix(name, ".part")
}

fn is_pending_name(name: &str) -> bool {
    is_uuid_suffix(name, ".pending")
}

fn is_uuid_suffix(name: &str, suffix: &str) -> bool {
    // 仅接收系统生成的 32 位小写十六进制名及指定后缀，不把任意临时目录条目纳入清理。
    let Some(stem) = name.strip_suffix(suffix) else {
        return false;
    };
    stem.len() == 32
        && stem
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn parse_storage_key(key: &str) -> Result<(&str, &str, &str), MediaError> {
    // 失败关闭：只接受解析为三个普通路径分量的键，拒绝绝对路径、父目录穿越、反斜杠和空字符。
    if key.contains(['\\', '\0']) {
        return Err(MediaError::InvalidStorageKey);
    }
    let components = Path::new(key).components().collect::<Vec<_>>();
    let [
        Component::Normal(kind),
        Component::Normal(shard),
        Component::Normal(file),
    ] = components.as_slice()
    else {
        return Err(MediaError::InvalidStorageKey);
    };
    let kind = kind.to_str().ok_or(MediaError::InvalidStorageKey)?;
    let shard = shard.to_str().ok_or(MediaError::InvalidStorageKey)?;
    let file = file.to_str().ok_or(MediaError::InvalidStorageKey)?;
    validate_storage_key_parts(kind, shard, file)?;
    Ok((kind, shard, file))
}

fn validate_storage_key_parts(kind: &str, shard: &str, file: &str) -> Result<(), MediaError> {
    // 用途、分片前缀、资源 ID 与扩展名必须相互匹配，不能把任意根目录内文件当作媒体处理。
    if !matches!(kind, "poster" | "video") {
        return Err(MediaError::InvalidStorageKey);
    }
    let (stem, extension) = file.rsplit_once('.').ok_or(MediaError::InvalidStorageKey)?;
    let valid_hex = |value: &str, length| {
        value.len() == length
            && value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    };
    if !valid_hex(shard, 2) || !valid_hex(stem, 32) || !stem.starts_with(shard) {
        return Err(MediaError::InvalidStorageKey);
    }
    let valid_extension = match kind {
        "poster" => matches!(extension, "jpg" | "png" | "webp"),
        "video" => matches!(extension, "mp4" | "webm" | "ogv"),
        _ => false,
    };
    valid_extension
        .then_some(())
        .ok_or(MediaError::InvalidStorageKey)
}
