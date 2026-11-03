import { createContext, useContext } from "react";

export const ViewerContext = createContext({
  revision: 0,
  authenticated: false,
  discoveryPending: false,
  validate: async () => true,
  expire: () => {},
  recordScope: (_private: boolean) => {},
});

// 在公开站组件渲染时读取共享的普通用户会话上下文。
export const useViewer = () => useContext(ViewerContext);
