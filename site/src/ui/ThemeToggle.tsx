import { flush, omit } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Button, type ButtonProps } from "./Button";
import { Svg, callHandler } from "./lib";

export type ResolvedThemeValue = "light" | "dark";

export interface ThemeToggleProps
  extends Omit<ButtonProps, "value" | "icon" | "children" | "loading" | "block" | "onChange"> {
  value: ResolvedThemeValue;
  onChange: (next: ResolvedThemeValue) => void;
}

interface ViewTransitionDocument {
  startViewTransition?: (callback: () => void) => {
    ready: Promise<void>;
    finished: Promise<void>;
  };
}

/** Açık/koyu tema düğmesi; View Transitions destekleyen tarayıcıda düğmeden daire olarak açılır. */
export function ThemeToggle(props: ThemeToggleProps) {
  const rest = omit(props, "value", "onChange", "class", "onClick", "aria-label");

  const handleClick: JSX.EventHandler<HTMLButtonElement, MouseEvent> = (e) => {
    callHandler(props.onClick, e);
    if (e.defaultPrevented) return;
    const next: ResolvedThemeValue = props.value === "dark" ? "light" : "dark";
    const html = document.documentElement;
    const vtDoc = document as unknown as ViewTransitionDocument;

    if (
      !vtDoc.startViewTransition ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      props.onChange(next);
      return;
    }

    const rect = e.currentTarget.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const radius = Math.hypot(
      Math.max(x, window.innerWidth - x),
      Math.max(y, window.innerHeight - y),
    );
    html.style.setProperty("--reveal-x", `${x}px`);
    html.style.setProperty("--reveal-y", `${y}px`);
    html.style.setProperty("--reveal-r", `${radius}px`);
    html.toggleAttribute("data-theme-reveal", true);

    const transition = vtDoc.startViewTransition(() => {
      props.onChange(next);
      flush();
    });
    transition.ready.catch(() => {});
    transition.finished.finally(() => {
      html.removeAttribute("data-theme-reveal");
    });
  };

  return (
    <Button
      {...rest}
      icon
      aria-label={
        props["aria-label"] ?? (props.value === "dark" ? "Açık temaya geç" : "Koyu temaya geç")
      }
      aria-pressed={props.value === "dark" ? "true" : "false"}
      class={["theme-toggle", props.class]}
      onClick={handleClick}
    >
      <span class="tt-ico">
        <Svg class="tt-sun" viewBox="0 0 16 16" width={16} height={16}>
          <circle cx="8" cy="8" r="3" />
          <path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l-1 1" />
        </Svg>
        <Svg class="tt-moon" viewBox="0 0 16 16" width={16} height={16}>
          <path d="M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7z" />
        </Svg>
      </span>
    </Button>
  );
}
