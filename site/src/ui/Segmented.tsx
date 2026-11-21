import { For, Show, createEffect, createSignal, onSettled, omit } from "solid-js";
import type { JSX } from "@solidjs/web";
import {
  HAS_ANCHOR,
  applyRefValue,
  callHandler,
  hasModifier,
  useFieldContext,
  type Size,
} from "./lib";

export interface SegmentedOption<T extends string | number = string> {
  value: T;
  label: JSX.Element;
  disabled?: boolean;
}

export interface SegmentedProps<T extends string | number = string>
  extends Omit<JSX.HTMLAttributes<HTMLDivElement>, "onChange"> {
  options: readonly SegmentedOption<T>[];
  value: T | null;
  onChange?: (value: T) => void;
  size?: Size;
  fill?: boolean;
  label?: string;
  disabled?: boolean;
}

interface PillRect {
  x?: number;
  w?: number;
}

function focusSelectedItem(root: Element | null): void {
  const items = Array.from(root?.querySelectorAll<HTMLElement>('[role="radio"]:enabled') ?? []);
  const target = items.find((btn) => btn.getAttribute("aria-checked") === "true") ?? items[0];
  target?.focus();
}

export function Segmented<T extends string | number = string>(props: SegmentedProps<T>) {
  const field = useFieldContext();
  const rest = omit(
    props,
    "options",
    "value",
    "onChange",
    "size",
    "fill",
    "label",
    "disabled",
    "class",
    "ref",
    "onFocus",
    "onBlur",
    "onKeyDown",
  ) as unknown as JSX.HTMLAttributes<HTMLDivElement>;

  let rootEl: HTMLDivElement | undefined;
  const [anchor, setAnchor] = createSignal(false);
  const [pill, setPill] = createSignal<PillRect | null>(null);
  const [ready, setReady] = createSignal(false);

  const place = () => {
    if (HAS_ANCHOR) {
      setAnchor(true);
      setPill((prev) => prev ?? {});
      return;
    }
    const activeBtn = rootEl?.querySelector<HTMLElement>('[aria-checked="true"]');
    const next = activeBtn ? { x: activeBtn.offsetLeft, w: activeBtn.offsetWidth } : null;
    setPill((prev) => (prev && next && prev.x === next.x && prev.w === next.w ? prev : next));
  };

  createEffect(
    () => [props.value, props.options.length] as const,
    () => {
      place();
    },
  );

  onSettled(() => {
    place();
    const ro = HAS_ANCHOR || !rootEl || typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(place);
    if (ro && rootEl) ro.observe(rootEl);
    const raf = requestAnimationFrame(() => setReady(true));
    return () => {
      ro?.disconnect();
      cancelAnimationFrame(raf);
    };
  });

  const selected = () => props.options.some((o) => o.value === props.value);
  const tabStop = () => {
    const cur = props.options.findIndex((o) => o.value === props.value && !o.disabled);
    return cur >= 0 ? cur : props.options.findIndex((o) => !o.disabled);
  };

  const pillStyle = (): JSX.CSSProperties | undefined => {
    if (anchor()) return undefined;
    const p = pill();
    if (!p || p.w === undefined || p.x === undefined) return undefined;
    return { width: `${p.w}px`, transform: `translateX(${p.x}px)` };
  };

  const handleKeyDown: JSX.EventHandler<HTMLDivElement, KeyboardEvent> = (e) => {
    callHandler(props.onKeyDown, e);
    if (e.defaultPrevented || props.disabled || hasModifier(e)) return;
    const rtl = getComputedStyle(e.currentTarget).direction === "rtl";
    const fwd = e.key === "ArrowDown" || e.key === (rtl ? "ArrowLeft" : "ArrowRight");
    const back = e.key === "ArrowUp" || e.key === (rtl ? "ArrowRight" : "ArrowLeft");
    if (!fwd && !back) return;
    e.preventDefault();
    const list = props.options;
    const len = list.length;
    if (len === 0) return;
    const curIdx = list.findIndex((o) => o.value === props.value);
    const base = curIdx < 0 ? (fwd ? -1 : 0) : curIdx;
    for (let step = 1; step <= len; step++) {
      const nextIdx = (((base + (fwd ? step : -step)) % len) + len) % len;
      const option = list[nextIdx];
      if (!option || option.disabled) continue;
      props.onChange?.(option.value);
      rootEl?.querySelectorAll<HTMLElement>('[role="radio"]')[nextIdx]?.focus();
      return;
    }
  };

  return (
    <div
      {...rest}
      ref={(el) => {
        rootEl = el;
        applyRefValue(props.ref, el);
      }}
      class={[
        "seg",
        {
          "has-pill": Boolean(pill()),
          anchored: anchor(),
          fill: Boolean(props.fill),
        },
        props.class,
      ]}
      data-size={props.size}
      role="radiogroup"
      aria-disabled={props.disabled ? "true" : undefined}
      aria-labelledby={props.label ? undefined : field?.labelId()}
      aria-describedby={field?.describedBy()}
      aria-label={props.label ?? (field ? undefined : "Seçenekler")}
      tabindex={-1}
      onFocus={(e) => {
        if (e.target === e.currentTarget) focusSelectedItem(e.currentTarget);
        callHandler(props.onFocus, e);
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          callHandler(props.onBlur, e);
        }
      }}
      onKeyDown={handleKeyDown}
    >
      <Show when={pill() && selected()}>
        <span class={["pill", { ready: ready() }]} style={pillStyle()} aria-hidden="true" />
      </Show>
      <For each={props.options} keyed={(option) => option.value}>
        {(option, index) => {
          const isOn = () => props.value === option().value;
          return (
            <button
              type="button"
              role="radio"
              aria-checked={isOn() ? "true" : "false"}
              tabindex={index() === tabStop() ? 0 : -1}
              disabled={props.disabled || option().disabled}
              class={isOn() ? "on" : undefined}
              onClick={() => props.onChange?.(option().value)}
            >
              {option().label}
            </button>
          );
        }}
      </For>
    </div>
  );
}
