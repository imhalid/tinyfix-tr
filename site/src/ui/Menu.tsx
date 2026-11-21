import { For, Show, createUniqueId, onSettled, omit } from "solid-js";
import type { JSX } from "@solidjs/web";
import {
  activeIn,
  applyRefValue,
  callHandler,
  startsWithTr,
  trackPopoverOrigin,
  type Size,
} from "./lib";

export type MenuItem =
  | {
      type?: "action";
      label: string;
      icon?: JSX.Element;
      kbd?: string;
      disabled?: boolean;
      danger?: boolean;
      onSelect?: () => void;
    }
  | { separator: true }
  | { heading: string };

export interface MenuProps
  extends Omit<JSX.HTMLAttributes<HTMLDivElement>, "role" | "popover" | "children"> {
  trigger?: JSX.Element;
  icon?: boolean;
  label?: string;
  size?: Size;
  items: readonly MenuItem[];
  triggerClass?: JSX.ClassValue;
  triggerRef?: JSX.Ref<HTMLButtonElement>;
}

function getMenuItems(menuEl: HTMLElement | null): HTMLElement[] {
  if (!menuEl) return [];
  const isOpen = menuEl.matches(":popover-open");
  return Array.from(menuEl.querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled)')).filter(
    (item) =>
      item.closest('[role="menu"]') === menuEl &&
      (!isOpen || (typeof item.checkVisibility === "function" ? item.checkVisibility() : true)),
  );
}

/** Eylem menüsü: popover="auto" + popovertarget (örtük çapa, Esc ve dışarı tıklama tarayıcının). */
export function Menu(props: MenuProps) {
  const uid = createUniqueId().replace(/[^A-Za-z0-9]/g, "");
  const rest = omit(
    props,
    "trigger",
    "icon",
    "label",
    "size",
    "items",
    "triggerClass",
    "triggerRef",
    "class",
    "id",
    "onKeyDown",
  );

  const menuId = () => props.id ?? `menu${uid}`;
  const triggerId = `menu-t${uid}`;

  let menuEl: HTMLDivElement | undefined;
  const typed = { s: "", at: 0 };

  const closeMenu = () => {
    menuEl?.hidePopover?.();
  };

  const firstEnabledIndex = () =>
    props.items.findIndex(
      (item) => !("separator" in item) && !("heading" in item) && !item.disabled,
    );

  onSettled(() => {
    trackPopoverOrigin();
    const onWindowBlur = () => {
      if (menuEl?.matches(":popover-open")) closeMenu();
    };
    window.addEventListener("blur", onWindowBlur);
    return () => window.removeEventListener("blur", onWindowBlur);
  });

  const handleTriggerKeyDown: JSX.EventHandler<HTMLButtonElement, KeyboardEvent> = (e) => {
    if ((e.key !== "ArrowDown" && e.key !== "ArrowUp") || menuEl?.matches(":popover-open")) return;
    e.preventDefault();
    e.currentTarget.click();
    if (e.key === "ArrowUp") {
      getMenuItems(menuEl ?? null).at(-1)?.focus();
    }
  };

  const typeahead = (ch: string, all: HTMLElement[], currentIndex: number): HTMLElement | undefined => {
    const now = Date.now();
    typed.s = now - typed.at > 500 ? ch : typed.s === ch ? ch : typed.s + ch;
    typed.at = now;
    const ordered = all.slice(currentIndex + 1).concat(all.slice(0, currentIndex + 1));
    return ordered.find(
      (el) =>
        el.getAttribute("aria-disabled") !== "true" && startsWithTr(el.dataset["label"], typed.s),
    );
  };

  const handleMenuKeyDown: JSX.EventHandler<HTMLDivElement, KeyboardEvent> = (e) => {
    callHandler(props.onKeyDown, e);
    if (e.defaultPrevented) return;
    if (e.key === "Tab") {
      closeMenu();
      return;
    }
    const all = getMenuItems(menuEl ?? null);
    if (all.length === 0) return;
    const currentIndex = all.indexOf(activeIn(menuEl) as HTMLElement);
    if (e.key.length === 1 && e.key !== " " && !e.ctrlKey && !e.metaKey && !e.altKey) {
      typeahead(e.key, all, currentIndex)?.focus();
      return;
    }
    const nextIndex =
      e.key === "ArrowDown"
        ? currentIndex + 1
        : e.key === "ArrowUp"
          ? currentIndex - 1
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? all.length - 1
              : null;
    if (nextIndex === null) return;
    e.preventDefault();
    all[(nextIndex + all.length) % all.length]?.focus();
  };

  return (
    <>
      <button
        ref={(el) => applyRefValue(props.triggerRef, el)}
        type="button"
        id={triggerId}
        popovertarget={menuId()}
        aria-haspopup="menu"
        aria-label={props.icon ? props.label : undefined}
        data-size={props.size}
        class={["btn", "menu-trigger", { icon: Boolean(props.icon) }, props.triggerClass]}
        onKeyDown={handleTriggerKeyDown}
      >
        {props.trigger ?? "Seçenekler"}
      </button>
      <div
        {...rest}
        ref={(el) => {
          menuEl = el;
        }}
        id={menuId()}
        popover="auto"
        role="menu"
        aria-label={props.label}
        aria-labelledby={props.label ? undefined : triggerId}
        class={["menu", props.class]}
        onKeyDown={handleMenuKeyDown}
      >
        <For each={props.items}>
          {(item, index) => {
            if ("separator" in item) {
              return <div role="separator" />;
            }
            if ("heading" in item) {
              return (
                <div class="label" aria-hidden="true">
                  {item.heading}
                </div>
              );
            }
            return (
              <button
                type="button"
                role="menuitem"
                tabindex={-1}
                autofocus={index() === firstEnabledIndex() ? true : undefined}
                data-label={item.label}
                aria-disabled={item.disabled ? "true" : undefined}
                class={item.danger ? "danger" : undefined}
                onClick={() => {
                  if (item.disabled) return;
                  closeMenu();
                  item.onSelect?.();
                }}
              >
                {item.icon}
                <span>{item.label}</span>
                <Show when={item.kbd}>
                  <kbd translate="no">{item.kbd}</kbd>
                </Show>
              </button>
            );
          }}
        </For>
      </div>
    </>
  );
}
