import { cloneElement, useId, type ReactElement, type ReactNode } from "react";

type FieldControlProps = {
  id?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean | "true" | "false";
};

export interface FieldProps {
  label: ReactNode;
  children: ReactElement<FieldControlProps>;
  helpText?: ReactNode;
  error?: ReactNode;
  className?: string;
}

export function Field({ label, children, helpText, error, className }: FieldProps) {
  const generatedId = useId();
  const controlId = children.props.id ?? `${generatedId}-control`;
  const helpId = helpText ? `${generatedId}-help` : undefined;
  const errorId = error ? `${generatedId}-error` : undefined;
  const describedBy = [children.props["aria-describedby"], helpId, errorId].filter(Boolean).join(" ") || undefined;
  const control = cloneElement(children, {
    id: controlId,
    "aria-describedby": describedBy,
    "aria-invalid": error ? "true" : children.props["aria-invalid"],
  });

  return (
    <div className={["mh-field", error && "mh-field--invalid", className].filter(Boolean).join(" ")}>
      <label className="mh-field__label" htmlFor={controlId}>{label}</label>
      {control}
      {helpText ? <div id={helpId} className="mh-field__help">{helpText}</div> : null}
      {error ? <div id={errorId} className="mh-field__error">{error}</div> : null}
    </div>
  );
}
