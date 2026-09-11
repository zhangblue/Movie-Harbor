use super::{
    MediaError,
    validation::{self, MediaKind, UploadPolicy},
};
use axum::body::Bytes;
use sha2::{Digest, Sha256};
use std::{
    future::Future,
    path::{Component, Path, PathBuf},
    pin::Pin,
    sync::Arc,
};
use tokio::{fs, io::AsyncWriteExt};
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
            self.chunk()
                .await
                .map_err(|error| MediaError::Multipart(error.to_string()))
        })
    }
}

#[derive(Clone, Debug)]
pub struct LocalMediaStorage {
    root: Arc<PathBuf>,
    incoming: Arc<PathBuf>,
}

#[derive(Clone, Debug)]
pub struct StoredFile {
    pub storage_key: String,
    pub mime_type: String,
    pub byte_size: i64,
    pub checksum_sha256: String,
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
        fs::create_dir_all(root.as_ref()).await?;
        let root = fs::canonicalize(root.as_ref()).await?;
        let incoming = root.join(".incoming");
        fs::create_dir_all(&incoming).await?;
        let metadata = fs::symlink_metadata(&incoming).await?;
        let canonical_incoming = fs::canonicalize(&incoming).await?;
        if metadata.file_type().is_symlink()
            || !metadata.is_dir()
            || canonical_incoming != incoming
            || !canonical_incoming.starts_with(&root)
        {
            return Err(MediaError::InvalidStorageKey);
        }
        Ok(Self {
            root: Arc::new(root),
            incoming: Arc::new(canonical_incoming),
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
        let temp_path = self
            .incoming
            .join(format!("{}.part", Uuid::new_v4().simple()));
        let spec = StoreSpec {
            resource_id,
            kind,
            declared_mime,
            format,
            max_bytes: policy.max_bytes(),
        };
        let result = self.write_and_promote(&temp_path, spec, &mut source).await;
        if result.is_err() {
            let _ = fs::remove_file(&temp_path).await;
        }
        result
    }

    async fn write_and_promote<S: ChunkSource + Send>(
        &self,
        temp_path: &Path,
        spec: StoreSpec<'_>,
        source: &mut S,
    ) -> Result<StoredFile, MediaError> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(temp_path)
            .await?;
        let mut byte_size = 0_u64;
        let mut prefix = Vec::new();
        let mut digest = Sha256::new();
        while let Some(chunk) = source.next_chunk().await? {
            byte_size = byte_size
                .checked_add(chunk.len() as u64)
                .ok_or(MediaError::TooLarge)?;
            if byte_size > spec.max_bytes {
                return Err(MediaError::TooLarge);
            }
            validation::retain_sniff_prefix(&mut prefix, &chunk);
            digest.update(&chunk);
            file.write_all(&chunk).await?;
            file.flush().await?;
        }
        validation::validate_content(spec.format, &prefix)?;
        file.sync_all().await?;
        drop(file);

        let simple = spec.resource_id.simple().to_string();
        let key = format!(
            "{}/{}/{}.{}",
            spec.kind.directory(),
            &simple[..2],
            simple,
            spec.format.extension
        );
        let final_path = self.checked_destination(&key, true).await?;
        if fs::symlink_metadata(&final_path).await.is_ok() {
            return Err(MediaError::InvalidStorageKey);
        }
        fs::rename(temp_path, &final_path).await?;
        if let Err(error) =
            sync_directory(final_path.parent().expect("generated path has parent")).await
        {
            let _ = fs::remove_file(&final_path).await;
            return Err(error.into());
        }
        Ok(StoredFile {
            storage_key: key,
            mime_type: spec.declared_mime.to_owned(),
            byte_size: i64::try_from(byte_size).map_err(|_| MediaError::TooLarge)?,
            checksum_sha256: format!("{:x}", digest.finalize()),
        })
    }

    pub async fn remove_registered(&self, storage_key: &str) -> Result<(), MediaError> {
        let path = self.checked_destination(storage_key, false).await?;
        match fs::symlink_metadata(&path).await {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
                Err(MediaError::InvalidStorageKey)
            }
            Ok(_) => {
                fs::remove_file(path).await?;
                Ok(())
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
        }
    }

    async fn checked_destination(
        &self,
        key: &str,
        create_parent: bool,
    ) -> Result<PathBuf, MediaError> {
        validate_storage_key(key)?;
        let path = self.root.join(key);
        let parent = path.parent().ok_or(MediaError::InvalidStorageKey)?;
        if create_parent {
            fs::create_dir_all(parent).await?;
        }
        let canonical_parent = fs::canonicalize(parent).await.map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                MediaError::InvalidStorageKey
            } else {
                error.into()
            }
        })?;
        if canonical_parent != parent || !canonical_parent.starts_with(self.root.as_ref()) {
            return Err(MediaError::InvalidStorageKey);
        }
        Ok(path)
    }
}

fn validate_storage_key(key: &str) -> Result<(), MediaError> {
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
    if !matches!(kind, "poster" | "video") {
        return Err(MediaError::InvalidStorageKey);
    }
    let shard = shard.to_str().ok_or(MediaError::InvalidStorageKey)?;
    let file = file.to_str().ok_or(MediaError::InvalidStorageKey)?;
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

async fn sync_directory(path: &Path) -> std::io::Result<()> {
    let path = path.to_owned();
    tokio::task::spawn_blocking(move || std::fs::File::open(path)?.sync_all())
        .await
        .map_err(std::io::Error::other)?
}
