import { Show, createEffect, createSignal, createUniqueId } from "solid-js";
import type { JSX } from "@solidjs/web";
import { HAS_INTEREST } from "./lib";

export interface TooltipProps {
  content: JSX.Element;
  kbd?: string;
  children: JSX.Element;
  side?: "top" | "bottom" | "start" | "end";
  delay?: number;
  disabled?: boolean;
  class?: JSX.ClassValue;
}

/** Hover veya klavye odağında kısa açıklama (mizan .has-tooltip + .tooltip, popover="hint"). */
export function Tooltip(props: TooltipProps) {
  const uid = createUniqueId();
  const [wrapEl, setWrapEl] = createSignal<HTMLSpanElement | undefined>(undefined);
  const [tipEl, setTipEl] = createSignal<HTMLSpanElement | undefined>(undefined);

  const [native, setNative] = createSignal(false);
  const [hovered, setHovered] = createSignal(false);
  const [dismissed, setDismissed] = createSignal(false);
  let keyboardFocus = false;

  createEffect(
    () => wrapEl(),
    (wrap) => {
      const child = wrap?.firstElementChild;
      if (!child) return;

      const prevDesc = child.getAttribute("aria-describedby");
      const nextDesc = [prevDesc, uid].filter(Boolean).join(" ");
      child.setAttribute("aria-describedby", nextDesc);

      const canNative = HAS_INTEREST && "interestForElement" in child;
      if (canNative) {
        child.setAttribute("interestfor", uid);
      }
      setNative(canNative);

      return () => {
        if (prevDesc) {
          child.setAttribute("aria-describedby", prevDesc);
        } else {
          child.removeAttribute("aria-describedby");
        }
        if (canNative) {
          child.removeAttribute("interestfor");
        }
      };
    },
  );

  const dismissFallback = (e: KeyboardEvent) => {
    const tip = tipEl();
    if (
      e.key !== "Escape" ||
      dismissed() ||
      !tip ||
      getComputedStyle(tip).display === "none"
    ) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    setDismissed(true);
  };

  // Yedek yolda imleçle açıkken Esc belgeye gelir.
  createEffect(
    () => [hovered(), native()] as const,
    ([isHovered, isNative]) => {
      if (!isHovered || isNative) return;
      document.addEventListener("keydown", dismissFallback);
      return () => document.removeEventListener("keydown", dismissFallback);
    },
  );

  // Yerel yolda Esc yalnızca ipucunu kapatsın (çevredeki dialog kapanmasın).
  createEffect(
    () => [native(), tipEl()] as const,
    ([isNative, el]) => {
      if (!isNative || !el) return;
      const onEsc = (e: KeyboardEvent) => {
        if (
          e.key !== "Escape" ||
          !el.matches(":popover-open") ||
          getComputedStyle(el).display === "none"
        ) {
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        setDismissed(true);
        el.hidePopover?.();
      };
      const onToggle = (e: Event) => {
        if ((e as ToggleEvent).newState === "open") {
          document.addEventListener("keydown", onEsc, true);
        } else {
          document.removeEventListener("keydown", onEsc, true);
        }
      };
      el.addEventListener("toggle", onToggle);
      return () => {
        el.removeEventListener("toggle", onToggle);
        document.removeEventListener("keydown", onEsc, true);
      };
    },
  );

  const sideAttr = () => (props.side && props.side !== "top" ? props.side : undefined);
  const styleAttr = (): JSX.CSSProperties | undefined =>
    props.delay != null ? { "--tt-delay": `${props.delay}ms` } : undefined;

  return (
    <Show when={!props.disabled} fallback={props.children}>
      <span
        ref={setWrapEl}
        class={["has-tooltip", props.class]}
        data-side={sideAttr()}
        data-native={native() ? "" : undefined}
        data-dismissed={dismissed() ? "" : undefined}
        style={styleAttr()}
        onPointerDown={() => {
          setDismissed(true);
          if (native()) tipEl()?.hidePopover?.();
        }}
        onPointerEnter={() => {
          if (!native()) setHovered(true);
        }}
        onPointerLeave={() => {
          setHovered(false);
          setDismissed(false);
        }}
        onFocus={(e) => {
          if (native()) return;
          const target = e.target as Element;
          setTimeout(() => {
            keyboardFocus = target.matches(":focus-visible");
          });
        }}
        onBlur={() => {
          keyboardFocus = false;
          setDismissed(false);
        }}
        onKeyUp={() => {
          keyboardFocus = true;
        }}
        onKeyDown={(e) => {
          if (native()) return;
          if (keyboardFocus || hovered()) {
            dismissFallback(e);
            return;
          }
          if (e.key === "Escape") setDismissed(true);
        }}
      >
        {props.children}
        <span ref={setTipEl} class="tooltip" role="tooltip" id={uid} popover="hint">
          {props.content}
          <Show when={props.kbd}>
            <kbd translate="no">{props.kbd}</kbd>
          </Show>
          <span class="tooltip-arrow" aria-hidden="true" />
        </span>
      </span>
    </Show>
  );
}
