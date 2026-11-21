import { omit } from "solid-js";
import type { JSX } from "@solidjs/web";

export interface SeparatorProps extends JSX.HTMLAttributes<HTMLHRElement> {
  orientation?: "horizontal" | "vertical";
  decorative?: boolean;
}

export function Separator(props: SeparatorProps) {
  const rest = omit(props, "orientation", "decorative", "class");
  const orientation = () => props.orientation ?? "horizontal";
  const vertical = () => orientation() === "vertical";

  return (
    <hr
      role={props.decorative ? "none" : undefined}
      aria-orientation={vertical() && !props.decorative ? "vertical" : undefined}
      {...rest}
      class={["separator", props.class]}
      data-orientation={orientation()}
    />
  );
}
