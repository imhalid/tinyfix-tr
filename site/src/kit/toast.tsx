import { For, Show, createSignal } from "solid-js";

export interface ToastOptions {
  /** Aynı kimlikli bildirim varsa yerine geçer. */
  id?: string;
  title: string;
  /** Kaç ms sonra kaybolacağı. */
  duration?: number;
  action?: { label: string; onClick: () => void };
}

interface ToastItem extends ToastOptions {
  key: string;
}

const [items, setItems] = createSignal<ToastItem[]>([]);
let counter = 0;

/** Ekranın altında kısa süreli, sessiz bir bildirim gösterir. */
export function toast(options: ToastOptions): void {
  const key = options.id ?? `toast-${++counter}`;
  const item: ToastItem = { ...options, key };
  setItems((prev) => [...prev.filter((other) => other.key !== key), item].slice(-3));
  setTimeout(() => dismiss(key), options.duration ?? 4000);
}

function dismiss(key: string): void {
  setItems((prev) => prev.filter((item) => item.key !== key));
}

/** Bildirim alanı; uygulamada bir kez çizilir. */
export function Toasts() {
  return (
    <div class="toasts" role="status" aria-live="polite">
      <For each={items()} keyed={(item) => item.key}>
        {(item) => (
          <div class="toast">
            <span class="toast-title">{item().title}</span>
            <Show when={item().action}>
              {(action) => (
                <button
                  type="button"
                  class="text-button"
                  onClick={() => {
                    action().onClick();
                    dismiss(item().key);
                  }}
                >
                  {action().label}
                </button>
              )}
            </Show>
          </div>
        )}
      </For>
    </div>
  );
}
