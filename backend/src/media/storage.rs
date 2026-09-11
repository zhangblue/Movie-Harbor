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
use sha2::{Digest, Sha256};
use std::{
    ffi::OsStr,
    future::Future,
    io::{self, Read},
    path::{Component, Path, PathBuf},
    pin::Pin,
    sync::Arc,
};
use tokio::io::AsyncWriteExt;
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
    BeforeUnlink(String),
    Unlinked(String),
}

pub trait StorageHooks: Send + Sync {
    fn on_event(&self, _event: &StorageEvent) -> io::Result<()> {
        Ok(())
    }
}

struct NoopHooks;
impl StorageHooks for NoopHooks {}

#[derive(Clone)]
pub struct LocalMediaStorage {
    root: Arc<PathBuf>,
    root_fd: Arc<OwnedFd>,
    incoming_fd: Arc<OwnedFd>,
    hooks: Arc<dyn StorageHooks>,
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
    pub(crate) fn mark_registered(&mut self) -> Result<(), MediaError> {
        if let Some(mut cleanup) = self.cleanup.take() {
            cleanup.disarm_formal();
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
}

struct PendingCleanup {
    incoming: Arc<OwnedFd>,
    temp_name: Option<String>,
    marker_name: Option<String>,
    formal: Option<FormalCleanup>,
    hooks: Arc<dyn StorageHooks>,
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
    fn new(incoming: Arc<OwnedFd>, temp_name: String, hooks: Arc<dyn StorageHooks>) -> Self {
        Self {
            incoming,
            temp_name: Some(temp_name),
            marker_name: None,
            formal: None,
            hooks,
        }
    }

    fn promoted(&mut self, directory: Arc<OwnedFd>, file_name: String, storage_key: String) {
        self.temp_name = None;
        self.formal = Some(FormalCleanup {
            directory,
            file_name,
            storage_key,
        });
    }

    fn disarm_formal(&mut self) {
        self.formal = None;
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
        if let Some(name) = self.temp_name.take() {
            let _ = remove_if_present(&self.incoming, &name);
            let _ = sync_fd(&self.incoming);
        }
        let formal_removed = if let Some(formal) = self.formal.take() {
            if self
                .hooks
                .on_event(&StorageEvent::BeforeUnlink(formal.storage_key.clone()))
                .is_err()
            {
                false
            } else {
                remove_if_present(&formal.directory, &formal.file_name).is_ok()
                    && sync_fd(&formal.directory).is_ok()
            }
        } else {
            true
        };
        // A marker is deliberately retained when unlink fails so startup
        // recovery can retry instead of silently leaking the formal file.
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

impl LocalMediaStorage {
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
        let incoming_fd = match open_directory(&root_fd, OsStr::new(".incoming")) {
            Ok(fd) => fd,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                mkdirat(&root_fd, ".incoming", directory_mode()).map_err(io::Error::from)?;
                fsync(&root_fd).map_err(io::Error::from)?;
                open_directory(&root_fd, OsStr::new(".incoming"))?
            }
            Err(error) => return Err(error.into()),
        };
        sync_fd(&root_fd)?;
        hooks.on_event(&StorageEvent::DirectorySynced(String::new()))?;
        Ok(Self {
            root: Arc::new(canonical),
            root_fd: Arc::new(root_fd),
            incoming_fd: Arc::new(incoming_fd),
            hooks,
        })
    }

    pub fn root(&self) -> &Path {
        self.root.as_ref()
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
        let temp_name = format!("{}.part", Uuid::new_v4().simple());
        let mut cleanup = PendingCleanup::new(
            self.incoming_fd.clone(),
            temp_name.clone(),
            self.hooks.clone(),
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
        let kind_fd = self.open_or_create_child(&self.root_fd, kind, "")?;
        let shard_fd = self.open_or_create_child(&kind_fd, shard, kind)?;

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
        file.sync_all().await?;
        self.hooks
            .on_event(&StorageEvent::FileSynced(format!(".incoming/{temp_name}")))?;
        let mut file = file.into_std().await;
        validation::validate_content(spec.format, &mut file, byte_size)?;
        drop(file);

        // A durable marker makes a successfully promoted but unregistered file recoverable.
        let marker_name = format!("{}.pending", spec.resource_id.simple());
        self.write_marker(&marker_name, &key)?;
        cleanup.marker_name = Some(marker_name);
        self.hooks
            .on_event(&StorageEvent::BeforePromote(key.clone()))?;

        // Hooks model a hostile concurrent directory substitution. Revalidating the
        // name-to-capability binding catches it, while all mutations remain relative
        // to the already-open directory descriptors.
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
        cleanup.promoted(
            Arc::new(shard_fd.try_clone()?),
            file_name.clone(),
            key.clone(),
        );
        self.hooks.on_event(&StorageEvent::Promoted(key.clone()))?;
        sync_fd(&shard_fd)?;
        self.hooks
            .on_event(&StorageEvent::DirectorySynced(format!("{kind}/{shard}")))?;
        sync_fd(&self.incoming_fd)?;
        self.hooks
            .on_event(&StorageEvent::DirectorySynced(".incoming".into()))?;

        Ok(StoredFile {
            storage_key: key,
            mime_type: spec.declared_mime.to_owned(),
            byte_size: i64::try_from(byte_size).map_err(|_| MediaError::TooLarge)?,
            checksum_sha256: format!("{:x}", digest.finalize()),
            cleanup: Some(std::mem::replace(
                cleanup,
                PendingCleanup {
                    incoming: self.incoming_fd.clone(),
                    temp_name: None,
                    marker_name: None,
                    formal: None,
                    hooks: self.hooks.clone(),
                },
            )),
        })
    }

    fn write_marker(&self, name: &str, key: &str) -> Result<(), MediaError> {
        let marker = openat(
            &self.incoming_fd,
            name,
            OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            file_mode(),
        )
        .map_err(io::Error::from)?;
        let mut marker = std::fs::File::from(marker);
        use std::io::Write;
        marker.write_all(key.as_bytes())?;
        marker.sync_all()?;
        self.hooks
            .on_event(&StorageEvent::FileSynced(format!(".incoming/{name}")))?;
        sync_fd(&self.incoming_fd)?;
        self.hooks
            .on_event(&StorageEvent::DirectorySynced(".incoming".into()))?;
        Ok(())
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
                sync_fd(parent)?;
                self.hooks
                    .on_event(&StorageEvent::DirectorySynced(parent_label.to_owned()))?;
                Ok(open_directory(parent, OsStr::new(name))?)
            }
            Err(error) => Err(error.into()),
        }
    }

    pub async fn remove_registered(&self, storage_key: &str) -> Result<(), MediaError> {
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
        let stat = match statat(&shard_fd, file, AtFlags::SYMLINK_NOFOLLOW) {
            Ok(stat) => stat,
            Err(error) if error == rustix::io::Errno::NOENT => return Ok(()),
            Err(error) => return Err(io::Error::from(error).into()),
        };
        if rustix::fs::FileType::from_raw_mode(stat.st_mode) != rustix::fs::FileType::RegularFile {
            return Err(MediaError::InvalidStorageKey);
        }
        self.hooks
            .on_event(&StorageEvent::BeforeUnlink(storage_key.to_owned()))?;
        unlinkat(&shard_fd, file, AtFlags::empty()).map_err(io::Error::from)?;
        self.hooks
            .on_event(&StorageEvent::Unlinked(storage_key.to_owned()))?;
        sync_fd(&shard_fd)?;
        self.hooks
            .on_event(&StorageEvent::DirectorySynced(format!("{kind}/{shard}")))?;
        Ok(())
    }

    pub(crate) fn incoming_entries(&self) -> Result<Vec<IncomingEntry>, MediaError> {
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

    pub(crate) fn read_pending_marker(&self, name: &str) -> Result<String, MediaError> {
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
        let mut reader = std::fs::File::from(fd).take(257);
        let mut key = String::new();
        reader.read_to_string(&mut key)?;
        if key.len() > 256 {
            return Err(MediaError::InvalidStorageKey);
        }
        parse_storage_key(&key)?;
        Ok(key)
    }

    pub(crate) fn remove_incoming(&self, name: &str) -> Result<(), MediaError> {
        if !is_controlled_incoming_name(name) {
            return Err(MediaError::InvalidStorageKey);
        }
        remove_if_present(&self.incoming_fd, name)?;
        sync_fd(&self.incoming_fd)?;
        self.hooks
            .on_event(&StorageEvent::DirectorySynced(".incoming".into()))?;
        Ok(())
    }
}

fn open_directory<F: AsFd>(parent: &F, name: &OsStr) -> io::Result<OwnedFd> {
    openat(
        parent,
        name,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(Into::into)
}

fn same_named_directory<F: AsFd>(
    parent: &F,
    name: &str,
    opened: &OwnedFd,
) -> Result<bool, MediaError> {
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
    let Some(stem) = name.strip_suffix(suffix) else {
        return false;
    };
    stem.len() == 32
        && stem
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn parse_storage_key(key: &str) -> Result<(&str, &str, &str), MediaError> {
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
