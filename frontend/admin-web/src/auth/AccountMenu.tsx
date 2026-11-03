import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "@movie-harbor/ui";

// 在已认证后台页头渲染管理员账户菜单，支持键盘和外部点击关闭。
export function AccountMenu({ name, onPassword, onLogout, disabled }: {
  name: string; onPassword: () => void; onLogout: () => void; disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();

  // 菜单展开时移动焦点并安装关闭监听，关闭或卸载时移除监听以免影响其他页面。
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>("button")?.focus();
    // 在菜单展开时检测外部点击并关闭菜单。
    function outside(event: PointerEvent) {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    }
    // 在菜单展开时响应 Escape 并关闭菜单。
    function escape(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        trigger.current?.focus();
      }
    }
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  // 处理菜单键盘导航，在菜单获得焦点后调用。
  function navigate(event: KeyboardEvent<HTMLDivElement>) {
    const buttons = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    const index = buttons.findIndex((button) => button === document.activeElement);
    const destination = event.key === "ArrowDown" ? (index + 1) % buttons.length
      : event.key === "ArrowUp" ? (index - 1 + buttons.length) % buttons.length
        : event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : undefined;
    if (destination !== undefined) { event.preventDefault(); buttons[destination]?.focus(); }
  }

  // 关闭菜单并执行选定操作，在选择菜单项时调用。
  function select(action: () => void) {
    setOpen(false);
    trigger.current?.focus();
    action();
  }

  return <div className="account-wrap" ref={root} onBlur={(event) => {
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }}>
    <Button ref={trigger} className="account-button" aria-label={name} aria-haspopup="menu" aria-expanded={open}
      aria-controls={open ? menuId : undefined} disabled={disabled} onClick={() => setOpen(!open)}
      onKeyDown={(event) => { if (event.key === "ArrowDown") { event.preventDefault(); setOpen(true); } }}>
      <span className="avatar" aria-hidden="true">{name.slice(0, 1)}</span><span>{name}</span><span aria-hidden="true">⌄</span>
    </Button>
    {open && <div className="account-menu" id={menuId} ref={menu} role="menu" aria-label="账号菜单" onKeyDown={navigate}>
      <button type="button" role="menuitem" onClick={() => select(onPassword)}>修改密码</button>
      <button type="button" role="menuitem" className="danger-text" onClick={() => select(onLogout)}>退出登录</button>
    </div>}
  </div>;
}
