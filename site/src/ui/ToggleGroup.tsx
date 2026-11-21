import { For, Show, createSignal, omit, useContext } from "solid-js";
import type { JSX } from "@solidjs/web";
import { RovingScope, applyRefValue, callHandler, rovingNext, type Size } from "./lib";

export interface ToggleOption<T extends string = string> {
  value: T;
  label: string;
  icon?: JSX.Element;
  kbd?: string;
  disabled?: boolean;
}

export interface ToggleGroupProps<T extends string = string>
  extends Omit<JSX.HTMLAttributes<HTMLDivElement>, "onChange" | "onToggle"> {
  options: readonly ToggleOption<T>[];
  value: readonly T[];
  onToggle: (value: T) => void;
  iconOnly?: boolean;
  label?: string;
  orientation?: "horizontal" | "vertical";
  disabled?: boolean;
  size?: Size;
}

export function ToggleGroup<T extends string = string>(props: ToggleGroupProps<T>) {
  const inToolbar = useContext(RovingScope);
  const rest = omit(
    props,
    "options",
    "value",
    "onToggle",
    "iconOnly",
    "label",
    "orientation",
    "disabled",
    "size",
    "class",
    "ref",
    "onKeyDown",
  ) as unknown as JSX.HTMLAttributes<HTMLDivElement>;

  const orientation = () => props.orientation ?? "horizontal";
  const [focusedValue, setFocusedValue] = createSignal<T | null>(null);

  const tabStop = () => {
    const enabled = props.options.filter((o) => !o.disabled && !props.disabled);
    return (
      enabled.find((o) => o.value === focusedValue()) ??
      enabled.find((o) => props.value.includes(o.value)) ??
      enabled[0]
    )?.value;
  };

  return (
    <div
      role="group"
      aria-label={props.label}
      aria-orientation={orientation() === "vertical" ? "vertical" : undefined}
      {...rest}
      ref={(el) => applyRefValue(props.ref, el)}
      class={["toggle-group", props.class]}
      data-size={props.size}
      data-orientation={orientation()}
      tabindex={inToolbar ? undefined : -1}
      onKeyDown={(e) => {
        callHandler(props.onKeyDown, e);
        if (e.defaultPrevented || inToolbar) return;
        const buttons = Array.from(
          e.currentTarget.querySelectorAll<HTMLButtonElement>(":scope > button:not(:disabled)"),
        );
        const next = rovingNext(e, buttons, orientation());
        if (!next) return;
        e.preventDefault();
        next.focus();
      }}
    >
      <For each={props.options} keyed={(option) => option.value}>
        {(option) => {
          const pressed = () => props.value.includes(option().value);
          const title = () => {
            const kbd = option().kbd;
            return kbd ? `${option().label} (${kbd})` : option().label;
          };
          return (
            <button
              type="button"
              aria-pressed={pressed() ? "true" : "false"}
              aria-label={props.iconOnly ? option().label : undefined}
              title={props.iconOnly ? title() : undefined}
              data-icon-only={props.iconOnly ? "" : undefined}
              disabled={props.disabled || option().disabled}
              tabindex={inToolbar ? undefined : option().value === tabStop() ? 0 : -1}
              onFocus={() => setFocusedValue(() => option().value)}
              onClick={() => props.onToggle(option().value)}
            >
              {option().icon}
              <Show when={!props.iconOnly}>{option().label}</Show>
            </button>
          );
        }}
      </For>
    </div>
  );
}
