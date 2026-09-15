use chrono::{TimeZone, Utc};
use movie_harbor_api::content::{
    ContentRuleError, Patch, TargetState, apply_optional_i32, apply_target_state, apply_text,
    ensure_transition, normalize_required, parse_target, parse_unique_uuids, require_positive_i32,
    require_positive_i64, require_version,
};

#[test]
fn normalizes_shared_content_fields() {
    assert_eq!(normalize_required("  片名  ".into()).unwrap(), "片名");
    assert_eq!(
        normalize_required("  ".into()),
        Err(ContentRuleError::Invalid)
    );
    assert_eq!(require_positive_i64(1), Ok(()));
    assert_eq!(require_positive_i64(0), Err(ContentRuleError::Invalid));
    assert_eq!(require_positive_i32(2), Ok(()));
    assert_eq!(require_version(4, 4), Ok(()));
    assert_eq!(require_version(4, 3), Err(ContentRuleError::Conflict));
}

#[test]
fn parses_only_unique_uuid_lists() {
    let first = "00000000-0000-0000-0000-000000000001".to_string();
    let second = "00000000-0000-0000-0000-000000000002".to_string();
    assert_eq!(
        parse_unique_uuids(vec![first.clone(), second])
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        parse_unique_uuids(vec![first.clone(), first]),
        Err(ContentRuleError::Invalid)
    );
    assert_eq!(
        parse_unique_uuids(vec!["bad".into()]),
        Err(ContentRuleError::Invalid)
    );
}

#[test]
fn applies_patch_and_lifecycle_rules() {
    let mut text = "old".to_string();
    apply_text(&mut text, Patch::Value(" next ".into()), true).unwrap();
    assert_eq!(text, "next");
    assert_eq!(
        apply_text(&mut text, Patch::Null, true),
        Err(ContentRuleError::Invalid)
    );
    apply_text(&mut text, Patch::Missing, true).unwrap();
    assert_eq!(text, "next");

    let mut number = Some(2);
    apply_optional_i32(&mut number, Patch::Null, true).unwrap();
    assert_eq!(number, None);
    apply_optional_i32(&mut number, Patch::Value(0), true).unwrap();
    assert_eq!(number, Some(0));
    assert_eq!(
        apply_optional_i32(&mut number, Patch::Value(-1), true),
        Err(ContentRuleError::Invalid)
    );
    apply_optional_i32(&mut number, Patch::Missing, true).unwrap();
    assert_eq!(number, Some(0));

    let published = parse_target("published").unwrap();
    assert_eq!(published, TargetState::Published);
    assert!(published.matches("published"));
    assert_eq!(ensure_transition("draft", published), Ok(()));
    assert_eq!(
        ensure_transition("published", TargetState::Draft),
        Err(ContentRuleError::Conflict)
    );

    let now = Utc
        .with_ymd_and_hms(2026, 9, 15, 12, 0, 0)
        .unwrap()
        .fixed_offset();
    let mut status = "draft".to_string();
    let mut published_at = None;
    let mut archived_at = None;
    apply_target_state(
        &mut status,
        &mut published_at,
        &mut archived_at,
        published,
        now,
    );
    assert_eq!(status, "published");
    assert_eq!(published_at, Some(now));
    assert_eq!(archived_at, None);

    apply_target_state(
        &mut status,
        &mut published_at,
        &mut archived_at,
        TargetState::Archived,
        now,
    );
    apply_target_state(
        &mut status,
        &mut published_at,
        &mut archived_at,
        TargetState::Draft,
        now,
    );
    assert_eq!(status, "draft");
    assert_eq!(published_at, None);
    assert_eq!(archived_at, None);
}
