import { For, Show, omit } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { Size } from "./lib";

export interface NavItem {
  value: string;
  label: JSX.Element;
  icon?: JSX.Element;
  badge?: JSX.Element;
  disabled?: boolean;
  /** Satırın sağında ikincil eylem düğmesi (ör. belge sil); <button> içine gömülmez, kardeş çizilir. */
  trailing?: JSX.Element;
}

export interface NavListProps extends Omit<JSX.HTMLAttributes<HTMLElement>, "onSelect"> {
  items: readonly NavItem[];
  current?: string;
  onSelect?: (value: string) => void;
  label?: string;
  size?: Size;
}

export function NavList(props: NavListProps) {
  const rest = omit(props, "items", "current", "onSelect", "label", "size", "class");

  return (
    <nav
      aria-label={props.label ?? "Gezinme"}
      {...rest}
      class={["nav-list", props.class]}
      data-size={props.size}
    >
      <ul>
        <For each={props.items} keyed={(item) => item.value}>
          {(item) => {
            const isCurrent = () => props.current !== undefined && item().value === props.current;
            return (
              <li class={item().trailing ? "nav-row" : undefined}>
                <button
                  type="button"
                  class="nav-item"
                  aria-current={isCurrent() ? "page" : undefined}
                  disabled={item().disabled}
                  onClick={() => {
                    if (item().disabled) return;
                    props.onSelect?.(item().value);
                  }}
                >
                  <Show when={item().icon != null}>
                    <span class="nav-icon">{item().icon}</span>
                  </Show>
                  <span class="nav-label">{item().label}</span>
                  <Show when={item().badge != null}>
                    <span class="nav-badge">{item().badge}</span>
                  </Show>
                </button>
                {item().trailing}
              </li>
            );
          }}
        </For>
      </ul>
    </nav>
  );
}
