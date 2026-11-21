import { For, Show, omit } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Svg, applyRefValue, callHandler, tokenColor, useFieldContext, type Size } from "./lib";

export interface ChipOption {
  value: string;
  label: string;
  color?: string;
}

export interface ChipsProps
  extends Omit<JSX.HTMLAttributes<HTMLDivElement>, "onChange" | "color"> {
  options: readonly ChipOption[];
  /** Verilirse jetonlar × düğmesiyle kaldırılır (mizan .chips.tokens). */
  onRemove: (value: string) => void;
  variant?: "dot" | "tinted" | "solid" | "check";
  shape?: "pill" | "rounded";
  size?: Size;
  label?: string;
  disabled?: boolean;
}

/** Kaldırılabilir süzgeç / kelime jetonları (mizan Chips tokens biçimi). */
export function Chips(props: ChipsProps) {
  const field = useFieldContext();
  const rest = omit(
    props,
    "options",
    "onRemove",
    "variant",
    "shape",
    "size",
    "label",
    "disabled",
    "class",
    "ref",
    "onFocus",
    "onBlur",
    "onPointerDown",
  );

  let rootEl: HTMLDivElement | undefined;
  const variant = () => props.variant ?? "dot";

  const removeToken = (value: string, index: number) => {
    props.onRemove(value);
    setTimeout(() => {
      const xs = rootEl?.querySelectorAll<HTMLElement>(".chip-x");
      if (xs && xs.length > 0) {
        const target = xs[Math.min(index, xs.length - 1)];
        target?.focus();
      } else {
        rootEl?.focus();
      }
    });
  };

  return (
    <div
      {...rest}
      ref={(el) => {
        rootEl = el;
        applyRefValue(props.ref, el);
      }}
      class={[
        "chips",
        `v-${variant()}`,
        { rounded: props.shape === "rounded", tokens: true },
        props.class,
      ]}
      data-size={props.size}
      role="list"
      aria-label={props.label}
      aria-labelledby={props.label ? undefined : field?.labelId()}
      aria-describedby={field?.describedBy()}
      tabindex={-1}
      onFocus={(e) => {
        if (e.target === e.currentTarget) {
          rootEl?.querySelector<HTMLElement>(".chip-x:enabled")?.focus();
        }
        callHandler(props.onFocus, e);
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          callHandler(props.onBlur, e);
        }
      }}
      onPointerDown={(e) => {
        callHandler(props.onPointerDown, e);
        if (!(e.target as Element).closest("button:enabled")) e.preventDefault();
      }}
    >
      <For each={props.options} keyed={(option) => option.value}>
        {(option, index) => {
          const tint = () => {
            const c = option().color;
            return c ? ({ "--c": tokenColor(c) } satisfies JSX.CSSProperties) : undefined;
          };
          return (
            <span
              role="listitem"
              class={["chip", "on", { tint: Boolean(option().color) }]}
              style={tint()}
            >
              <Show when={option().color}>
                <i aria-hidden="true" />
              </Show>
              <span>{option().label}</span>
              <button
                type="button"
                class="chip-x"
                disabled={props.disabled}
                aria-label={`«${option().label}» kelimesini listeden çıkar`}
                onClick={() => removeToken(option().value, index())}
                onKeyDown={(e) => {
                  if (e.key === "Backspace" || e.key === "Delete") {
                    e.preventDefault();
                    removeToken(option().value, index());
                  }
                }}
              >
                <Svg viewBox="0 0 16 16" width={10} height={10}>
                  <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
                </Svg>
              </button>
            </span>
          );
        }}
      </For>
    </div>
  );
}
