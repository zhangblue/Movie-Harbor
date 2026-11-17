//! 定义影片助手与 DeepSeek Chat Completions 交换的消息和工具类型。

use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, time::Duration};

// 建立复用的 HTTP 客户端，对单次请求及响应体读取应用超时，并禁止重定向。
pub(super) fn client() -> Result<reqwest::Client, reqwest::Error> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .build()
}

// 汇集当前对话和工具声明，供发往 DeepSeek 的每轮请求序列化。
#[derive(Serialize)]
pub(super) struct Request<'a> {
    model: &'static str,
    messages: &'a [Message],
    tools: &'a [FunctionTool],
    thinking: Thinking,
    max_tokens: u32,
}

impl<'a> Request<'a> {
    // 使用影片助手固定的模型和输出设置构造本轮请求。
    pub(super) fn new(messages: &'a [Message], tools: &'a [FunctionTool]) -> Self {
        Self {
            model: "deepseek-flash",
            messages,
            tools,
            thinking: Thinking {
                kind: ThinkingKind::Disabled,
            },
            max_tokens: 1200,
        }
    }
}

// 表示 DeepSeek 的思考模式开关，按接口约定嵌套序列化。
#[derive(Serialize)]
struct Thinking {
    #[serde(rename = "type")]
    kind: ThinkingKind,
}

// 当前助手仅使用关闭思考模式的请求。
#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
enum ThinkingKind {
    Disabled,
}

// 按角色限定各类消息的字段，工具结果携带对应的调用标识。
#[derive(Serialize)]
#[serde(tag = "role", rename_all = "lowercase")]
pub(super) enum Message {
    System {
        content: &'static str,
    },
    User {
        content: String,
    },
    Assistant {
        #[serde(flatten)]
        reply: AssistantMessage,
    },
    Tool {
        tool_call_id: String,
        // 接口要求 content 是字符串；结构化工具结果先编码一次 JSON。
        content: String,
    },
}

// 接收响应中的候选列表，助手使用首项。
#[derive(Deserialize)]
pub(super) struct Completion {
    pub(super) choices: Vec<Choice>,
}

// 承载一条候选消息，忽略模型返回的统计等附加字段。
#[derive(Deserialize)]
pub(super) struct Choice {
    pub(super) message: AssistantMessage,
}

// 收到的助手消息也可回放给模型；工具调用允许使用 null 正文。
#[derive(Deserialize, Serialize)]
pub(super) struct AssistantMessage {
    pub(super) content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) tool_calls: Option<Vec<ToolCall>>,
}

// 记录模型选择的函数及调用标识，供校验和回放使用。
#[derive(Deserialize, Serialize)]
pub(super) struct ToolCall {
    pub(super) id: String,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    kind: Option<ToolKind>,
    pub(super) function: FunctionCall,
}

// DeepSeek 把函数实参放在 JSON 字符串里，业务调度按工具名进一步解析。
#[derive(Deserialize, Serialize)]
pub(super) struct FunctionCall {
    pub(super) name: String,
    pub(super) arguments: String,
}

// 声明或调用的工具类型，目前只支持函数。
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum ToolKind {
    Function,
}

// 向模型声明可用函数，供请求体的 tools 数组使用。
#[derive(Serialize)]
pub(super) struct FunctionTool {
    #[serde(rename = "type")]
    kind: ToolKind,
    function: FunctionDefinition,
}

impl FunctionTool {
    // 按名称、说明和参数表构造一个严格的函数声明。
    fn new(
        name: &'static str,
        description: &'static str,
        properties: impl IntoIterator<Item = (&'static str, Property)>,
        required: &'static [&'static str],
    ) -> Self {
        Self {
            kind: ToolKind::Function,
            function: FunctionDefinition {
                name,
                description,
                parameters: Parameters {
                    kind: SchemaKind::Object,
                    properties: properties.into_iter().collect(),
                    required,
                    additional_properties: false,
                },
            },
        }
    }
}

// 承载 DeepSeek 函数声明的名称、提示和参数定义。
#[derive(Serialize)]
struct FunctionDefinition {
    name: &'static str,
    description: &'static str,
    parameters: Parameters,
}

// 参数必须是对象，允许的属性和必填项由每个工具单独声明。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Parameters {
    #[serde(rename = "type")]
    kind: SchemaKind,
    properties: BTreeMap<&'static str, Property>,
    #[serde(skip_serializing_if = "<[_]>::is_empty")]
    required: &'static [&'static str],
    additional_properties: bool,
}

// 函数参数结构使用 JSON Schema 的 object 类型。
#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
enum SchemaKind {
    Object,
}

// 描述本助手工具用到的参数类型、格式和取值限制。
#[derive(Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Property {
    String {
        #[serde(rename = "enum", skip_serializing_if = "Option::is_none")]
        allowed: Option<&'static [&'static str]>,
        #[serde(skip_serializing_if = "Option::is_none")]
        format: Option<&'static str>,
    },
    Integer {
        minimum: u64,
        maximum: u64,
    },
    Boolean,
}

impl Property {
    // 构建自由文本、枚举或带格式的字符串参数。
    fn string(allowed: Option<&'static [&'static str]>, format: Option<&'static str>) -> Self {
        Self::String { allowed, format }
    }
}

// 当前轮次可外发的片名，保留空数组以区分零匹配和未查询的访问范围。
#[derive(Serialize)]
pub(super) struct NameLists {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) public: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) private: Option<Vec<String>>,
}

// 限定可回传上游的工具结果，站内详情和错误原因不进入此消息。
#[derive(Serialize)]
#[serde(untagged)]
pub(super) enum ToolOutput {
    Names(NameLists),
    Invalid { error: &'static str },
}

// 根据会话角色声明模型可用的工具。后端仍须校验模型提交的参数和权限。
pub(super) fn tools(is_admin: bool) -> Vec<FunctionTool> {
    let text = || Property::string(None, None);
    let kind = || Property::string(Some(&["movie", "series"]), None);
    let id = || Property::string(None, Some("uuid"));
    let mut tools = vec![
        FunctionTool::new(
            "search_content",
            "按片名查找当前账号可见的电影与剧集。只问有没有某部片时使用。",
            [("name", text())],
            &["name"],
        ),
        FunctionTool::new(
            "list_content",
            "列出当前账号可见的已发布电影和剧集，每页20条。用户要看私密片单或问有哪些私密影片时，必须设置 private_only 为 true。翻页沿用上一页筛选。",
            [
                ("kind", kind()),
                (
                    "page",
                    Property::Integer {
                        minimum: 1,
                        maximum: 1_000_000,
                    },
                ),
                ("private_only", Property::Boolean),
            ],
            &[],
        ),
        FunctionTool::new(
            "list_content_names",
            "查询已发布的电影或剧集名称。用户明确问名称名单或数量时使用，工具只返回匹配的名称数组，需要数量时由你按数组元素计数，每个元素对应一部作品。privacy 指定 public 或 private，省略或用 all 返回两组名称；kind 省略时包含电影和剧集。",
            [
                ("kind", kind()),
                (
                    "privacy",
                    Property::string(Some(&["public", "private", "all"]), None),
                ),
            ],
            &[],
        ),
        FunctionTool::new(
            "series_counts",
            "按用户给出的剧名直接查询季数、总集数和每季已发布集数。若已知标识也可提供 id。name 与 id 二选一。",
            [("name", text()), ("id", id())],
            &[],
        ),
        FunctionTool::new(
            "content_details",
            "按用户给出的片名直接查询详情。kind 不明确时同时查电影和剧集。name 与 id 二选一；使用 id 时必须指定 kind。",
            [("kind", kind()), ("name", text()), ("id", id())],
            &[],
        ),
    ];
    if is_admin {
        tools.push(FunctionTool::new(
            "propose_draft",
            "用户明确要求新建时，提出一条待管理员确认的草稿。",
            [("kind", kind()), ("name", text())],
            &["kind", "name"],
        ));
    }
    tools
}
