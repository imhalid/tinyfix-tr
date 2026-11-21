import type { JSX } from "@solidjs/web";
import { createEffect } from "solid-js";

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  /** Soldan ("start") ya da sağdan ("end") açılır. */
  side: "start" | "end";
  title: string;
  /** Başlığın altında küçük açıklama. */
  description?: string;
  children: JSX.Element;
}

/**
 * Kenardan kayarak açılan panel: tarayıcının `<dialog>` öğesi. Esc ve arkaplana tıklama kapatır, odak içeri alınır
 * ve kapanınca geri verilir. Telefonda tam genişlikte açılır.
 */
export function Drawer(props: DrawerProps) {
  let dialog: HTMLDialogElement | undefined;

  createEffect(
    () => props.open,
    (open) => {
      if (!dialog) return;
      if (open && !dialog.open) dialog.showModal();
      if (!open && dialog.open) dialog.close();
    },
  );

  return (
    <dialog
      ref={(el) => {
        dialog = el;
        el.addEventListener("close", () => props.onClose());
        // Arkaplana (dialog'un kendisine) tıklanınca kapanır; içeriğe tıklama kapatmaz.
        el.addEventListener("click", (event) => {
          if (event.target === el) el.close();
        });
      }}
      class="drawer"
      data-side={props.side}
      aria-label={props.title}
    >
      <div class="drawer-body">
        <header class="drawer-head">
          <div>
            <h2 class="drawer-title">{props.title}</h2>
            {props.description ? <p class="drawer-description">{props.description}</p> : null}
          </div>
          <button type="button" class="icon-button" aria-label="Kapat" onClick={() => dialog?.close()}>
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </header>
        {props.children}
      </div>
    </dialog>
  );
}
