import { createContext, useContext } from "react";

export const ViewerContext = createContext({
  revision: 0,
  authenticated: false,
  discoveryPending: false,
  validate: async () => true,
  expire: () => {},
  recordScope: (_private: boolean) => {},
});

export const useViewer = () => useContext(ViewerContext);
