import { Show, createEffect, onCleanup } from "solid-js";
import { For } from "solid-js";
import type { FixKind, FixScope } from "autr";
import { FIX_KIND_META } from "../settings";

/** Penceredeki değişiklik: uygulanmış bir düzeltme ya da analizden gelen bir öneri. */
export interface PopoverFix {
  original: string;
  replacement: string;
  kind: FixKind;
  scope: FixScope;
}

export interface PopoverAction {
  label: string;
  primary?: boolean;
  onClick: () => void;
}

export interface FixPopoverProps {
  /** Gösterilen düzeltme; null iken pencere kapalı. */
  fix: PopoverFix | null;
  /** Tıklanan kelime: pencere ona bağlanır. */
  anchor: HTMLElement | null;
  /** Kapsam açıklamasının yerine geçen kısa not ("Öneri: henüz uygulanmadı."). */
  note?: string;
  actions: readonly PopoverAction[];
  onClose: () => void;
}

const GAP = 6;
const EDGE = 12;

const SCOPE_TEXT = {
  kelime: { label: "Kelime", detail: "Yalnızca kelimenin kendisine bakılarak düzeltildi." },
  baglam: { label: "Bağlam", detail: "Çevresindeki kelimelere bakılarak düzeltildi." },
} as const;

/**
 * Düzeltilmiş bir kelimeye tıklanınca açılan küçük pencere: neyin neye çevrildiği, nedeni ve geri alma.
 * Tarayıcının `popover="auto"` katmanı: Esc ve dışarı tıklama tarayıcının.
 *
 * Yer, kelimenin ekrandaki konumundan hesaplanır. CSS anchor positioning kullanılamıyor: çapa adı kelimenin kendi
 * öğesine yazılmalı, ama o öğe ProseMirror'ın; editör içindeki DOM değişikliklerini hemen geri alıyor. Sayfa
 * kayınca ya da boyutu değişince pencere kapanır, yanlış yerde asılı kalmaz.
 */
export function FixPopover(props: FixPopoverProps) {
  let panel: HTMLDivElement | undefined;

  const place = (anchor: HTMLElement) => {
    if (!panel) return;
    const word = anchor.getBoundingClientRect();
    const width = panel.offsetWidth;
    const height = panel.offsetHeight;
    const left = Math.max(EDGE, Math.min(word.left, window.innerWidth - width - EDGE));
    const below = word.bottom + GAP;
    // Altta yer yoksa kelimenin üstüne açılır.
    const top = below + height + EDGE > window.innerHeight ? Math.max(EDGE, word.top - GAP - height) : below;
    panel.style.setProperty("inset", `${top}px auto auto ${left}px`);
  };

  const close = () => {
    if (panel?.matches(":popover-open")) panel.hidePopover();
  };

  createEffect(
    () => [props.fix, props.anchor] as const,
    ([fix, anchor]) => {
      if (!panel) return;
      if (!fix || !anchor) {
        close();
        return;
      }
      // Pencere, onu açan tıklama tamamen bittikten sonra açılır: aynı tıklamanın içinde açılırsa tarayıcı o tıklamayı
      // "dışarı tıklama" sayıp `popover="auto"` katmanı hemen kapatıyor.
      setTimeout(() => {
        if (!panel || props.fix !== fix) return;
        if (!panel.matches(":popover-open")) panel.showPopover();
        place(anchor);
      }, 0);
    },
  );

  const onViewportChange = () => close();
  window.addEventListener("resize", onViewportChange);
  document.addEventListener("scroll", onViewportChange, { capture: true, passive: true });
  onCleanup(() => {
    window.removeEventListener("resize", onViewportChange);
    document.removeEventListener("scroll", onViewportChange, { capture: true });
  });

  return (
    <div
      ref={(el) => {
        panel = el;
        el.addEventListener("toggle", (event) => {
          if ((event as ToggleEvent).newState === "closed") props.onClose();
        });
      }}
      popover="auto"
      role="dialog"
      aria-label="Düzeltme"
      class="fix-pop"
    >
      <Show when={props.fix}>
        {(fix) => (
          <>
            <div class="fix-pop-head">
              <span class="fix-pop-scope" data-autr-scope={fix().scope}>
                {SCOPE_TEXT[fix().scope].label}
              </span>
              <span class="fix-pop-kind">{FIX_KIND_META[fix().kind].label}</span>
            </div>
            <p class="fix-pop-change">
              <span class="fix-pop-original">{fix().original}</span>
              <span class="fix-pop-arrow" aria-hidden="true">
                →
              </span>
              <span class="visually-hidden">yerine</span>
              <span class="fix-pop-replacement">{fix().replacement}</span>
            </p>
            <p class="fix-pop-detail">{props.note ?? SCOPE_TEXT[fix().scope].detail}</p>
            <div class="fix-pop-actions">
              <For each={props.actions}>
                {(action) => (
                  <button
                    type="button"
                    class={action.primary ? "button button-primary" : "button"}
                    onClick={() => action.onClick()}
                  >
                    {action.label}
                  </button>
                )}
              </For>
            </div>
          </>
        )}
      </Show>
    </div>
  );
}
