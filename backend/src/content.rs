use chrono::{DateTime, FixedOffset};
use serde::{Deserialize, Deserializer};
use std::collections::HashSet;
use uuid::Uuid;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ContentRuleError {
    Invalid,
    Conflict,
}

#[derive(Debug, Default)]
pub enum Patch<T> {
    #[default]
    Missing,
    Null,
    Value(T),
}

impl<'de, T> Deserialize<'de> for Patch<T>
where
    T: Deserialize<'de>,
{
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        // Patch 保留“未提交、显式清空、设置新值”三种状态，避免部分更新误删已有字段。
        Option::<T>::deserialize(deserializer).map(|value| match value {
            Some(value) => Self::Value(value),
            None => Self::Null,
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TargetState {
    Draft,
    Published,
    Archived,
}

pub fn normalize_required(value: String) -> Result<String, ContentRuleError> {
    let value = value.trim();
    if value.is_empty() {
        Err(ContentRuleError::Invalid)
    } else {
        Ok(value.to_owned())
    }
}

pub fn require_positive_i64(value: i64) -> Result<(), ContentRuleError> {
    (value > 0).then_some(()).ok_or(ContentRuleError::Invalid)
}

pub fn require_positive_i32(value: i32) -> Result<(), ContentRuleError> {
    (value > 0).then_some(()).ok_or(ContentRuleError::Invalid)
}

pub fn require_version(actual: i64, expected: i64) -> Result<(), ContentRuleError> {
    (actual == expected)
        .then_some(())
        .ok_or(ContentRuleError::Conflict)
}

pub fn parse_unique_uuids(values: Vec<String>) -> Result<Vec<Uuid>, ContentRuleError> {
    let values = values
        .into_iter()
        .map(|value| value.parse().map_err(|_| ContentRuleError::Invalid))
        .collect::<Result<Vec<_>, _>>()?;
    if values.iter().copied().collect::<HashSet<_>>().len() != values.len() {
        // 关联表原子替换前拒绝重复 ID，避免校验通过后产生重复关系。
        return Err(ContentRuleError::Invalid);
    }
    Ok(values)
}

pub fn apply_text(
    current: &mut String,
    patch: Patch<String>,
    nonblank: bool,
) -> Result<(), ContentRuleError> {
    match patch {
        Patch::Missing => Ok(()),
        Patch::Null => Err(ContentRuleError::Invalid),
        Patch::Value(value) => {
            let value = value.trim();
            if nonblank && value.is_empty() {
                return Err(ContentRuleError::Invalid);
            }
            *current = value.to_owned();
            Ok(())
        }
    }
}

pub fn apply_optional_i32(
    current: &mut Option<i32>,
    patch: Patch<i32>,
    nonnegative: bool,
) -> Result<(), ContentRuleError> {
    match patch {
        Patch::Missing => Ok(()),
        Patch::Null => {
            *current = None;
            Ok(())
        }
        Patch::Value(value) if !nonnegative || value >= 0 => {
            *current = Some(value);
            Ok(())
        }
        Patch::Value(_) => Err(ContentRuleError::Invalid),
    }
}

pub fn parse_target(value: &str) -> Result<TargetState, ContentRuleError> {
    match value {
        "draft" => Ok(TargetState::Draft),
        "published" => Ok(TargetState::Published),
        "archived" => Ok(TargetState::Archived),
        _ => Err(ContentRuleError::Invalid),
    }
}

pub fn ensure_transition(current: &str, target: TargetState) -> Result<(), ContentRuleError> {
    // 生命周期转换由后端统一维护，避免客户端绕过发布和归档约束。
    matches!(
        (current, target),
        ("draft", TargetState::Published)
            | ("published", TargetState::Archived)
            | ("archived", TargetState::Published)
            | ("archived", TargetState::Draft)
    )
    .then_some(())
    .ok_or(ContentRuleError::Conflict)
}

pub fn apply_target_state(
    status: &mut String,
    published_at: &mut Option<DateTime<FixedOffset>>,
    archived_at: &mut Option<DateTime<FixedOffset>>,
    target: TargetState,
    now: DateTime<FixedOffset>,
) {
    // 幂等地应用目标状态与时间戳，避免重试改写首次发布日期。
    match target {
        TargetState::Draft => {
            *status = "draft".into();
            *published_at = None;
            *archived_at = None;
        }
        TargetState::Published => {
            *status = "published".into();
            if published_at.is_none() {
                *published_at = Some(now);
            }
            *archived_at = None;
        }
        TargetState::Archived => {
            *status = "archived".into();
            *archived_at = Some(now);
        }
    }
}

impl TargetState {
    pub fn matches(self, current: &str) -> bool {
        matches!(
            (self, current),
            (Self::Draft, "draft") | (Self::Published, "published") | (Self::Archived, "archived")
        )
    }
}
