// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";
import { Fragment, useEffect, useId, useRef, useState } from "react";
import { MoreHorizontal, type LucideIcon } from "lucide-react";
import styles from "./workflow-more-actions.module.css";

export type WorkflowSecondaryAction = {
  label: string;
  icon: LucideIcon;
  onSelect: () => void;
  disabled?: boolean;
  expanded?: boolean;
  separatorBefore?: boolean;
  shortcut?: string;
};

/** Occasional document tools follow the Studio's single overflow menu. */
export function WorkflowMoreActions({ actions, label = "More workflow actions", icon: TriggerIcon = MoreHorizontal, text, align = "end" }: { actions: WorkflowSecondaryAction[]; label?: string; icon?: LucideIcon; text?: string; align?: "start" | "end" }) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState({ above: false, height: 520 });
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const initialFocus = useRef<"first" | "last">("first");
  const id = useId();
  const choices = () => Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
  function close(restoreFocus = false) {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  }
  function select(action: WorkflowSecondaryAction) {
    if (action.disabled) return;
    // Restore before invoking the action so newly opened dialogs can take focus.
    close(true);
    action.onSelect();
  }
  useEffect(() => {
    if (!open) return;
    const position = () => {
      const bounds = trigger.current?.getBoundingClientRect();
      if (!bounds) return;
      const below = window.innerHeight - bounds.bottom - 14;
      const above = bounds.top - 14;
      const desired = Math.min(menu.current?.scrollHeight ?? 520, 520);
      const upwards = below < desired && above > below;
      setPlacement({ above: upwards, height: Math.max(40, Math.min(520, upwards ? above : below)) });
    };
    position();
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    const items = choices();
    items[initialFocus.current === "last" ? items.length - 1 : 0]?.focus();
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => { document.removeEventListener("pointerdown", dismiss); window.removeEventListener("resize", position); window.removeEventListener("scroll", position, true); };
  }, [open]);
  if (!actions.length) return null;
  return <div ref={root} className={styles.root} onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget as Node)) close();
  }} onKeyDown={event => {
    if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); close(true); }
  }}>
    <button ref={trigger} type="button" className={`${styles.trigger} ${text ? styles.textTrigger : ""}`} aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => { initialFocus.current = "first"; setOpen(!open); }}
      onKeyDown={event => {
        if (["ArrowDown", "ArrowUp"].includes(event.key)) {
          event.preventDefault(); initialFocus.current = event.key === "ArrowUp" ? "last" : "first"; setOpen(true);
        }
      }}><TriggerIcon size={18} aria-hidden="true" />{text && <span>{text}</span>}</button>
    {open && <div ref={menu} id={id} className={`${styles.menu} ${align === "start" ? styles.startMenu : ""}`} style={{ top: placement.above ? "auto" : undefined, bottom: placement.above ? "calc(100% + 6px)" : undefined, maxHeight: placement.height }} role="menu" aria-label="Workflow actions" onKeyDown={event => {
      event.stopPropagation();
      if (event.key === "Escape") { event.preventDefault(); close(true); return; }
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const items = choices(), index = items.indexOf(document.activeElement as HTMLButtonElement);
        items[event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length]?.focus();
      } else if (!event.ctrlKey && !event.metaKey && !event.altKey && !event.repeat && !event.nativeEvent.isComposing) {
        const action = actions.find(item => item.shortcut?.toLowerCase() === event.key.toLowerCase());
        if (action && !action.disabled) { event.preventDefault(); select(action); }
      }
    }}>
      {actions.map((action, index) => <Fragment key={action.label}>
        {index > 0 && action.separatorBefore && <div role="separator" className={styles.separator} />}
        <button type="button" role="menuitem" tabIndex={-1} disabled={action.disabled} aria-expanded={action.expanded} onClick={() => select(action)}>
          <action.icon size={16} aria-hidden="true" /><span>{action.label}</span>{action.shortcut && <kbd aria-hidden="true">{action.shortcut}</kbd>}
        </button>
      </Fragment>)}
    </div>}
  </div>;
}
