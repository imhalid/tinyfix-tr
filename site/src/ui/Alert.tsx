import { Show, omit } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Svg } from "./lib";

export interface AlertProps extends Omit<JSX.HTMLAttributes<HTMLDivElement>, "title"> {
  tone?: "info" | "good" | "bad" | "neutral";
  title?: JSX.Element;
  actions?: JSX.Element;
  icon?: JSX.Element;
}

function defaultAlertIcon(tone: "info" | "good" | "bad" | "neutral"): JSX.Element {
  if (tone === "bad") {
    return (
      <Svg viewBox="0 0 16 16" width={16} height={16}>
        <path d="M8 2.2l6.2 11H1.8z" />
        <path d="M8 6.6v3M8 11.4h.01" />
      </Svg>
    );
  }
  if (tone === "good") {
    return (
      <Svg viewBox="0 0 16 16" width={16} height={16}>
        <circle cx={8} cy={8} r={6.5} />
        <path d="M5.2 8.3l1.9 1.9 3.7-4.2" />
      </Svg>
    );
  }
  return (
    <Svg viewBox="0 0 16 16" width={16} height={16}>
      <circle cx={8} cy={8} r={6.5} />
      <path d="M8 7.2v3.8M8 5h.01" />
    </Svg>
  );
}

export function Alert(props: AlertProps) {
  const rest = omit(props, "tone", "title", "actions", "icon", "class", "children");
  const tone = () => props.tone ?? "info";

  return (
    <div
      role={tone() === "bad" ? "alert" : "status"}
      {...rest}
      class={["alert", props.class]}
      data-tone={tone()}
    >
      <div class="alert-in">
        {props.icon ?? defaultAlertIcon(tone())}
        <Show when={props.title}>
          <b>{props.title}</b>
        </Show>
        <Show when={props.children}>
          <div class="alert-body">{props.children}</div>
        </Show>
        <Show when={props.actions}>
          <div class="actions">{props.actions}</div>
        </Show>
      </div>
    </div>
  );
}
