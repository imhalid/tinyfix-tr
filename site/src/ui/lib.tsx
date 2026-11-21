import { createContext, useContext } from "solid-js";
import type { JSX } from "@solidjs/web";

/** Boyut kademesi: sm · md (varsayılan) · lg. Verilmezse en yakın data-size'tan gelir. */
export type Size = "sm" | "md" | "lg";

/** Bütün çizgi ikonlarının ekran pikseli kalınlığı (mizan ICON_STROKE). */
export const ICON_STROKE = 1.6;

/**
 * Çizgi ikonu: dolgusuz, currentColor kontur, yuvarlak uçlar, ekran okuyucudan gizli.
 * Kalınlık viewBox ve genişlikten hesaplanır; her boyutta ekranda 1,6px görünür.
 */
export function Svg(
  props: Omit<JSX.SvgSVGAttributes<SVGSVGElement>, "stroke-width"> & {
    viewBox: string;
    width: number;
    height: number;
  },
) {
  const strokeWidth = () => {
    const parts = props.viewBox.split(" ");
    const box = Number(parts[2] ?? 16);
    return (ICON_STROKE * box) / props.width;
  };
  return (
    <svg
      fill="none"
      stroke="currentColor"
      stroke-width={strokeWidth()}
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      {...props}
    />
  );
}

/** Kapat düğmesinin çarpı ikonu (Dialog, Sheet, Toaster). */
export function XIcon() {
  return (
    <Svg viewBox="0 0 16 16" width={14} height={14}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </Svg>
  );
}

// Özellik algılama (aşamalı geliştirme)
const supportsCss = (query: string): boolean => {
  try {
    return typeof CSS !== "undefined" && CSS.supports(query);
  } catch {
    return false;
  }
};

export const HAS_ANCHOR = supportsCss("anchor-name: --a");
export const HAS_POPOVER =
  typeof HTMLElement !== "undefined" && "popover" in HTMLElement.prototype;
export const HAS_COMMAND =
  typeof HTMLButtonElement !== "undefined" && "command" in HTMLButtonElement.prototype;
export const HAS_CLOSEDBY =
  typeof HTMLDialogElement !== "undefined" && "closedBy" in HTMLDialogElement.prototype;
export const HAS_INTEREST =
  typeof HTMLButtonElement !== "undefined" &&
  "interestForElement" in HTMLButtonElement.prototype;

/** Seri ya da durum token adı (c1…c8, accent, up, down, muted) → CSS değişkeni. */
export function tokenColor(color: string): string {
  return /^(c[1-8]|accent|up|down|muted)$/.test(color) ? `var(--${color})` : color;
}

/** Öğenin kökündeki (belge ya da gölge kök) etkin öğe. */
export function activeIn(el: Node | null | undefined): Element | null {
  const root = el?.getRootNode() as Document | ShadowRoot | undefined;
  return root && "activeElement" in root ? root.activeElement : document.activeElement;
}

/** Birden çok ref'i (işlev ya da dizi) bir öğeye uygular. */
export function applyRefValue<T>(ref: JSX.Ref<T> | undefined, el: T): void {
  if (!ref) return;
  if (typeof ref === "function") {
    (ref as (value: T) => void)(el);
  } else if (Array.isArray(ref)) {
    for (const item of ref) {
      applyRefValue(item, el);
    }
  }
}

/** Solid EventHandlerUnion çağrıcı (hem işlev hem [işlev, veri] biçimini destekler). */
export function callHandler<E>(
  handler: ((e: E) => void) | { 0: (data: any, e: E) => void; 1: any } | undefined,
  event: E,
): void {
  if (!handler) return;
  if (typeof handler === "function") {
    handler(event);
  } else {
    handler[0](handler[1], event);
  }
}

/** Bileşen içi CSS değişkenlerini tüketicinin style prop'u ile birleştirir. */
export function mergeStyle(
  vars: JSX.CSSProperties,
  userStyle: JSX.CSSProperties | string | false | undefined,
): JSX.CSSProperties | string {
  if (!userStyle) return vars;
  if (typeof userStyle === "string") {
    const prefix = Object.entries(vars)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}:${value}`)
      .join(";");
    return prefix ? `${prefix};${userStyle}` : userStyle;
  }
  return { ...vars, ...userStyle };
}

/** Çapalı katmanın büyüme yönünü (transform-origin) açılışta tetikleyiciye göre günceller. */
type PopoverToggleEvent = ToggleEvent & { source?: Element | null };

let popoverOriginInstalled = false;

function originOf(popup: DOMRect, anchor: DOMRect): string {
  const tol = (n: number) => n * 0.05 + 2;
  const y = popup.top >= anchor.bottom - 2 ? "top" : popup.bottom <= anchor.top + 2 ? "bottom" : "top";
  let x: string;
  if (popup.left >= anchor.right - 2) {
    x = "left";
  } else if (popup.right <= anchor.left + 2) {
    x = "right";
  } else {
    const leftDist = Math.abs(popup.left - anchor.left);
    const rightDist = Math.abs(popup.right - anchor.right);
    x = Math.min(leftDist, rightDist) > tol(popup.width) ? "center" : leftDist <= rightDist ? "left" : "right";
  }
  return `${x} ${y}`;
}

export function trackPopoverOrigin(): void {
  if (popoverOriginInstalled || typeof document === "undefined") return;
  popoverOriginInstalled = true;
  document.addEventListener(
    "toggle",
    (e) => {
      const toggle = e as PopoverToggleEvent;
      const el = toggle.target;
      if (toggle.newState !== "open" || !(el instanceof HTMLElement) || !toggle.source) return;
      if (
        el.matches('[role="tooltip"]') ||
        getComputedStyle(el).getPropertyValue("position-area") === "none"
      ) {
        return;
      }
      el.style.transformOrigin = originOf(
        el.getBoundingClientRect(),
        toggle.source.getBoundingClientRect(),
      );
    },
    true,
  );
}

// Katman açılma / kapanma gerekçesi (Dialog, Sheet, Menu)
export type OpenChangeReason =
  | "trigger-press"
  | "escape-key"
  | "outside-press"
  | "close-press"
  | "item-press"
  | "focus-out"
  | "imperative";

export interface OpenChangeDetails {
  reason: OpenChangeReason;
  event?: Event;
  cancel: () => void;
  readonly canceled: boolean;
}

export type OnOpenChange = (open: boolean, details: OpenChangeDetails) => void;

export function openChangeDetails(reason: OpenChangeReason, event?: Event): OpenChangeDetails {
  let canceled = false;
  return {
    reason,
    event,
    cancel: () => {
      canceled = true;
    },
    get canceled() {
      return canceled;
    },
  };
}

// Field bağlamı (etiket, ipucu ve hata bağlantıları)
export interface FieldCtx {
  id: () => string;
  labelId: () => string;
  describedBy: () => string | undefined;
  invalid: () => boolean;
}

export const FieldContext = createContext<FieldCtx | null>(null);

export function useFieldContext(): FieldCtx | null {
  return useContext(FieldContext);
}

// Gezici sekme durağı (Toolbar ↔ ToggleGroup)
export const RovingScope = createContext<boolean>(false);

export function hasModifier(e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean }): boolean {
  return e.altKey || e.ctrlKey || e.metaKey;
}

export function rovingNext(
  e: KeyboardEvent & { currentTarget: HTMLElement },
  items: HTMLElement[],
  orientation: "horizontal" | "vertical",
): HTMLElement | undefined {
  if (items.length === 0 || hasModifier(e)) return undefined;
  const index = items.indexOf(e.target as HTMLElement);
  const rtl = getComputedStyle(e.currentTarget).direction === "rtl";
  const nextKey = orientation === "vertical" ? "ArrowDown" : rtl ? "ArrowLeft" : "ArrowRight";
  const prevKey = orientation === "vertical" ? "ArrowUp" : rtl ? "ArrowRight" : "ArrowLeft";
  const nextIndex =
    e.key === nextKey
      ? index + 1
      : e.key === prevKey
        ? index - 1
        : e.key === "Home"
          ? 0
          : e.key === "End"
            ? items.length - 1
            : null;
  if (nextIndex === null) return undefined;
  return items[(nextIndex + items.length) % items.length];
}

// Türkçe biçimleme ve arama (Intl)
const trInt = new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 0 });
const trPct = new Intl.NumberFormat("tr-TR", { style: "percent", maximumFractionDigits: 0 });
const trSearch = new Intl.Collator("tr-TR", { usage: "search", sensitivity: "base" });
const trShortDate = new Intl.DateTimeFormat("tr-TR", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

export function formatNumberTr(n: number): string {
  return trInt.format(n);
}

export function formatPercentTr(ratio: number): string {
  return trPct.format(ratio);
}

export function formatShortDateTr(timestamp: number): string {
  try {
    return trShortDate.format(new Date(timestamp));
  } catch {
    return "";
  }
}

export function formatBytesTr(bytes: number): string {
  const units = ["byte", "kilobyte", "megabyte", "gigabyte"] as const;
  let value = bytes;
  let index = 0;
  while (value >= 1000 && index < units.length - 1) {
    value /= 1000;
    index++;
  }
  const digits = index === 0 || value >= 100 ? 0 : 1;
  return new Intl.NumberFormat("tr-TR", {
    style: "unit",
    unit: units[index] ?? "byte",
    unitDisplay: "short",
    maximumFractionDigits: digits,
  }).format(value);
}

export function startsWithTr(text: string | undefined, query: string): boolean {
  if (!query) return true;
  if (!text || text.length < query.length) return false;
  return trSearch.compare(text.slice(0, query.length), query) === 0;
}

export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);
}
