import { omit } from "solid-js";
import type { JSX } from "@solidjs/web";

export interface StatusDotProps extends JSX.HTMLAttributes<HTMLSpanElement> {
  state: "live" | "delayed" | "off";
  children?: JSX.Element;
}

export function StatusDot(props: StatusDotProps) {
  const rest = omit(props, "state", "children", "class");
  const bare = () => props.children == null;
  const fallbackName = () =>
    props.state === "live" ? "Canlı" : props.state === "delayed" ? "Gecikmeli" : "Kapalı";

  return (
    <span
      role={bare() ? "img" : undefined}
      aria-label={bare() ? fallbackName() : undefined}
      {...rest}
      class={["status-dot", props.class]}
      data-state={props.state}
    >
      <i aria-hidden="true" />
      {props.children}
    </span>
  );
}
