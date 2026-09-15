type ValidationFieldListProps = {
  fields: string[];
  labels: Record<string, string>;
  role?: "alert" | undefined;
};

export function ValidationFieldList(props: ValidationFieldListProps) {
  if (props.fields.length === 0) return null;
  const role = "role" in props ? props.role : "alert";
  return <div role={role} className="error-message">
    <p>请检查以下缺失项或错误字段：</p>
    <ul>{props.fields.map((field) => <li key={field}>{props.labels[field] ?? field}</li>)}</ul>
  </div>;
}
