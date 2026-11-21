import { omit } from "solid-js";
import type { JSX } from "@solidjs/web";

export type KbdProps = JSX.HTMLAttributes<HTMLElement>;

export function Kbd(props: KbdProps) {
  const rest = omit(props, "class");
  return <kbd translate="no" {...rest} class={["kbd", props.class]} />;
}
