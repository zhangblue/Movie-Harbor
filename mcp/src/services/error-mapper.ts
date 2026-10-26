const messages = {
  auth_required: '认证失败，请检查 MCP 凭据',
  forbidden: '当前凭据无权执行此操作',
  not_found: '请求的内容不存在',
  version_conflict: '内容版本已变化，请重新读取后重试',
  payload_too_large: '上传文件超过大小限制',
  unsupported_media: '不支持此媒体格式',
  validation_error: '请求内容未通过校验',
  rate_limited: '请求过于频繁，请稍后重试',
  server_error: '服务端处理失败，请稍后重试',
  http_error: '服务端拒绝了请求',
  network_error: '连接中断或请求已取消',
  timeout: '请求超时，请检查服务连接',
  invalid_response: '服务端返回的数据格式无效',
  response_too_large: '服务端响应超过大小限制',
  invalid_path: '请求路径必须位于受控管理接口内',
  file_changed: '文件已经变化或不可读取，请重新检查',
} as const;
export type ClientErrorCode = keyof typeof messages;

export class MovieHarborClientError extends Error {
  readonly fields: string[];
  constructor(readonly code: ClientErrorCode, readonly status?: number, fields: string[] = []) {
    super(messages[code]);
    this.name = 'MovieHarborClientError';
    this.fields = fields;
  }
}

export function mapHttpError(status: number, payload: unknown, apiKey: string): MovieHarborClientError {
  const codes: Record<number, ClientErrorCode> = {
    401: 'auth_required', 403: 'forbidden', 404: 'not_found', 409: 'version_conflict',
    413: 'payload_too_large', 415: 'unsupported_media', 422: 'validation_error', 429: 'rate_limited',
  };
  const value = payload && typeof payload === 'object' ? (payload as { fields?: unknown }).fields : undefined;
  const fields = Array.isArray(value) && value.length <= 32 && value.every(field =>
    typeof field === 'string' && field.length <= 64 && !field.includes(apiKey)
      && !/authorization|bearer|[\r\n\0]/i.test(field)) ? value as string[] : [];
  return new MovieHarborClientError(codes[status] ?? (status >= 500 && status <= 599 ? 'server_error' : 'http_error'), status, fields);
}
