import { Show, createUniqueId, omit } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Button } from "./Button";
import { createDialogController, nestedOpen } from "./dialog-core";
import { XIcon, applyRefValue, callHandler, type OnOpenChange } from "./lib";

export interface SheetProps
  extends Omit<JSX.DialogHtmlAttributes<HTMLDialogElement>, "open" | "title" | "onClose"> {
  open?: boolean;
  onClose?: (returnValue: string) => void;
  onOpenChange?: OnOpenChange;
  title: JSX.Element;
  description?: JSX.Element;
  /** end: sağdan · start: soldan · bottom: alttan · auto: masaüstünde sağdan, telefonda alttan. */
  side?: "end" | "start" | "bottom" | "auto";
  footer?: JSX.Element;
  children?: JSX.Element;
}

const FLING_VELOCITY = 0.11;
const PAST_RATIO = 0.4;

export function Sheet(props: SheetProps) {
  const uid = createUniqueId();
  const rest = omit(
    props,
    "open",
    "onClose",
    "onOpenChange",
    "title",
    "description",
    "side",
    "footer",
    "class",
    "children",
    "ref",
    "id",
    "onMouseDown",
    "onClick",
  );

  const side = () => props.side ?? "auto";
  const dialog = createDialogController({
    open: () => props.open,
    onClose: () => props.onClose,
    onOpenChange: () => props.onOpenChange,
    lightDismiss: () => true,
    modal: () => true,
  });

  let drag: { y: number; t: number; dy: number } | null = null;

  const onPointerDown: JSX.EventHandler<HTMLElement, PointerEvent> = (e) => {
    const el = dialog.dialogEl();
    const grip = el?.querySelector<HTMLElement>(".grip");
    if (
      !el ||
      !grip ||
      getComputedStyle(grip).display === "none" ||
      (e.target as Element).closest("button")
    ) {
      return;
    }
    if (nestedOpen(el)) {
      el.querySelectorAll<HTMLElement>(":popover-open").forEach((pop) => pop.hidePopover?.());
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    drag = { y: e.clientY, t: e.timeStamp, dy: 0 };
    el.toggleAttribute("data-dragging", true);
  };

  const onPointerMove: JSX.EventHandler<HTMLElement, PointerEvent> = (e) => {
    const el = dialog.dialogEl();
    if (!drag || !el) return;
    const dy = e.clientY - drag.y;
    drag.dy = dy;
    const clamped = dy >= 0 ? dy : -Math.sqrt(-dy);
    el.style.setProperty("--drag", `${clamped}px`);
  };

  const onPointerUp: JSX.EventHandler<HTMLElement, PointerEvent> = (e) => {
    const current = drag;
    const el = dialog.dialogEl();
    drag = null;
    if (!current || !el) return;
    const height = Math.max(1, el.offsetHeight);
    const velocity = current.dy / Math.max(1, e.timeStamp - current.t);
    const shouldClose = velocity > FLING_VELOCITY || current.dy / height > PAST_RATIO;
    el.removeAttribute("data-dragging");
    if (shouldClose) {
      dialog.dismiss("close-press", e);
    }
    el.style.removeProperty("--drag");
  };

  return (
    <dialog
      {...rest}
      ref={(el) => {
        dialog.setDialogEl(el);
        applyRefValue(props.ref, el);
      }}
      id={props.id ?? `${uid}dlg`}
      class={["sheet", side() !== "end" && side(), props.class]}
      closedby="any"
      aria-labelledby={`${uid}t`}
      aria-describedby={props.description ? `${uid}d` : undefined}
      onMouseDown={(e) => {
        dialog.onMouseDown(e);
        callHandler(props.onMouseDown, e);
      }}
      onClick={(e) => {
        dialog.onClick(e);
        callHandler(props.onClick, e);
      }}
    >
      <header
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div class="titles">
          <h2 id={`${uid}t`}>{props.title}</h2>
          <Show when={props.description}>
            <div class="desc" id={`${uid}d`}>
              {props.description}
            </div>
          </Show>
        </div>
        <form method="dialog">
          <Button type="submit" icon class="close" aria-label="Kapat">
            <XIcon />
          </Button>
        </form>
      </header>
      <div
        class="grip"
        aria-hidden="true"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      />
      <div class="body">{props.children}</div>
      <Show when={props.footer}>
        <footer>
          <form method="dialog">{props.footer}</form>
        </footer>
      </Show>
    </dialog>
  );
}
