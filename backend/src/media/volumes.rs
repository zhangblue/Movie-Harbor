use super::{ChunkSource, LocalMediaStorage, MediaError, MediaKind, StoredFile, UploadPolicy};
use std::{
    cmp::Reverse,
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

#[derive(Clone)]
pub struct MediaStorageSet {
    volumes: Arc<Vec<MediaVolume>>,
    reserve_bytes: u64,
    reservations: Arc<Mutex<HashMap<i32, u64>>>,
    mutations: Arc<AsyncMutex<()>>,
    capacity: Arc<dyn CapacityProbe>,
}

#[derive(Clone, Debug)]
pub struct MediaVolume {
    volume_id: i32,
    storage: LocalMediaStorage,
}

impl MediaVolume {
    pub fn volume_id(&self) -> i32 {
        self.volume_id
    }

    pub fn storage(&self) -> &LocalMediaStorage {
        &self.storage
    }
}

pub(crate) trait CapacityProbe: Send + Sync {
    fn available_bytes(&self, volume: &MediaVolume) -> Result<u64, MediaError>;
}

struct FilesystemCapacity;

impl CapacityProbe for FilesystemCapacity {
    fn available_bytes(&self, volume: &MediaVolume) -> Result<u64, MediaError> {
        volume.storage.available_bytes()
    }
}

pub struct VolumeStoredFile {
    pub volume_id: i32,
    pub stored: StoredFile,
    _reservation: UploadReservation,
}

// Preserve the lock and hooks when embedding an existing single-volume storage.
impl From<LocalMediaStorage> for MediaStorageSet {
    fn from(storage: LocalMediaStorage) -> Self {
        Self {
            mutations: storage.mutation_lock(),
            volumes: Arc::new(vec![MediaVolume {
                volume_id: 0,
                storage,
            }]),
            reserve_bytes: 0,
            reservations: Arc::new(Mutex::new(HashMap::new())),
            capacity: Arc::new(FilesystemCapacity),
        }
    }
}

impl MediaStorageSet {
    #[allow(clippy::too_many_arguments)]
    pub async fn store<S: ChunkSource + Send>(
        &self,
        required_bytes: u64,
        id: uuid::Uuid,
        kind: MediaKind,
        original_name: &str,
        declared_mime: &str,
        policy: &UploadPolicy,
        source: S,
    ) -> Result<VolumeStoredFile, MediaError> {
        let reservation = self.reserve_for_upload(required_bytes).await?;
        let volume_id = reservation.volume_id();
        let stored = self
            .volume(volume_id)
            .ok_or(MediaError::InvalidStorageConfiguration)?
            .storage()
            .store(id, kind, original_name, declared_mime, policy, source)
            .await?;
        Ok(VolumeStoredFile {
            volume_id,
            stored,
            _reservation: reservation,
        })
    }

    pub async fn initialize(paths: &[PathBuf], reserve_bytes: u64) -> Result<Self, MediaError> {
        let last = paths
            .len()
            .checked_sub(1)
            .ok_or(MediaError::InvalidStorageConfiguration)?;
        checked_volume_id(last)?;
        let mutations = Arc::new(AsyncMutex::new(()));
        let mut roots = HashSet::new();
        let mut volumes = Vec::with_capacity(paths.len());
        for (index, path) in paths.iter().enumerate() {
            let volume_id = checked_volume_id(index)?;
            let canonical = tokio::fs::canonicalize(path).await.map_err(|_| {
                MediaError::VolumeInitialization {
                    volume_id: index,
                    reason: "root unavailable",
                }
            })?;
            if !roots.insert(canonical.clone()) {
                return Err(MediaError::VolumeInitialization {
                    volume_id: index,
                    reason: "duplicate root",
                });
            }
            let storage =
                LocalMediaStorage::initialize_for_volume(&canonical, volume_id, mutations.clone())
                    .await
                    .map_err(|_| MediaError::VolumeInitialization {
                        volume_id: index,
                        reason: "invalid identity or inaccessible storage",
                    })?;
            volumes.push(MediaVolume { volume_id, storage });
        }
        Ok(Self {
            volumes: Arc::new(volumes),
            reserve_bytes,
            reservations: Arc::new(Mutex::new(HashMap::new())),
            mutations,
            capacity: Arc::new(FilesystemCapacity),
        })
    }

    pub fn volumes(&self) -> &[MediaVolume] {
        &self.volumes
    }

    pub fn volume(&self, volume_id: i32) -> Option<&MediaVolume> {
        usize::try_from(volume_id)
            .ok()
            .and_then(|index| self.volumes.get(index))
    }

    /// Acquire once for an operation spanning volumes. Callers must transfer this guard
    /// to storage operations rather than attempting to acquire the same lock again.
    pub(crate) async fn lock_removal(&self) -> Result<OwnedMutexGuard<()>, MediaError> {
        // This only emits the existing lock hook and acquires the shared mutex; it does
        // not access volume 0 files before the caller validates the deletion targets.
        self.volume(0)
            .ok_or(MediaError::InvalidStorageConfiguration)?
            .storage()
            .lock_removal()
            .await
    }

    pub async fn lock_mutations(&self) -> OwnedMutexGuard<()> {
        self.mutations.clone().lock_owned().await
    }

    pub async fn reserve_for_upload(
        &self,
        required_bytes: u64,
    ) -> Result<UploadReservation, MediaError> {
        // Capacity observation and reservation form one atomic decision across all clones.
        // No async suspension occurs while this synchronous mutex is held.
        let mut reservations = self
            .reservations
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let selected = self
            .volumes
            .iter()
            .filter_map(|volume| {
                let reserved = reservations.get(&volume.volume_id).copied().unwrap_or(0);
                let available = self
                    .capacity
                    .available_bytes(volume)
                    .ok()?
                    .checked_sub(self.reserve_bytes)?
                    .checked_sub(reserved)?;
                let total = reserved.checked_add(required_bytes)?;
                (available >= required_bytes).then_some((
                    available,
                    Reverse(volume.volume_id),
                    total,
                ))
            })
            .max_by_key(|(available, id, _)| (*available, *id));
        let (_, Reverse(volume_id), total) = selected.ok_or(MediaError::InsufficientStorage)?;
        reservations.insert(volume_id, total);
        Ok(UploadReservation {
            volume_id,
            reserved_bytes: required_bytes,
            reservations: self.reservations.clone(),
        })
    }
}

fn checked_volume_id(index: usize) -> Result<i32, MediaError> {
    i32::try_from(index).map_err(|_| MediaError::VolumeInitialization {
        volume_id: index,
        reason: "volume number exceeds i32",
    })
}

#[derive(Debug)]
#[must_use = "keep the reservation alive until the upload is resolved"]
pub struct UploadReservation {
    volume_id: i32,
    reserved_bytes: u64,
    reservations: Arc<Mutex<HashMap<i32, u64>>>,
}

impl UploadReservation {
    pub fn volume_id(&self) -> i32 {
        self.volume_id
    }
}

impl Drop for UploadReservation {
    fn drop(&mut self) {
        let mut reservations = self
            .reservations
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(reserved) = reservations.get_mut(&self.volume_id) {
            // Only this non-cloneable handle can release its contribution. If accounting
            // were corrupted, retain capacity conservatively instead of wrapping.
            if let Some(remaining) = reserved.checked_sub(self.reserved_bytes) {
                *reserved = remaining;
                if remaining == 0 {
                    reservations.remove(&self.volume_id);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::MediaError;
    use std::{
        collections::HashMap,
        io,
        path::PathBuf,
        sync::{Arc, Mutex},
    };

    struct OneChunk(Option<axum::body::Bytes>);

    impl ChunkSource for OneChunk {
        fn next_chunk(
            &mut self,
        ) -> std::pin::Pin<
            Box<
                dyn std::future::Future<Output = Result<Option<axum::body::Bytes>, MediaError>>
                    + Send
                    + '_,
            >,
        > {
            Box::pin(async move { Ok(self.0.take()) })
        }
    }

    // Catches releasing or skipping the capacity reservation after promotion but before ownership resolves.
    #[tokio::test]
    async fn stored_file_holds_capacity_until_registration_or_rollback_resolves() {
        use image::ImageEncoder;
        let mut bytes = Vec::new();
        image::codecs::png::PngEncoder::new(&mut bytes)
            .write_image(&[20, 40, 60], 1, 1, image::ExtendedColorType::Rgb8)
            .unwrap();
        let (set, _root) = storage_set(&[(0, Some(200))], 0).await;
        let policy = UploadPolicy::new(1024, ["video/mp4"]).unwrap();
        let stored = set
            .store(
                100,
                uuid::Uuid::new_v4(),
                MediaKind::Poster,
                "poster.png",
                "image/png",
                &policy,
                OneChunk(Some(bytes.into())),
            )
            .await
            .unwrap();
        assert!(matches!(
            set.reserve_for_upload(101).await,
            Err(MediaError::InsufficientStorage)
        ));
        let key = stored.stored.storage_key.clone();
        drop(stored);
        assert!(
            !set.volume(0)
                .unwrap()
                .storage()
                .is_accessible_regular_file(&key)
                .unwrap()
        );
        assert!(set.reserve_for_upload(200).await.is_ok());
        assert!(
            set.store(
                100,
                uuid::Uuid::new_v4(),
                MediaKind::Poster,
                "bad.png",
                "image/png",
                &policy,
                OneChunk(Some(axum::body::Bytes::from_static(b"invalid")))
            )
            .await
            .is_err()
        );
        assert!(set.reserve_for_upload(200).await.is_ok());
    }

    struct ExhaustAtIncomingSync {
        root: PathBuf,
        errno: i32,
    }

    impl super::super::StorageHooks for ExhaustAtIncomingSync {
        fn on_event(&self, event: &super::super::StorageEvent) -> io::Result<()> {
            if let super::super::StorageEvent::FileSynced(name) = event
                && name.ends_with(".part")
            {
                assert!(std::fs::metadata(self.root.join(name)).unwrap().len() > 0);
                return Err(io::Error::from_raw_os_error(self.errno));
            }
            Ok(())
        }
    }

    // Catches ENOSPC/EDQUOT after real file writes being reported as 500, or leaked quota/parts.
    #[tokio::test]
    async fn review_io_exhaustion_maps_507_and_releases_upload() {
        use axum::response::IntoResponse;
        use http_body_util::BodyExt;
        use image::ImageEncoder;
        for errno in [
            rustix::io::Errno::NOSPC.raw_os_error(),
            rustix::io::Errno::DQUOT.raw_os_error(),
        ] {
            let root = TestRoot(
                std::env::temp_dir().join(format!("movie_harbor_full_{}", uuid::Uuid::new_v4())),
            );
            let storage = LocalMediaStorage::initialize_with_hooks(
                &root.0,
                Arc::new(ExhaustAtIncomingSync {
                    root: root.0.clone(),
                    errno,
                }),
            )
            .await
            .unwrap();
            let mut set = MediaStorageSet::from(storage);
            set.capacity = Arc::new(FixedCapacity([(0, Some(200))].into_iter().collect()));
            let mut bytes = Vec::new();
            image::codecs::png::PngEncoder::new(&mut bytes)
                .write_image(&[20, 40, 60], 1, 1, image::ExtendedColorType::Rgb8)
                .unwrap();
            let policy = UploadPolicy::new(1024, ["video/mp4"]).unwrap();
            let error = set
                .store(
                    100,
                    uuid::Uuid::new_v4(),
                    MediaKind::Poster,
                    "image.png",
                    "image/png",
                    &policy,
                    OneChunk(Some(bytes.into())),
                )
                .await
                .err()
                .expect("disk fault must fail upload");
            assert_eq!(
                std::fs::read_dir(root.0.join(".incoming")).unwrap().count(),
                0
            );
            assert!(
                set.reserve_for_upload(200).await.is_ok(),
                "failed upload leaked its reservation"
            );
            let response = error.into_response();
            assert_eq!(
                response.status(),
                axum::http::StatusCode::INSUFFICIENT_STORAGE
            );
            let body: serde_json::Value =
                serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                    .unwrap();
            assert_eq!(
                body,
                serde_json::json!({"error":"media storage is unavailable or full","code":"media_storage_insufficient"})
            );
        }
        assert_eq!(
            MediaError::from(io::Error::from(io::ErrorKind::PermissionDenied))
                .into_response()
                .status(),
            axum::http::StatusCode::INTERNAL_SERVER_ERROR
        );
    }
    struct TestRoot(PathBuf);

    impl Drop for TestRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    struct FixedCapacity(HashMap<i32, Option<u64>>);

    impl CapacityProbe for FixedCapacity {
        fn available_bytes(&self, volume: &MediaVolume) -> Result<u64, MediaError> {
            self.0[&volume.volume_id()]
                .ok_or_else(|| io::Error::other("capacity unavailable").into())
        }
    }

    async fn storage_set(
        capacities: &[(i32, Option<u64>)],
        reserve: u64,
    ) -> (MediaStorageSet, TestRoot) {
        let root = TestRoot(
            std::env::temp_dir().join(format!("movie_harbor_volumes_{}", uuid::Uuid::new_v4())),
        );
        let mut paths = Vec::new();
        for (id, _) in capacities {
            let path = root.0.join(id.to_string());
            std::fs::create_dir_all(&path).unwrap();
            std::fs::write(
                path.join(".movie-harbor-volume.json"),
                format!(r#"{{"version":1,"volume":{id}}}"#),
            )
            .unwrap();
            paths.push(path);
        }
        let mut set = MediaStorageSet::initialize(&paths, reserve).await.unwrap();
        set.capacity = Arc::new(FixedCapacity(capacities.iter().copied().collect()));
        (set, root)
    }

    // Catches choosing by raw space, ignoring in-flight reservations, or breaking ID tie ordering.
    #[tokio::test]
    async fn allocator_selects_the_largest_effective_available_volume() {
        let (set, _root) = storage_set(&[(0, Some(80)), (1, Some(200)), (2, Some(200))], 20).await;
        let first = set.reserve_for_upload(50).await.unwrap();
        assert_eq!(first.volume_id(), 1);
        let second = set.reserve_for_upload(140).await.unwrap();
        assert_eq!(second.volume_id(), 2);
    }

    // Catches skipping the configured reserve, using wrapping subtraction, or accepting an oversize upload.
    #[tokio::test]
    async fn allocator_preserves_safety_space_and_checks_boundaries() {
        let (set, _root) = storage_set(&[(0, Some(19)), (1, Some(80))], 20).await;
        assert!(matches!(
            set.reserve_for_upload(61).await,
            Err(MediaError::InsufficientStorage)
        ));
        let exact = set.reserve_for_upload(60).await.unwrap();
        assert_eq!(exact.volume_id(), 1);
        assert!(matches!(
            set.reserve_for_upload(1).await,
            Err(MediaError::InsufficientStorage)
        ));
        let (below_reserve, _other_root) = storage_set(&[(0, Some(19))], 20).await;
        assert!(matches!(
            below_reserve.reserve_for_upload(0).await,
            Err(MediaError::InsufficientStorage)
        ));
    }

    // Catches failing the entire allocation when one probe fails or treating failure as usable space.
    #[tokio::test]
    async fn allocator_skips_failed_probes_and_reports_no_eligible_volume() {
        let (set, _root) = storage_set(&[(0, None), (1, Some(100))], 0).await;
        let reservation = set.reserve_for_upload(100).await.unwrap();
        assert_eq!(reservation.volume_id(), 1);
        assert!(matches!(
            set.reserve_for_upload(1).await,
            Err(MediaError::InsufficientStorage)
        ));
        let (failed, _other_root) = storage_set(&[(0, None)], 0).await;
        assert!(matches!(
            failed.reserve_for_upload(0).await,
            Err(MediaError::InsufficientStorage)
        ));
    }

    // Catches selecting a volume whose real write/search permissions were revoked after startup,
    // even when that volume reports more free bytes than its healthy peer.
    #[tokio::test]
    async fn allocator_skips_unwritable_volume_despite_larger_reported_capacity() {
        use std::os::unix::fs::PermissionsExt;

        if rustix::process::geteuid().as_raw() == 0 {
            eprintln!("permission-revocation fixture requires an unprivileged API process");
            return;
        }
        struct RealAccessFixedCapacity;
        impl CapacityProbe for RealAccessFixedCapacity {
            fn available_bytes(&self, volume: &MediaVolume) -> Result<u64, MediaError> {
                // Preserve actual filesystem and permission checks; only free-byte quantities
                // are fixed so concurrent host writes cannot make the selection test flaky.
                volume.storage.available_bytes()?;
                Ok(if volume.volume_id == 0 { 200 } else { 100 })
            }
        }
        let (mut set, _root) = storage_set(&[(0, Some(200)), (1, Some(100))], 20).await;
        set.capacity = Arc::new(RealAccessFixedCapacity);
        let path = set.volume(0).unwrap().storage().root();
        let original_permissions = std::fs::metadata(path).unwrap().permissions();
        for mode in [0o500, 0o600] {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
            let selected = set.reserve_for_upload(50).await;
            std::fs::set_permissions(path, original_permissions.clone()).unwrap();
            assert_eq!(selected.unwrap().volume_id(), 1, "permissions: {mode:o}");
            assert_eq!(set.reserve_for_upload(50).await.unwrap().volume_id(), 0);
        }
    }

    // Catches leaked reservations or clearing other uploads' reservations when one handle is dropped.
    #[tokio::test]
    async fn allocator_drop_releases_only_its_own_reservation_across_clones() {
        let (set, _root) = storage_set(&[(0, Some(100))], 20).await;
        let first = set.reserve_for_upload(30).await.unwrap();
        let second = set.clone().reserve_for_upload(50).await.unwrap();
        drop(first);
        assert!(matches!(
            set.reserve_for_upload(31).await,
            Err(MediaError::InsufficientStorage)
        ));
        let replacement = set.reserve_for_upload(30).await.unwrap();
        drop((second, replacement));
        assert!(set.reserve_for_upload(80).await.is_ok());
    }

    // Catches overflow after a full-width reservation, including erroneous accounting for a zero-byte request.
    #[tokio::test]
    async fn allocator_full_width_reservations_do_not_wrap() {
        let (set, _root) = storage_set(&[(0, Some(u64::MAX))], 0).await;
        let full = set.reserve_for_upload(u64::MAX).await.unwrap();
        let zero = set.reserve_for_upload(0).await.unwrap();
        drop(zero);
        assert!(matches!(
            set.reserve_for_upload(1).await,
            Err(MediaError::InsufficientStorage)
        ));
        drop(full);
        assert!(set.reserve_for_upload(u64::MAX).await.is_ok());
    }

    // Catches caching filesystem capacity between requests instead of accounting for external disk usage.
    #[tokio::test]
    async fn allocator_probes_fresh_capacity_for_each_request() {
        struct ChangingCapacity(Arc<Mutex<u64>>);
        impl CapacityProbe for ChangingCapacity {
            fn available_bytes(&self, _: &MediaVolume) -> Result<u64, MediaError> {
                Ok(*self.0.lock().unwrap())
            }
        }
        let (mut set, _root) = storage_set(&[(0, Some(100))], 20).await;
        let capacity = Arc::new(Mutex::new(100));
        set.capacity = Arc::new(ChangingCapacity(capacity.clone()));
        let reservation = set.reserve_for_upload(60).await.unwrap();
        *capacity.lock().unwrap() = 70;
        assert!(matches!(
            set.reserve_for_upload(1).await,
            Err(MediaError::InsufficientStorage)
        ));
        drop(reservation);
        assert!(set.reserve_for_upload(50).await.is_ok());
    }

    // Catches checking capacity outside the reservation lock and oversubscribing under concurrent callers.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn allocator_concurrent_requests_cannot_overbook_capacity() {
        let (set, _root) = storage_set(&[(0, Some(100))], 20).await;
        let barrier = Arc::new(tokio::sync::Barrier::new(8));
        let mut tasks = Vec::new();
        for _ in 0..8 {
            let set = set.clone();
            let barrier = barrier.clone();
            tasks.push(tokio::spawn(async move {
                barrier.wait().await;
                set.reserve_for_upload(50).await
            }));
        }
        let mut held = Vec::new();
        let mut rejected = 0;
        for task in tasks {
            match task.await.unwrap() {
                Ok(reservation) => held.push(reservation),
                Err(MediaError::InsufficientStorage) => rejected += 1,
                Err(error) => panic!("unexpected error: {error}"),
            }
        }
        assert_eq!(held.len(), 1);
        assert_eq!(rejected, 7);
        drop(held);
        assert!(set.reserve_for_upload(80).await.is_ok());
    }
}
