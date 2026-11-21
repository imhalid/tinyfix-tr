import { omit } from "solid-js";
import type { JSX } from "@solidjs/web";
import { mergeStyle } from "./lib";

export interface SpinnerProps extends JSX.HTMLAttributes<HTMLSpanElement> {
  /** Ekran okuyucu adı. Varsayılan "Yükleniyor…". */
  label?: string;
  /** Çap: sayı px veya CSS uzunluğu. Verilmezse 1em. */
  size?: number | string;
}

export function Spinner(props: SpinnerProps) {
  const rest = omit(props, "label", "size", "class", "style");
  const isHidden = () => props["aria-hidden"] === "true";
  const style = () => {
    if (props.size == null) return props.style;
    const sizeVal = typeof props.size === "number" ? `${props.size}px` : props.size;
    return mergeStyle({ "--spinner-size": sizeVal }, props.style);
  };

  return (
    <span
      role={isHidden() ? undefined : "img"}
      aria-label={isHidden() ? undefined : (props.label ?? "Yükleniyor…")}
      {...rest}
      class={["spinner", props.class]}
      style={style()}
    />
  );
}
