import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "@movie-harbor/ui";

export function AccountMenu({ name, onPassword, onLogout, disabled }: {
  name: string; onPassword: () => void; onLogout: () => void; disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>("button")?.focus();
    function outside(event: PointerEvent) {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    }
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

  function navigate(event: KeyboardEvent<HTMLDivElement>) {
    const buttons = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    const index = buttons.findIndex((button) => button === document.activeElement);
    const destination = event.key === "ArrowDown" ? (index + 1) % buttons.length
      : event.key === "ArrowUp" ? (index - 1 + buttons.length) % buttons.length
        : event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : undefined;
    if (destination !== undefined) { event.preventDefault(); buttons[destination]?.focus(); }
  }

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
