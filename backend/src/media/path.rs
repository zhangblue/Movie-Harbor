pub(crate) fn controlled_media_url(storage_key: &str, expected_kind: &str) -> Option<String> {
    controlled_storage_key(storage_key, expected_kind).then(|| format!("/media/{storage_key}"))
}

pub(crate) fn controlled_media_path(storage_key: &str, expected_kind: &str) -> Option<String> {
    controlled_storage_key(storage_key, expected_kind).then(|| format!("/media/{storage_key}"))
}

fn controlled_storage_key(key: &str, expected_kind: &str) -> bool {
    if key.contains(['\\', '\0']) {
        return false;
    }
    let mut parts = key.split('/');
    let (Some(kind), Some(shard), Some(file), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return false;
    };
    if kind != expected_kind || !matches!(kind, "poster" | "video") {
        return false;
    }
    let Some((stem, extension)) = file.rsplit_once('.') else {
        return false;
    };
    let lowercase_hex = |value: &str, length: usize| {
        value.len() == length
            && value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    };
    let extension_allowed = match kind {
        "poster" => matches!(extension, "jpg" | "png" | "webp"),
        "video" => matches!(extension, "mp4" | "webm" | "ogv"),
        _ => false,
    };
    lowercase_hex(shard, 2)
        && lowercase_hex(stem, 32)
        && stem.starts_with(shard)
        && extension_allowed
}

#[cfg(test)]
mod tests {
    use super::{controlled_media_path, controlled_media_url};

    #[test]
    fn builds_public_urls_and_container_paths_through_separate_boundaries() {
        let storage_key = "video/ab/ab000000000000000000000000000001.mp4";
        assert_eq!(
            controlled_media_url(storage_key, "video"),
            Some("/media/video/ab/ab000000000000000000000000000001.mp4".into())
        );
        assert_eq!(
            controlled_media_path(storage_key, "video"),
            Some("/media/video/ab/ab000000000000000000000000000001.mp4".into())
        );
    }
}
