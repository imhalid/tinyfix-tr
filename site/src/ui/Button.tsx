import { Show, omit } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Spinner } from "./Spinner";
import { callHandler, mergeStyle, tokenColor, type Size } from "./lib";

export interface ButtonProps extends JSX.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Etiketsiz, yalnızca ikon (aria-label zorunlu). */
  icon?: boolean;
  /** sm 30px · md 40px · lg 44px. Verilmezse çevredeki data-size'tan. */
  size?: Size;
  /** danger: yıkıcı eylem (kırmızı dolu düğme). */
  tone?: "neutral" | "danger";
  /** Token adı (c1…c8, accent, up, down) ya da CSS rengi. */
  color?: "c1" | "c2" | "c3" | "c4" | "c5" | "c6" | "c7" | "c8" | "accent" | "up" | "down" | (string & {});
  /** soft: tonlu kabarık yüzey · solid: renkli dolgu, beyaz etiket. */
  variant?: "soft" | "solid";
  /** Dönen işaret gösterir, tıklamayı durdurur, odağı düğmede tutar. */
  loading?: boolean;
  /** Tam genişlik. */
  block?: boolean;
}

export function Button(props: ButtonProps) {
  const rest = omit(
    props,
    "icon",
    "size",
    "tone",
    "color",
    "variant",
    "loading",
    "block",
    "class",
    "style",
    "children",
    "type",
    "onClick",
    "aria-disabled",
    "aria-busy",
  );

  const busy = () => Boolean(props.loading);
  const danger = () => props.tone === "danger" && !props.color;
  const tint = () => (props.color ? tokenColor(props.color) : danger() ? tokenColor("up") : null);
  const solid = () => (props.variant ? props.variant === "solid" : danger());

  const mergedStyle = () => {
    const t = tint();
    return t ? mergeStyle({ "--btn-c": t }, props.style) : props.style;
  };

  return (
    <button
      type={props.type ?? "button"}
      {...rest}
      class={[
        "btn",
        {
          icon: Boolean(props.icon),
          danger: danger(),
          solid: Boolean(tint()) && solid(),
          tinted: Boolean(tint()) && !solid(),
          block: Boolean(props.block),
          busy: busy(),
        },
        props.class,
      ]}
      style={mergedStyle()}
      data-size={props.size}
      aria-disabled={busy() ? "true" : props["aria-disabled"]}
      aria-busy={busy() ? "true" : props["aria-busy"]}
      onClick={(e) => {
        if (busy()) {
          e.preventDefault();
          return;
        }
        callHandler(props.onClick, e);
      }}
    >
      <Show when={busy()} fallback={props.children}>
        <Show
          when={!props.icon}
          fallback={<Spinner aria-hidden="true" />}
        >
          <Spinner aria-hidden="true" />
          {props.children}
        </Show>
      </Show>
    </button>
  );
}
