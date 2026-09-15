import { paginationItems } from "@movie-harbor/ui";
import { Button } from "@movie-harbor/ui";

type Props = {
  page: number;
  size: number;
  total: number;
  disabled: boolean;
  onPage: (page: number) => void;
};

export function ContentPagination({ page, size, total, disabled, onPage }: Props) {
  const totalPages = Math.max(1, Math.ceil(total / size));
  return <nav className="content-pagination" aria-label="内容分页">
    <span className="content-pagination__summary">共 {total} 条 · 第 {page}/{totalPages} 页</span>
    <div className="content-pagination__controls">
      <Button compact disabled={disabled || page === 1} onClick={() => onPage(page - 1)}>上一页</Button>
      {paginationItems(page, totalPages).map((item, index) => item === "ellipsis"
        ? <span key={`ellipsis-${index}`} className="content-pagination__ellipsis" aria-hidden="true">…</span>
        : <Button key={item} compact className="content-pagination__page" disabled={disabled}
          aria-label={`第 ${item} 页`} aria-current={item === page ? "page" : undefined}
          onClick={() => onPage(item)}>{item}</Button>)}
      <Button compact disabled={disabled || page === totalPages} onClick={() => onPage(page + 1)}>下一页</Button>
    </div>
  </nav>;
}
