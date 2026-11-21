import { createEffect, createSignal, type Accessor } from "solid-js";
import {
  HAS_CLOSEDBY,
  openChangeDetails,
  type OnOpenChange,
  type OpenChangeReason,
} from "./lib";

/** Dialog içinde açık bir açılır katman (popover veya base-select) var mı. */
export function nestedOpen(dialog: Element): boolean {
  if (dialog.querySelector(":popover-open")) return true;
  try {
    return Boolean(dialog.querySelector("select:open"));
  } catch {
    return false;
  }
}

export interface DialogControllerOptions {
  open: Accessor<boolean | undefined>;
  onClose: Accessor<((returnValue: string) => void) | undefined>;
  onOpenChange: Accessor<OnOpenChange | undefined>;
  lightDismiss: Accessor<boolean>;
  modal: Accessor<boolean>;
}

/**
 * Mizan'ın `<dialog>` yaşam döngüsü:
 * - Kontrollü `open` ile `showModal()` / `close()` eşlemesi
 * - Esc (`cancel`), dışarı tıklama (`closedby="any"` + yedek), `<form method="dialog">` (`submit`)
 * - İç içe katmanlar (önce içteki kapanır)
 */
export function createDialogController(options: DialogControllerOptions) {
  const [dialogEl, setDialogEl] = createSignal<HTMLDialogElement | undefined>(undefined);
  let closedByProp = false;
  let downOutside = false;

  // Kontrollü open prop'unu yerel showModal/close durumuna eşle.
  createEffect(
    () => [dialogEl(), options.open(), options.modal()] as const,
    ([el, isOpen, isModal]) => {
      if (!el || isOpen === undefined) return;
      if (isOpen && !el.open) {
        if (!el.showModal) {
          el.setAttribute("open", "");
        } else if (isModal) {
          el.showModal();
        } else {
          el.show();
        }
      } else if (!isOpen && el.open) {
        closedByProp = true;
        // İçteki açık modalları en derinden kapat; yoksa sayfa inert kalır.
        Array.from(el.querySelectorAll<HTMLDialogElement>("dialog[open]"))
          .reverse()
          .forEach((child) => child.close());
        el.close();
      }
    },
  );

  const requestClose = (reason: OpenChangeReason, event: Event | undefined, value: string): boolean => {
    const details = openChangeDetails(reason, event);
    options.onOpenChange()?.(false, details);
    if (details.canceled) return true;
    if (options.open() === undefined) return false;
    options.onClose()?.(value);
    return true;
  };

  createEffect(
    () => dialogEl(),
    (el) => {
      if (!el) return;
      let lastKey = "";
      let pressedOverNested = false;

      const onKey = (e: KeyboardEvent) => {
        if ((e.target as Element).closest("dialog") !== el) return;
        lastKey = e.key;
        setTimeout(() => {
          lastKey = "";
        });
      };

      const onDown = () => {
        lastKey = "";
        pressedOverNested = nestedOpen(el);
      };

      const onCancel = (e: Event) => {
        const reason: OpenChangeReason = lastKey === "Escape" ? "escape-key" : "outside-press";
        lastKey = "";
        if (reason === "outside-press" && pressedOverNested) {
          pressedOverNested = false;
          e.preventDefault();
          return;
        }
        if (!e.cancelable) {
          options.onOpenChange()?.(false, openChangeDetails(reason, e));
          return;
        }
        if (requestClose(reason, e, "")) {
          e.preventDefault();
        }
      };

      const onSubmit = (e: Event) => {
        const form = e.target as HTMLFormElement;
        if (form.method !== "dialog" || form.closest("dialog") !== el) return;
        const submitter = (e as SubmitEvent).submitter as HTMLButtonElement | null;
        const value = submitter?.value ?? "";
        if (requestClose("close-press", e, value)) {
          e.preventDefault();
        }
      };

      const onClosed = () => {
        const value = el.returnValue;
        el.returnValue = "";
        if (closedByProp) {
          closedByProp = false;
          return;
        }
        options.onClose()?.(value);
      };

      el.addEventListener("keydown", onKey);
      el.addEventListener("pointerdown", onDown, true);
      el.addEventListener("cancel", onCancel);
      el.addEventListener("submit", onSubmit);
      el.addEventListener("close", onClosed);

      return () => {
        el.removeEventListener("keydown", onKey);
        el.removeEventListener("pointerdown", onDown, true);
        el.removeEventListener("cancel", onCancel);
        el.removeEventListener("submit", onSubmit);
        el.removeEventListener("close", onClosed);
      };
    },
  );

  const isOutside = (e: MouseEvent): boolean => {
    const el = dialogEl();
    if (!el || e.target !== el) return false;
    const rect = el.getBoundingClientRect();
    return (
      e.clientX < rect.left ||
      e.clientX > rect.right ||
      e.clientY < rect.top ||
      e.clientY > rect.bottom
    );
  };

  const dismiss = (reason: OpenChangeReason, event?: Event): boolean => {
    const el = dialogEl();
    if (!el || !el.open) return false;
    const details = openChangeDetails(reason, event);
    options.onOpenChange()?.(false, details);
    if (details.canceled) return false;
    if (options.open() !== undefined) {
      options.onClose()?.("");
    } else {
      el.close();
    }
    return true;
  };

  return {
    dialogEl,
    setDialogEl,
    dismiss,
    onMouseDown: (e: MouseEvent) => {
      const el = dialogEl();
      downOutside = isOutside(e) && !(el && nestedOpen(el));
    },
    onClick: (e: MouseEvent) => {
      if (!HAS_CLOSEDBY && options.lightDismiss() && downOutside && isOutside(e)) {
        dismiss("outside-press", e);
      }
    },
  };
}
