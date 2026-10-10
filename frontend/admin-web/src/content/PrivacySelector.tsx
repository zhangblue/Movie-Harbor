import { useId } from "react";

export function PrivacySelector({ value, onChange, disabled = false, series = false }: {
  value: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  series?: boolean;
}) {
  const name = useId();
  return <fieldset className={`privacy-selector movie-field-wide${series ? " series-privacy-selector" : ""}`} disabled={disabled}>
    <legend>访问范围</legend>
    <label><input type="radio" name={name} value="public" checked={!value} onChange={() => onChange(false)} /><span><strong>公开</strong><small>无需登录即可浏览和搜索</small></span></label>
    <label><input type="radio" name={name} value="private" checked={value} onChange={() => onChange(true)} /><span><strong>私密</strong><small>{series ? "整个剧集及所有季、单集仅登录后可见" : "仅登录后的普通用户可查看"}</small></span></label>
  </fieldset>;
}
