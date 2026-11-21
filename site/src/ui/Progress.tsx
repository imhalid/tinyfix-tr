import { Show, createUniqueId, omit } from "solid-js";
import type { JSX } from "@solidjs/web";
import { formatPercentTr, mergeStyle } from "./lib";

export interface ProgressProps extends Omit<JSX.HTMLAttributes<HTMLDivElement>, "role"> {
  value?: number;
  min?: number;
  max?: number;
  label?: JSX.Element;
  tone?: "accent" | "auto";
  kind?: "progress" | "meter";
  thin?: boolean;
  indeterminate?: boolean;
  showValue?: boolean;
}

export function Progress(props: ProgressProps) {
  const uid = createUniqueId();
  const rest = omit(
    props,
    "value",
    "min",
    "max",
    "label",
    "tone",
    "kind",
    "thin",
    "indeterminate",
    "showValue",
    "class",
    "style",
    "aria-label",
  );

  const min = () => props.min ?? 0;
  const max = () => props.max ?? 100;
  const raw = () => Math.max(min(), Math.min(max(), props.value ?? min()));
  const pct = () => ((raw() - min()) / (max() - min() || 1)) * 100;
  const level = () => (pct() >= 90 ? "bad" : pct() >= 70 ? "warn" : "ok");
  const role = () => props.kind ?? (props.tone === "auto" ? "meter" : "progress");
  const valueText = () =>
    props.indeterminate ? "Yükleniyor…" : formatPercentTr(pct() / 100);

  return (
    <div
      {...rest}
      class={[
        "progress",
        {
          auto: props.tone === "auto",
          thin: Boolean(props.thin),
          indeterminate: Boolean(props.indeterminate),
        },
        props.class,
      ]}
      style={mergeStyle({ "--mz-value": pct() }, props.style)}
      data-level={level()}
      data-pct="pre"
      data-complete={!props.indeterminate && raw() >= max() ? "" : undefined}
    >
      <Show when={props.label}>
        <span class="lab" id={`${uid}l`}>
          {props.label}
        </span>
      </Show>
      <Show when={props.showValue !== false}>
        <span class="val" aria-hidden="true" />
      </Show>
      <div
        class="bar"
        role={role() === "meter" ? "meter" : "progressbar"}
        aria-labelledby={props.label ? `${uid}l` : undefined}
        aria-label={props.label ? undefined : (props["aria-label"] ?? "İlerleme")}
        aria-valuemin={min()}
        aria-valuemax={max()}
        aria-valuenow={props.indeterminate ? undefined : raw()}
        aria-valuetext={valueText()}
      >
        <div class="fill" />
      </div>
    </div>
  );
}
