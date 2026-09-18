use uuid::Uuid;

pub fn parse_uuid<E>(value: String, error: E) -> Result<Uuid, E> {
    // 调用方提供领域错误，公共解析器不会抹平各路由的错误语义。
    value.parse().map_err(|_| error)
}
