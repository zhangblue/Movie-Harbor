import { createContext, useContext } from "react";

// 为公开页共享身份版本及会话操作；未挂载 Provider 时使用匿名默认值。
export const ViewerContext = createContext({
  revision: 0,
  authenticated: false,
  viewerId: undefined as string | undefined,
  discoveryPending: false,
  // 默认匿名上下文无需校验会话，允许公开请求继续。
  validate: async () => true,
  // 默认匿名上下文没有待撤销会话，失效通知无需更新状态。
  expire: () => {},
  // 默认上下文不维护页面范围，由根组件 Provider 接管实际记录。
  recordScope: (_private: boolean) => {},
  // 默认匿名上下文没有服务端同步目标。
  syncProgress: async () => false,
  // 匿名默认无需等待服务端进度；登录 Provider 会在首次同步完成后置为 true。
  progressReady: true,
});

// 在公开站组件渲染时读取共享的普通用户会话上下文。
export const useViewer = () => useContext(ViewerContext);
