use uuid::Uuid;

// 解析路由 UUID 并保留调用方错误语义，供领域路由处理参数时调用。
pub fn parse_uuid<E>(value: String, error: E) -> Result<Uuid, E> {
    // 调用方提供领域错误，公共解析器不会抹平各路由的错误语义。
    value.parse().map_err(|_| error)
}
