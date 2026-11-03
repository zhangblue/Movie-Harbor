import { createContext, useContext } from "react";

// 为公开页共享身份版本及会话操作；未挂载 Provider 时使用匿名默认值。
export const ViewerContext = createContext({
  revision: 0,
  authenticated: false,
  discoveryPending: false,
  // 默认匿名上下文无需校验会话，允许公开请求继续。
  validate: async () => true,
  // 默认匿名上下文没有待撤销会话，失效通知无需更新状态。
  expire: () => {},
  // 默认上下文不维护页面范围，由根组件 Provider 接管实际记录。
  recordScope: (_private: boolean) => {},
});

// 在公开站组件渲染时读取共享的普通用户会话上下文。
export const useViewer = () => useContext(ViewerContext);
