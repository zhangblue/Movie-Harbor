use super::{
    LocalMediaStorage, MediaError,
    storage::{RemovalOperation, RemovalSource},
};
use serde::{Deserialize, Serialize};
use tokio::sync::OwnedMutexGuard;
use uuid::Uuid;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct OwnedMedia {
    pub asset_id: Uuid,
    pub storage_key: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct Manifest {
    version: u8,
    operation_id: Uuid,
    reason: String,
    entries: Vec<ManifestEntry>,
}

#[derive(Debug, Serialize, Deserialize)]
struct ManifestEntry {
    asset_id: Uuid,
    storage_key: String,
    staged_name: String,
}

struct StagedEntry {
    source: RemovalSource,
    staged_name: String,
}

pub struct StagedRemoval {
    storage: LocalMediaStorage,
    _operation_id: Uuid,
    operation: RemovalOperation,
    entries: Vec<StagedEntry>,
    _guard: OwnedMutexGuard<()>,
}

impl StagedRemoval {
    pub async fn restore(self) -> Result<(), MediaError> {
        for entry in self.entries.iter().rev() {
            self.storage.restore_removal_source(
                &self.operation,
                &entry.source,
                &entry.staged_name,
            )?;
        }
        self.storage.close_removal_operation(&self.operation)
    }

    pub async fn finish(self) -> Result<(), MediaError> {
        for entry in &self.entries {
            self.storage
                .finish_removal_source(&self.operation, &entry.staged_name)?;
        }
        self.storage.close_removal_operation(&self.operation)
    }
}

pub async fn stage(
    storage: &LocalMediaStorage,
    reason: &str,
    assets: &[OwnedMedia],
) -> Result<StagedRemoval, MediaError> {
    let guard = storage.lock_removal().await;
    let mut prepared = Vec::new();
    for asset in assets {
        if let Some(source) = storage.prepare_removal(&asset.storage_key)? {
            prepared.push((asset, source));
        }
    }

    let operation_id = Uuid::new_v4();
    let manifest = Manifest {
        version: 1,
        operation_id,
        reason: reason.to_owned(),
        entries: prepared
            .iter()
            .enumerate()
            .map(|(index, (asset, _))| ManifestEntry {
                asset_id: asset.asset_id,
                storage_key: asset.storage_key.clone(),
                staged_name: format!("{index:08}.data"),
            })
            .collect(),
    };
    let encoded = serde_json::to_vec(&manifest).map_err(std::io::Error::other)?;
    let operation = storage.create_removal_operation(operation_id, &encoded)?;
    let mut entries: Vec<StagedEntry> = Vec::new();
    for ((_, source), manifest_entry) in prepared.into_iter().zip(&manifest.entries) {
        entries.push(StagedEntry {
            source,
            staged_name: manifest_entry.staged_name.clone(),
        });
        let current = entries
            .last()
            .expect("the current removal entry was pushed");
        if let Err(error) =
            storage.stage_removal_source(&operation, &current.source, &current.staged_name)
        {
            for entry in entries.iter().rev() {
                storage.restore_removal_source(&operation, &entry.source, &entry.staged_name)?;
            }
            storage.close_removal_operation(&operation)?;
            return Err(error);
        }
    }
    Ok(StagedRemoval {
        storage: storage.clone(),
        _operation_id: operation_id,
        operation,
        entries,
        _guard: guard,
    })
}
