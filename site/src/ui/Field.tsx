import { Show, createUniqueId, omit } from "solid-js";
import type { JSX } from "@solidjs/web";
import { FieldContext, type FieldCtx } from "./lib";

export interface FieldProps extends Omit<JSX.HTMLAttributes<HTMLDivElement>, "id"> {
  label: JSX.Element;
  children: JSX.Element;
  hint?: JSX.Element;
  error?: JSX.Element;
  invalid?: boolean;
  id?: string;
}

export function Field(props: FieldProps) {
  const uid = createUniqueId();
  const rest = omit(props, "label", "children", "hint", "error", "invalid", "id", "class");

  const controlId = () => props.id ?? `${uid}c`;
  const labelId = `${uid}l`;
  const hintId = `${uid}h`;
  const errorId = `${uid}e`;

  const ctx: FieldCtx = {
    id: controlId,
    labelId: () => labelId,
    describedBy: () => {
      if (props.invalid && props.error) return errorId;
      if (props.hint) return hintId;
      return undefined;
    },
    invalid: () => Boolean(props.invalid),
  };

  return (
    <div {...rest} class={["field", props.class]}>
      <label class="field-label" id={labelId} for={controlId()}>
        {props.label}
      </label>
      <FieldContext value={ctx}>{props.children}</FieldContext>
      <Show when={props.hint}>
        <small class="hint" id={hintId}>
          {props.hint}
        </small>
      </Show>
      <Show when={props.error}>
        <small class="error" id={errorId} role="alert">
          {props.error}
        </small>
      </Show>
    </div>
  );
}
