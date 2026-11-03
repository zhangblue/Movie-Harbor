use chrono::{DateTime, FixedOffset};
use serde::{Deserialize, Deserializer};
use std::collections::HashSet;
use uuid::Uuid;

// 表示内容字段或生命周期规则失败，供内容服务映射领域错误。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ContentRuleError {
    Invalid,
    Conflict,
}

// 区分部分更新的缺失、清空和值，供内容更新请求反序列化使用。
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
    // 读取显式空值或新值，供部分更新请求反序列化时调用。
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

// 表示允许请求的目标生命周期状态，供状态转换服务使用。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TargetState {
    Draft,
    Published,
    Archived,
}

// 去除空白并拒绝空值，供内容必填文本保存前校验。
pub fn normalize_required(value: String) -> Result<String, ContentRuleError> {
    let value = value.trim();
    if value.is_empty() {
        Err(ContentRuleError::Invalid)
    } else {
        Ok(value.to_owned())
    }
}

// 要求长整数字段大于零，供内容字段校验调用。
pub fn require_positive_i64(value: i64) -> Result<(), ContentRuleError> {
    (value > 0).then_some(()).ok_or(ContentRuleError::Invalid)
}

// 要求整数字段大于零，供内容字段校验调用。
pub fn require_positive_i32(value: i32) -> Result<(), ContentRuleError> {
    (value > 0).then_some(()).ok_or(ContentRuleError::Invalid)
}

// 校验版本一致性，供并发更新写入前调用。
pub fn require_version(actual: i64, expected: i64) -> Result<(), ContentRuleError> {
    (actual == expected)
        .then_some(())
        .ok_or(ContentRuleError::Conflict)
}

// 解析并去重校验关联标识，供内容关联写入前调用。
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

// 按部分更新语义应用文本，供内容字段更新时调用。
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

// 按部分更新语义应用可选整数，供内容字段更新时调用。
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

// 解析目标状态名称，供生命周期转换请求校验时调用。
pub fn parse_target(value: &str) -> Result<TargetState, ContentRuleError> {
    match value {
        "draft" => Ok(TargetState::Draft),
        "published" => Ok(TargetState::Published),
        "archived" => Ok(TargetState::Archived),
        _ => Err(ContentRuleError::Invalid),
    }
}

// 校验当前状态到目标状态的转换，供状态更新前调用。
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

// 写入目标状态及对应时间戳，供已校验的生命周期转换调用。
pub fn apply_target_state(
    status: &mut String,
    published_at: &mut Option<DateTime<FixedOffset>>,
    archived_at: &mut Option<DateTime<FixedOffset>>,
    target: TargetState,
    now: DateTime<FixedOffset>,
) {
    // 本函数仅负责实际状态与时间戳写入；幂等短路由调用方进入前完成，首次发布时间只在缺失时写入。
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
    // 判断目标与当前状态是否相同，供转换前的幂等判断调用。
    pub fn matches(self, current: &str) -> bool {
        matches!(
            (self, current),
            (Self::Draft, "draft") | (Self::Published, "published") | (Self::Archived, "archived")
        )
    }
}
