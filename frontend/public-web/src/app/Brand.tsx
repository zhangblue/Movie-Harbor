// 由公开站页头渲染品牌标识和首页入口。
export function Brand() {
  return <a className="brand" href="/" aria-label="Movie Harbor 首页">
    <span className="brand-mark" aria-hidden="true">M</span><span>Movie Harbor</span>
  </a>;
}
