// 定义校验字段列表的输入，在展示发布错误时使用。
type ValidationFieldListProps = {
  fields: string[];
  labels: Record<string, string>;
  role?: "alert" | undefined;
};

// 展示已知及未知校验字段，在发布失败时使用。
export function ValidationFieldList(props: ValidationFieldListProps) {
  if (props.fields.length === 0) return null;
  const role = "role" in props ? props.role : "alert";
  return <div role={role} className="error-message">
    <p>请检查以下缺失项或错误字段：</p>
    <ul>{props.fields.map((field) => <li key={field}>{props.labels[field] ?? field}</li>)}</ul>
  </div>;
}
