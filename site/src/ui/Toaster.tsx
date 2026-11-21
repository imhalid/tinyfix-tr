import { For, Show, createEffect, createMemo, createSignal, onSettled, omit } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Button } from "./Button";
import { Spinner } from "./Spinner";
import { HAS_POPOVER, XIcon } from "./lib";

export interface ToastOptions {
  id?: number | string;
  title: JSX.Element;
  description?: JSX.Element;
  tone?: "info" | "good" | "bad" | "neutral" | "loading";
  action?: { label: JSX.Element; onClick?: () => void };
  duration?: number;
}

export interface ToasterProps extends JSX.HTMLAttributes<HTMLElement> {
  max?: number;
  expand?: boolean;
  hotkey?: string[];
}

type ToastId = number | string;
type ToastItem = ToastOptions & { id: ToastId; leaving?: boolean };
type ToastAction =
  | { type: "add"; toast: ToastItem }
  | { type: "update"; id: ToastId; patch: Partial<ToastOptions> }
  | { type: "dismiss"; id?: ToastId };

let subscribers: ((action: ToastAction) => void)[] = [];
let pendingActions: ToastAction[] = [];
let toastSeq = 0;

function dispatchToast(action: ToastAction): void {
  const first = subscribers[0];
  if (first) first(action);
  else pendingActions.push(action);
}

function withDefaults(opts: ToastOptions): Omit<ToastItem, "id"> {
  return {
    tone: "info",
    ...opts,
    duration: opts.duration ?? (opts.tone === "loading" ? 0 : opts.action ? 10000 : 5000),
  };
}

export function toast(input: ToastOptions | string): ToastId {
  const opts = typeof input === "string" ? { title: input } : input;
  const id = opts.id ?? ++toastSeq;
  dispatchToast({ type: "add", toast: { ...withDefaults(opts), id } });
  return id;
}

toast.dismiss = (id?: ToastId) => dispatchToast({ type: "dismiss", id });
toast.update = (id: ToastId, patch: Partial<ToastOptions>) =>
  dispatchToast({ type: "update", id, patch });

const LEAVE_MS = 220;
const TICK_MS = 100;
const FLING = 0.11;
const PAST = 45;
const SLOP = 4;
const damp = (d: number) => d / (1.5 + Math.abs(d) / 20);

const MODS = {
  altKey: "Alt",
  ctrlKey: "Control",
  metaKey: "Meta",
  shiftKey: "Shift",
} as const;
type ModKey = keyof typeof MODS;
const isMod = (k: string): k is ModKey => k in MODS;

function matchesHotkey(e: KeyboardEvent, keys: readonly string[]): boolean {
  return (
    keys.length > 0 &&
    (Object.keys(MODS) as ModKey[]).every((m) => e[m] === keys.includes(m)) &&
    keys.every((k) => isMod(k) || e.code === k || e.key === k)
  );
}

function shortcutLabel(keys: readonly string[]): string {
  return keys.map((k) => (isMod(k) ? MODS[k] : k.replace(/^(Key|Digit)/, ""))).join("+");
}

export function Toaster(props: ToasterProps) {
  const rest = omit(props, "max", "expand", "hotkey", "class", "aria-label", "aria-keyshortcuts");
  const [list, setList] = createSignal<ToastItem[]>([]);
  const [touchOpen, setTouchOpen] = createSignal(false);

  let sectionEl: HTMLElement | undefined;
  let currentList: ToastItem[] = [];
  const hold = new Set<"hover" | "press" | "touch" | "blur">();
  const remaining = new Map<ToastId, number>();
  let focusBack: { to: HTMLElement | null } | null = null;
  let drag: {
    id: ToastId;
    pointerId: number;
    x: number;
    y: number;
    t: number;
    axis?: "x" | "y";
    d: number;
  } | null = null;

  const maxCount = () => props.max ?? 4;
  const hotkey = () => props.hotkey ?? ["F6"];

  const removeToast = (id: ToastId) => {
    remaining.delete(id);
    currentList = currentList.map((item) =>
      item.id === id ? { ...item, leaving: true } : item,
    );
    setList(currentList);
    setTimeout(() => {
      currentList = currentList.filter((item) => item.id !== id || !item.leaving);
      setList(currentList);
    }, LEAVE_MS);
  };

  const restoreFocus = () => {
    const target = focusBack?.to;
    focusBack = null;
    if (target?.isConnected) {
      target.focus();
    } else if (sectionEl?.contains(document.activeElement)) {
      (document.activeElement as HTMLElement).blur();
    }
  };

  const dismissFromButton = (btn: HTMLElement, id: ToastId) => {
    if (btn.matches(":focus-visible")) {
      const rows = Array.from(
        sectionEl?.querySelectorAll<HTMLElement>(".toast-row:not(.leaving)") ?? [],
      );
      const idx = rows.findIndex((row) => row.contains(btn));
      const neighbor = rows[idx + 1] ?? rows[idx - 1];
      const nextClose = neighbor?.querySelector<HTMLElement>(".close");
      if (nextClose) nextClose.focus();
      else restoreFocus();
    }
    removeToast(id);
  };

  onSettled(() => {
    const el = sectionEl;
    let topModal: Element | null = null;

    const showLayer = () => {
      if (!el || !HAS_POPOVER || !el.showPopover) return;
      const modals = document.querySelectorAll("dialog:modal");
      const currentTop = modals[modals.length - 1] ?? null;
      if (el.matches(":popover-open") && currentTop && currentTop !== topModal) {
        el.hidePopover();
      }
      if (!el.matches(":popover-open")) {
        el.showPopover();
      }
      topModal = currentTop;
    };

    showLayer();

    const onDialogToggle = (e: Event) => {
      const target = e.target;
      if (
        target instanceof HTMLDialogElement &&
        target.matches(":modal") &&
        currentList.some((x) => !x.leaving)
      ) {
        showLayer();
      }
    };
    document.addEventListener("toggle", onDialogToggle, true);

    const onBlur = (e: Event) => {
      if (e.target === window) hold.add("blur");
    };
    const onFocus = (e: Event) => {
      if (e.target === window) hold.delete("blur");
    };
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);

    const onKeyDown = (e: KeyboardEvent) => {
      if (!el || !matchesHotkey(e, hotkey()) || !currentList.some((x) => !x.leaving)) return;
      e.preventDefault();
      if (el.contains(document.activeElement)) {
        restoreFocus();
        return;
      }
      const active = document.activeElement;
      focusBack = { to: active instanceof HTMLElement && active !== document.body ? active : null };
      el.focus();
    };
    document.addEventListener("keydown", onKeyDown);

    const handleAction = (action: ToastAction) => {
      if (action.type === "dismiss") {
        for (const item of [...currentList]) {
          if (!item.leaving && (action.id === undefined || item.id === action.id)) {
            removeToast(item.id);
          }
        }
        return;
      }
      if (action.type === "update") {
        currentList = currentList.map((item) =>
          item.id === action.id && !item.leaving ? { ...item, ...action.patch } : item,
        );
        setList(currentList);
        if (action.patch.duration !== undefined) {
          if (action.patch.duration) remaining.set(action.id, action.patch.duration);
          else remaining.delete(action.id);
        }
        return;
      }
      const item = action.toast;
      showLayer();
      const liveItems = currentList.filter((x) => !x.leaving);
      if (liveItems.some((x) => x.id === item.id)) {
        currentList = currentList.map((x) => (x.id === item.id && !x.leaving ? item : x));
        setList(currentList);
      } else {
        const overflow = liveItems.slice(0, Math.max(0, liveItems.length + 1 - maxCount()));
        for (const old of overflow) removeToast(old.id);
        currentList = currentList.filter((x) => x.id !== item.id).concat(item);
        setList(currentList);
      }
      if (item.duration) remaining.set(item.id, item.duration);
      else remaining.delete(item.id);
    };

    subscribers.push(handleAction);
    if (subscribers[0] === handleAction) {
      const queued = pendingActions;
      pendingActions = [];
      queued.forEach(handleAction);
    }

    return () => {
      subscribers = subscribers.filter((fn) => fn !== handleAction);
      document.removeEventListener("toggle", onDialogToggle, true);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
    };
  });

  // Süre sayacı: yalnız bildirim varken çalışır.
  createEffect(
    () => list().length > 0,
    (hasAny) => {
      if (!hasAny) return;
      const timer = setInterval(() => {
        const el = sectionEl;
        const active = document.activeElement;
        const focused =
          Boolean(el) &&
          Boolean(active) &&
          el!.contains(active) &&
          (active !== el || el!.matches(":focus-visible"));
        if (hold.size > 0 || focused || document.hidden) return;
        for (const [id, ms] of [...remaining]) {
          if (ms <= TICK_MS) removeToast(id);
          else remaining.set(id, ms - TICK_MS);
        }
      }, TICK_MS);
      return () => clearInterval(timer);
    },
  );

  // Dokunuşla açılan yığın, bölge dışına dokununca kapanır.
  createEffect(
    () => touchOpen(),
    (isTouchOpen) => {
      if (!isTouchOpen) return;
      hold.add("touch");
      const onOutside = (e: PointerEvent) => {
        if (!sectionEl?.contains(e.target as Node)) setTouchOpen(false);
      };
      document.addEventListener("pointerdown", onOutside, true);
      return () => {
        hold.delete("touch");
        document.removeEventListener("pointerdown", onOutside, true);
      };
    },
  );

  createEffect(
    () => list().some((item) => !item.leaving),
    (hasLive) => {
      if (!hasLive) setTouchOpen(false);
    },
  );

  // Kapalı yığında arkadaki bildirimlerin kesim yüksekliği (--fh).
  createEffect(
    () => list(),
    () => {
      const el = sectionEl;
      const fronts = el?.querySelectorAll<HTMLElement>(".toast-row:not(.leaving) > .toast");
      const front = fronts?.[fronts.length - 1];
      if (!el || !front) return;
      const syncHeight = () => el.style.setProperty("--fh", `${front.offsetHeight}px`);
      syncHeight();
      if (typeof ResizeObserver === "undefined") return;
      const ro = new ResizeObserver(syncHeight);
      ro.observe(front);
      return () => ro.disconnect();
    },
  );

  const depthMap = createMemo(() => {
    const items = list();
    const map = new Map<ToastId, number>();
    let seen = 0;
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (!item) continue;
      map.set(item.id, seen);
      if (!item.leaving) seen++;
    }
    return map;
  });

  const onToastPointerDown = (e: PointerEvent, id: ToastId) => {
    if (e.button !== 0 || (e.target as Element).closest("button, a, input, textarea, select")) {
      return;
    }
    drag = { id, pointerId: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp, d: 0 };
  };

  const onToastPointerMove: JSX.EventHandler<HTMLDivElement, PointerEvent> = (e) => {
    const g = drag;
    const el = e.currentTarget;
    if (!g) return;
    if (e.pointerId !== g.pointerId || e.buttons === 0) {
      drag = null;
      return;
    }
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    if (!g.axis) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < SLOP) return;
      g.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
      el.setPointerCapture(e.pointerId);
      el.toggleAttribute("data-swiping", true);
      window.getSelection()?.removeAllRanges();
    }
    const along = g.axis === "x" ? dx : dy;
    g.d = along > 0 ? along : damp(along);
    el.style.setProperty(g.axis === "x" ? "--sx" : "--sy", `${g.d}px`);
  };

  const onToastPointerUp: JSX.EventHandler<HTMLDivElement, PointerEvent> = (e) => {
    const g = drag;
    const el = e.currentTarget;
    drag = null;
    if (!g) return;
    if (!g.axis) {
      if (e.type === "pointerup" && e.pointerType !== "mouse") setTouchOpen(true);
      return;
    }
    const fast = Math.abs(g.d) / Math.max(1, e.timeStamp - g.t) > FLING;
    const shouldOut = e.type === "pointerup" && g.d > 0 && (fast || g.d >= PAST);
    el.removeAttribute("data-swiping");
    if (shouldOut) {
      if (g.axis === "x") el.style.setProperty("--sx", `${g.d + el.offsetWidth}px`);
      else el.style.setProperty("--sy", `${g.d + el.offsetHeight}px`);
      el.toggleAttribute("data-swipe-out", true);
      removeToast(g.id);
    } else {
      el.style.removeProperty("--sx");
      el.style.removeProperty("--sy");
    }
  };

  return (
    <section
      {...rest}
      ref={(el) => {
        sectionEl = el;
      }}
      class={["toaster", props.class]}
      popover="manual"
      aria-label={props["aria-label"] ?? "Bildirimler"}
      aria-keyshortcuts={props["aria-keyshortcuts"] ?? (shortcutLabel(hotkey()) || undefined)}
      tabindex={-1}
      data-expand={props.expand ? "" : undefined}
      data-expanded={touchOpen() ? "" : undefined}
      aria-live="polite"
      onMouseEnter={() => {
        hold.add("hover");
      }}
      onMouseLeave={() => {
        hold.delete("hover");
      }}
      onPointerDown={() => {
        hold.add("press");
        const up = () => {
          hold.delete("press");
          drag = null;
          window.removeEventListener("pointerup", up);
          window.removeEventListener("pointercancel", up);
        };
        window.addEventListener("pointerup", up);
        window.addEventListener("pointercancel", up);
      }}
      onBlur={(e) => {
        if (e.relatedTarget instanceof Node && !e.currentTarget.contains(e.relatedTarget)) {
          focusBack = null;
        }
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && focusBack) {
          e.preventDefault();
          restoreFocus();
        }
      }}
    >
      <ol class="toast-list">
        <For each={list()} keyed={(item) => item.id}>
          {(item) => (
            <li class={["toast-row", { leaving: Boolean(item().leaving) }]}>
              <div
                class="toast"
                data-tone={item().tone}
                role={item().tone === "bad" ? "alert" : undefined}
                style={{ "--i": depthMap().get(item().id) ?? 0 }}
                onPointerDown={(e) => onToastPointerDown(e, item().id)}
                onPointerMove={onToastPointerMove}
                onPointerUp={onToastPointerUp}
                onPointerCancel={onToastPointerUp}
              >
                <Show
                  when={item().tone === "loading"}
                  fallback={<i aria-hidden="true" />}
                >
                  <Spinner class="toast-spin" aria-hidden="true" />
                </Show>
                <b>{item().title}</b>
                <Show when={item().description}>
                  <div class="toast-desc">{item().description}</div>
                </Show>
                <Show when={item().action}>
                  {(act) => (
                    <Button
                      class="act"
                      onClick={(e) => {
                        act().onClick?.();
                        dismissFromButton(e.currentTarget, item().id);
                      }}
                    >
                      {act().label}
                    </Button>
                  )}
                </Show>
                <Button
                  icon
                  class="close"
                  aria-label="Kapat"
                  onClick={(e) => dismissFromButton(e.currentTarget, item().id)}
                >
                  <XIcon />
                </Button>
              </div>
            </li>
          )}
        </For>
      </ol>
    </section>
  );
}
