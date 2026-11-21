import { onSettled, omit } from "solid-js";
import type { JSX } from "@solidjs/web";
import { RovingScope, applyRefValue, callHandler, rovingNext } from "./lib";

export interface ToolbarProps extends JSX.HTMLAttributes<HTMLDivElement> {
  children: JSX.Element;
  label?: string;
  orientation?: "horizontal" | "vertical";
}

const FOCUSABLE = "button, a[href], input:not([type=hidden]), select, textarea, [tabindex]";
const TEXT_INPUT =
  "input:not([type=button], [type=checkbox], [type=radio]), textarea, select, [contenteditable]";

export function Toolbar(props: ToolbarProps) {
  const rest = omit(props, "children", "label", "orientation", "class", "ref", "onFocus", "onKeyDown");
  const orientation = () => props.orientation ?? "horizontal";

  let rootEl: HTMLDivElement | undefined;
  let activeEl: HTMLElement | null = null;

  const getItems = (): HTMLElement[] => {
    if (!rootEl) return [];
    return Array.from(rootEl.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (el) =>
        !el.matches(":disabled") &&
        !el.closest('[popover], [aria-hidden="true"]') &&
        el.closest('[role="toolbar"]') === rootEl,
    );
  };

  const syncTabStops = () => {
    const all = getItems();
    if (!activeEl || !all.includes(activeEl)) {
      activeEl = all[0] ?? null;
    }
    for (const el of all) {
      el.tabIndex = el === activeEl ? 0 : -1;
    }
  };

  onSettled(() => {
    syncTabStops();
  });

  return (
    <RovingScope value={true}>
      <div
        role="toolbar"
        aria-label={props.label}
        aria-orientation={orientation()}
        {...rest}
        ref={(el) => {
          rootEl = el;
          applyRefValue(props.ref, el);
        }}
        class={["toolbar", props.class]}
        onFocus={(e) => {
          callHandler(props.onFocus, e);
          const target = e.target as HTMLElement;
          if (getItems().includes(target)) {
            activeEl = target;
            syncTabStops();
          }
        }}
        onKeyDown={(e) => {
          callHandler(props.onKeyDown, e);
          if (e.defaultPrevented || (e.target as Element).matches(TEXT_INPUT)) return;
          const next = rovingNext(e, getItems(), orientation());
          if (!next) return;
          e.preventDefault();
          next.focus();
        }}
      >
        {props.children}
      </div>
    </RovingScope>
  );
}
