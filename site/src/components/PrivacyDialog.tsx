import type { JSX } from "@solidjs/web";
import { createEffect } from "solid-js";
import { APP_NAME } from "../brand";

export interface ModalProps {
  open: boolean;
  /** Kapanınca hangi düğmeyle kapandığı (`<form method="dialog">` düğmesinin value'su). */
  onClose: (returnValue: string) => void;
  title: string;
  role?: "dialog" | "alertdialog";
  children: JSX.Element;
  /** Alt düğmeler: `<form method="dialog">` içinde; `value`ları kapanış nedeni olur. */
  actions: JSX.Element;
}

/** Ortada açılan küçük pencere (yerel `<dialog>`). Esc kapatır, düğmeler JS'siz kapatır. */
export function Modal(props: ModalProps) {
  let dialog: HTMLDialogElement | undefined;
  createEffect(
    () => props.open,
    (open) => {
      if (!dialog) return;
      if (open && !dialog.open) {
        dialog.returnValue = "";
        dialog.showModal();
      }
      if (!open && dialog.open) dialog.close();
    },
  );
  return (
    <dialog
      ref={(el) => {
        dialog = el;
        el.addEventListener("close", () => props.onClose(el.returnValue));
      }}
      class="modal"
      role={props.role ?? "dialog"}
      aria-label={props.title}
    >
      <h2 class="modal-title">{props.title}</h2>
      <div class="modal-body">{props.children}</div>
      <form method="dialog" class="modal-actions">
        {props.actions}
      </form>
    </dialog>
  );
}

export function PrivacyDialog(props: { open: boolean; onClose: () => void }) {
  return (
    <Modal
      open={props.open}
      onClose={() => props.onClose()}
      title="Gizlilik ve internetsiz çalışma"
      actions={
        <button type="submit" class="button button-primary" value="ok">
          Tamam
        </button>
      }
    >
      <p class="lead">{APP_NAME} içinde yazdığınız hiçbir metin cihazınızdan çıkmaz.</p>
      <dl class="privacy-list">
        <dt>Sunucu yok</dt>
        <dd>Düzeltme sözlüğü ve kuralları tarayıcınızda, ayrı bir iş parçacığında çalışır.</dd>
        <dt>Belgeler cihazınızda</dt>
        <dd>Tüm belgeler yalnızca tarayıcınızın yerel deposunda (IndexedDB) saklanır; buluta gönderilmez.</dd>
        <dt>İzleme yok</dt>
        <dd>Analitik betiği, dışarıdan yüklenen yazı tipi ya da dış ağ isteği yok.</dd>
        <dt>Uçak modunda da çalışır</dt>
        <dd>İlk açılışta uygulama ve sözlük önbelleğe alındıktan sonra internet olmadan açılır ve düzeltir.</dd>
      </dl>
      <p class="muted-copy">
        Belgelerinizi istediğiniz zaman <code>.txt</code> ya da <code>.md</code> olarak bilgisayarınıza
        kaydedebilirsiniz.
      </p>
    </Modal>
  );
}
