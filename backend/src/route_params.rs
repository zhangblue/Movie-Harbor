use uuid::Uuid;

pub fn parse_uuid<E>(value: String, error: E) -> Result<Uuid, E> {
    value.parse().map_err(|_| error)
}
