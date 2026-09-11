import { useState } from "react";
import type { CatalogKind, ContentStatus } from "@movie-harbor/api-client";
import { Button, Field } from "@movie-harbor/ui";

export type Filters = { kind: CatalogKind; status: ContentStatus | "all"; name: string };
export const initialFilters: Filters = { kind: "all", status: "all", name: "" };

export function ContentFilters({ onQuery, disabled }: { onQuery: (filters: Filters) => void; disabled: boolean }) {
  const [filters, setFilters] = useState(initialFilters);
  return <form className="filter-bar" aria-label="内容查询" onSubmit={(event) => {
    event.preventDefault();
    if (!disabled) onQuery({ ...filters, name: filters.name.trim() });
  }}>
    <Field label="内容形态"><select disabled={disabled} value={filters.kind} onChange={(e) => setFilters({ ...filters, kind: e.target.value as CatalogKind })}>
      <option value="all">全部</option><option value="movie">电影</option><option value="series">剧集</option>
    </select></Field>
    <Field label="状态"><select disabled={disabled} value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value as Filters["status"] })}>
      <option value="all">全部</option><option value="draft">草稿</option><option value="published">已发布</option><option value="archived">已归档</option>
    </select></Field>
    <Field label="名称" className="compact-query"><input type="search" placeholder="名称查询" disabled={disabled} value={filters.name} onChange={(e) => setFilters({ ...filters, name: e.target.value })} /></Field>
    <Button type="submit" disabled={disabled}>查询</Button>
  </form>;
}
