//! 视频提升前预留隔离目录项，回滚或恢复时依据同一份持久凭证验证身份。
use super::*;
use rustix::fs::{linkat, renameat};

/// 初始化期间以实际上传使用的两个目录描述符探测硬链接，结束时持久化两侧清理。
pub(super) fn probe_hard_links(
    incoming: &OwnedFd,
    quarantine: &OwnedFd,
    hooks: &Arc<dyn StorageHooks>,
) -> io::Result<()> {
    let name = format!(".hard-link-probe-{}", Uuid::new_v4().simple());
    let name = name.as_str();
    let source = openat(
        incoming,
        name,
        OFlags::CREATE | OFlags::EXCL | OFlags::RDWR | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        file_mode(),
    )?;
    let mut linked = false;
    let probe = (|| -> io::Result<()> {
        sync_fd(&source)?;
        hooks.on_event(&StorageEvent::FileSynced(format!(".incoming/{name}")))?;
        linkat(incoming, name, quarantine, name, AtFlags::empty())?;
        linked = true;
        let src = rustix::fs::fstat(&source)?;
        let dst = statat(quarantine, name, AtFlags::SYMLINK_NOFOLLOW)?;
        if (src.st_dev, src.st_ino) != (dst.st_dev, dst.st_ino) {
            return Err(io::Error::other("hard-link identity mismatch"));
        }
        sync_fd(quarantine)?;
        hooks.on_event(&StorageEvent::DirectorySynced(".quarantine".into()))
    })();
    // 两侧都尝试清理并同步。链接碰撞不取得目标所有权，未知身份的同名条目保持原样。
    let clean = |dir: &OwnedFd| -> io::Result<()> {
        let named = statat(dir, name, AtFlags::SYMLINK_NOFOLLOW)?;
        let held = rustix::fs::fstat(&source)?;
        if (named.st_dev, named.st_ino) != (held.st_dev, held.st_ino) {
            return Err(io::Error::other("hard-link probe name changed"));
        }
        unlinkat(dir, name, AtFlags::empty())?;
        sync_fd(dir)
    };
    let target_cleanup = if linked { clean(quarantine) } else { Ok(()) };
    let source_cleanup = clean(incoming);
    target_cleanup.and(source_cleanup).and(probe)
}

/// 从已经校验的 pending 名取得对应私有隔离名称。
fn hold_name(marker_name: &str) -> Result<String, MediaError> {
    marker_name
        .strip_suffix(".pending")
        .filter(|stem| valid_claim_base(stem))
        .map(|stem| format!("{stem}.hold"))
        .ok_or(MediaError::InvalidStorageKey)
}

/// 发布视频前预留隔离目录项，硬链接身份可在启动时确定该项仍处于预备阶段。
pub(super) fn reserve(
    incoming: &OwnedFd,
    quarantine: &OwnedFd,
    marker_name: &str,
) -> Result<(), MediaError> {
    linkat(
        incoming,
        marker_name,
        quarantine,
        hold_name(marker_name)?.as_str(),
        AtFlags::empty(),
    )
    .map_err(io::Error::from)?;
    sync_fd(quarantine)?;
    Ok(())
}

/// 打开无跟随且非阻塞的私有条目，只把名称缺失视作可恢复的空状态。
fn open_optional(parent: &OwnedFd, name: &str) -> Result<Option<std::fs::File>, MediaError> {
    match openat(
        parent,
        name,
        OFlags::RDONLY | OFlags::NONBLOCK | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    ) {
        Ok(fd) => Ok(Some(fd.into())),
        Err(rustix::io::Errno::NOENT) => Ok(None),
        Err(err) => Err(io::Error::from(err).into()),
    }
}

/// 在删除预备目录项前，核对它仍然是 pending 文件的同一 inode。
fn is_reservation(
    incoming: &OwnedFd,
    name: &str,
    hold: &std::fs::File,
) -> Result<bool, MediaError> {
    let marker = statat(incoming, name, AtFlags::SYMLINK_NOFOLLOW).map_err(io::Error::from)?;
    let held = rustix::fs::fstat(hold).map_err(io::Error::from)?;
    Ok(
        rustix::fs::FileType::from_raw_mode(marker.st_mode) == rustix::fs::FileType::RegularFile
            && marker.st_dev == held.st_dev
            && marker.st_ino == held.st_ino,
    )
}

/// 正常提交或准备失败时释放预留位置；未知身份的文件保留待处理。
pub(super) fn release_reservation(
    incoming: &OwnedFd,
    quarantine: &OwnedFd,
    name: &str,
) -> Result<(), MediaError> {
    let target = hold_name(name)?;
    if let Some(file) = open_optional(quarantine, &target)? {
        if !is_reservation(incoming, name, &file)? {
            return Err(MediaError::InvalidStorageKey);
        }
        remove_if_present(quarantine, &target)?;
        sync_fd(quarantine)?;
    }
    Ok(())
}

/// 核对凭证内容；只有只读保留已登记正式文件时允许从备份复制导致的 inode 改变。
fn matches_video(
    marker: &PendingMarker,
    file: &mut std::fs::File,
    keep_registered_formal: bool,
) -> Result<bool, MediaError> {
    let stat = rustix::fs::fstat(&*file).map_err(io::Error::from)?;
    Ok(
        rustix::fs::FileType::from_raw_mode(stat.st_mode) == rustix::fs::FileType::RegularFile
            && (keep_registered_formal
                || (stat.st_dev as u64 == marker.device && stat.st_ino as u64 == marker.inode))
            && stat.st_size as u64 == marker.byte_size
            && hash_opened_file(file)? == marker.checksum_sha256,
    )
}

/// 从隔离目录恢复正式名后同步源和目标目录；重试即使只剩正式名也要完成两侧同步。
fn sync_restored_directories(
    leaf: &OwnedFd,
    quarantine: &OwnedFd,
    key: &str,
    hooks: &Arc<dyn StorageHooks>,
) -> Result<(), MediaError> {
    let (directory, _) = key.rsplit_once('/').ok_or(MediaError::InvalidStorageKey)?;
    for (fd, label) in [(leaf, directory), (quarantine, ".quarantine")] {
        hooks.on_event(&StorageEvent::BeforeDirectorySync(label.to_owned()))?;
        sync_fd(fd)?;
        hooks.on_event(&StorageEvent::DirectorySynced(label.to_owned()))?;
    }
    Ok(())
}

/// 在已知回滚或数据库恢复阶段处理准备和隔离两种状态，拒绝对未知文件执行删除。
pub(super) fn resolve(
    incoming: &OwnedFd,
    quarantine: &OwnedFd,
    leaf: &OwnedFd,
    marker: &PendingMarker,
    registered: bool,
    hooks: &Arc<dyn StorageHooks>,
) -> Result<(), MediaError> {
    let (_, _, file_name) = parse_storage_key(&marker.storage_key)?;
    let stem = file_name
        .split_once('.')
        .ok_or(MediaError::InvalidStorageKey)?
        .0;
    let name = format!("{stem}.pending");
    let target = hold_name(&name)?;
    let Some(mut held) = open_optional(quarantine, &target)? else {
        // 清理完成但凭证尚未删除，或准备尚未建立；有未登记正式文件时保留证据。
        return match open_optional(leaf, file_name)? {
            None if !registered => {
                sync_fd(leaf)?;
                sync_fd(quarantine)?;
                Ok(())
            }
            Some(mut formal) if registered => {
                if matches_video(marker, &mut formal, true)? {
                    sync_restored_directories(leaf, quarantine, &marker.storage_key, hooks)
                } else {
                    Err(MediaError::InvalidStorageKey)
                }
            }
            _ => Err(MediaError::InvalidStorageKey),
        };
    };
    if is_reservation(incoming, &name, &held)? {
        let Some(mut original) = open_optional(leaf, file_name)? else {
            return if registered {
                Err(MediaError::InvalidStorageKey)
            } else {
                release_reservation(incoming, quarantine, &name)
            };
        };
        if !matches_video(marker, &mut original, registered)? {
            return Err(MediaError::InvalidStorageKey);
        }
        if registered {
            // 只读保留正式文件。先同步卷上两侧，再删除仍与凭证同 inode 的预留链接。
            sync_restored_directories(leaf, quarantine, &marker.storage_key, hooks)?;
            return release_reservation(incoming, quarantine, &name);
        }
        // 原子覆盖自己预留的隔离项；持有原文件描述符跨越移动，避免 inode 被复用。
        hooks.on_event(&StorageEvent::BeforeUnlink(marker.storage_key.clone()))?;
        // 私有隔离目录由本实例在变更锁下管理，移动前再次确认预留名称仍绑定本凭证。
        let reservation =
            open_optional(quarantine, &target)?.ok_or(MediaError::InvalidStorageKey)?;
        if !is_reservation(incoming, &name, &reservation)? {
            return Err(MediaError::InvalidStorageKey);
        }
        renameat(leaf, file_name, quarantine, target.as_str()).map_err(io::Error::from)?;
        held = open_optional(quarantine, &target)?.ok_or(MediaError::InvalidStorageKey)?;
        if !matches_video(marker, &mut held, false)? {
            // 名称被替换时只尝试原子放回，不覆盖同名正式项、不删除捕获的替代文件。
            renameat_with(
                quarantine,
                target.as_str(),
                leaf,
                file_name,
                RenameFlags::NOREPLACE,
            )
            .map_err(io::Error::from)?;
            sync_fd(leaf)?;
            sync_fd(quarantine)?;
            return Err(MediaError::InvalidStorageKey);
        }
    } else if !matches_video(marker, &mut held, false)? {
        return Err(MediaError::InvalidStorageKey);
    }
    // 先持久化隔离状态，再按数据库决策恢复已登记文件或删除确定未登记的视频。
    sync_fd(leaf)?;
    sync_fd(quarantine)?;
    if registered {
        renameat_with(
            quarantine,
            target.as_str(),
            leaf,
            file_name,
            RenameFlags::NOREPLACE,
        )
        .map_err(io::Error::from)?;
        return sync_restored_directories(leaf, quarantine, &marker.storage_key, hooks);
    }
    remove_if_present(quarantine, &target)?;
    hooks.on_event(&StorageEvent::Unlinked(marker.storage_key.clone()))?;
    sync_fd(quarantine)?;
    Ok(())
}
