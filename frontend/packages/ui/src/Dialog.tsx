import { createPortal } from "react-dom";
import { useEffect, useEffectEvent, useId, useRef, type ReactNode } from "react";

export interface DialogProps {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  closeLabel?: string;
  className?: string;
}

const focusableSelector = [
  "a[href]", "button", "input:not([type='hidden'])", "select", "textarea", "summary",
  "iframe", "audio[controls]", "video[controls]", "[contenteditable]:not([contenteditable='false'])", "[tabindex]",
].join(",");

function tabbableElements(panel: HTMLElement): HTMLElement[] {
  const candidates = Array.from(panel.querySelectorAll<HTMLElement>(focusableSelector)).filter((element) => {
    if (element.tabIndex < 0) return false;
    if (element.matches(":disabled")) return false;
    if (element.closest("[hidden], [inert], [aria-hidden='true']")) return false;

    let current: HTMLElement | null = element;
    while (current) {
      const style = getComputedStyle(current);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
      if (current === panel) break;
      current = current.parentElement;
    }
    return true;
  }).sort((left, right) => {
    const leftOrder = left.tabIndex > 0 ? left.tabIndex : Number.MAX_SAFE_INTEGER;
    const rightOrder = right.tabIndex > 0 ? right.tabIndex : Number.MAX_SAFE_INTEGER;
    return leftOrder - rightOrder;
  });

  const radioGroups = new Map<HTMLFormElement | null, Map<string, HTMLInputElement[]>>();
  for (const candidate of candidates) {
    if (!(candidate instanceof HTMLInputElement) || candidate.type !== "radio" || candidate.name === "") continue;
    let formGroups = radioGroups.get(candidate.form);
    if (!formGroups) {
      formGroups = new Map();
      radioGroups.set(candidate.form, formGroups);
    }
    const group = formGroups.get(candidate.name) ?? [];
    group.push(candidate);
    formGroups.set(candidate.name, group);
  }

  const radioTabStops = new Set<HTMLInputElement>();
  for (const formGroups of radioGroups.values()) {
    for (const group of formGroups.values()) {
      const tabStop = group.find((radio) => radio.checked) ?? group[0];
      if (tabStop) radioTabStops.add(tabStop);
    }
  }

  return candidates.filter((candidate) => (
    !(candidate instanceof HTMLInputElement)
    || candidate.type !== "radio"
    || candidate.name === ""
    || radioTabStops.has(candidate)
  ));
}

export function Dialog({ open, title, onClose, children, closeLabel, className }: DialogProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const closeFromEffect = useEffectEvent(onClose);

  useEffect(() => {
    if (!open) return;
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    const first = panel ? tabbableElements(panel)[0] : undefined;
    (first ?? panel)?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeFromEffect();
        return;
      }
      if (event.key !== "Tab" || !panel) return;
      const focusable = tabbableElements(panel);
      if (!focusable.length) {
        if (document.activeElement !== panel) {
          event.preventDefault();
          panel.focus();
        }
        return;
      }
      const firstElement = focusable[0];
      const lastElement = focusable[focusable.length - 1];
      if (!firstElement || !lastElement) return;
      const activeElement = document.activeElement;
      if (!panel.contains(activeElement)) {
        event.preventDefault();
        (event.shiftKey ? lastElement : firstElement).focus();
      } else if (event.shiftKey && activeElement === firstElement) {
        event.preventDefault();
        lastElement.focus();
      } else if (!event.shiftKey && document.activeElement === lastElement) {
        event.preventDefault();
        firstElement.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previousFocus.current?.focus();
    };
  }, [open]);

  if (!open) return null;
  const label = closeLabel ?? (typeof title === "string" ? `关闭${title}` : "关闭对话框");
  return createPortal(
    <div
      className="mh-dialog-backdrop"
      data-testid="dialog-backdrop"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div
        ref={panelRef}
        className={["mh-dialog", className].filter(Boolean).join(" ")}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <h2 className="mh-dialog__title" id={titleId}>{title}</h2>
        <div className="mh-dialog__body">{children}</div>
        <button className="mh-dialog__close" type="button" aria-label={label} onClick={onClose}>×</button>
      </div>
    </div>,
    document.body,
  );
}
