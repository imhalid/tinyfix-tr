import { Show, createUniqueId, omit } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Button } from "./Button";
import { createDialogController } from "./dialog-core";
import { XIcon, applyRefValue, callHandler, type OnOpenChange } from "./lib";

export interface DialogProps
  extends Omit<
    JSX.DialogHtmlAttributes<HTMLDialogElement>,
    "open" | "title" | "onClose" | "role"
  > {
  open?: boolean;
  onClose?: (returnValue: string) => void;
  onOpenChange?: OnOpenChange;
  role?: "dialog" | "alertdialog";
  title: JSX.Element;
  description?: JSX.Element;
  footer?: JSX.Element;
  modal?: boolean;
  lightDismiss?: boolean;
  children?: JSX.Element;
}

export function Dialog(props: DialogProps) {
  const uid = createUniqueId();
  const rest = omit(
    props,
    "open",
    "onClose",
    "onOpenChange",
    "role",
    "title",
    "description",
    "footer",
    "modal",
    "lightDismiss",
    "class",
    "children",
    "ref",
    "id",
    "onMouseDown",
    "onClick",
  );

  const isAlert = () => props.role === "alertdialog";
  const isModal = () => props.modal ?? true;
  const dismissible = () => !isAlert() && (props.lightDismiss ?? isModal());

  const dialog = createDialogController({
    open: () => props.open,
    onClose: () => props.onClose,
    onOpenChange: () => props.onOpenChange,
    lightDismiss: dismissible,
    modal: isModal,
  });

  return (
    <dialog
      {...rest}
      ref={(el) => {
        dialog.setDialogEl(el);
        applyRefValue(props.ref, el);
      }}
      id={props.id ?? `${uid}dlg`}
      role={isAlert() ? "alertdialog" : undefined}
      class={["dialog", props.class]}
      closedby={dismissible() ? "any" : "closerequest"}
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
      <header>
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
      <Show when={props.children}>
        <div class="body">{props.children}</div>
      </Show>
      <Show when={props.footer}>
        <footer>
          <form method="dialog">{props.footer}</form>
        </footer>
      </Show>
    </dialog>
  );
}
