// 共享分页窗口中的页码或省略号，供目录和管理分页控件渲染。
export type PaginationItem = number | "ellipsis";

// 在渲染分页控件时计算页码及省略号窗口。
export function paginationItems(currentPage: number, totalPages: number): PaginationItem[] {
  if (
    !Number.isSafeInteger(currentPage) ||
    !Number.isSafeInteger(totalPages) ||
    currentPage < 1 ||
    totalPages < 1 ||
    currentPage > totalPages
  ) {
    throw new RangeError("pagination requires 1 <= currentPage <= totalPages");
  }
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, index) => index + 1);
  if (currentPage <= 4) return [1, 2, 3, 4, 5, "ellipsis", totalPages];
  if (currentPage >= totalPages - 3) {
    return [1, "ellipsis", totalPages - 4, totalPages - 3, totalPages - 2, totalPages - 1, totalPages];
  }
  return [1, "ellipsis", currentPage - 1, currentPage, currentPage + 1, "ellipsis", totalPages];
}
