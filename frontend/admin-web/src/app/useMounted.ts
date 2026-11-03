import { useEffect, useRef } from "react";

// 跟踪组件挂载状态，供异步回调在卸载后跳过状态更新。
export function useMounted() {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  return mounted;
}
