import { Show, omit } from "solid-js";
import type { JSX } from "@solidjs/web";
import { applyRefValue, callHandler, useFieldContext } from "./lib";

export interface SwitchProps
  extends Omit<
    JSX.InputHTMLAttributes<HTMLInputElement>,
    "type" | "checked" | "defaultChecked" | "onChange" | "size"
  > {
  checked?: boolean;
  defaultChecked?: boolean;
  onChange?: (checked: boolean) => void;
  label?: JSX.Element;
  description?: JSX.Element;
}

/** Anında etkili açık/kapalı anahtarı (role="switch", mizan .switch + .check-row). */
export function Switch(props: SwitchProps) {
  const field = useFieldContext();
  const rest = omit(
    props,
    "checked",
    "defaultChecked",
    "onChange",
    "label",
    "description",
    "class",
    "ref",
    "id",
    "readonly",
    "onClick",
    "onInput",
    "aria-label",
    "aria-labelledby",
    "aria-describedby",
    "aria-invalid",
  );

  const inputId = () => props.id ?? field?.id();
  const labelledBy = () =>
    props["aria-labelledby"] ??
    (field && props.id && props.id !== field.id() ? field.labelId() : undefined);
  const describedBy = () => {
    const parts = [props["aria-describedby"], field?.describedBy()].filter(Boolean);
    return parts.length > 0 ? parts.join(" ") : undefined;
  };
  const invalidAttr = () =>
    props["aria-invalid"] ?? (field?.invalid() ? "true" : undefined);

  const renderInput = (standalone: boolean) => (
    <input
      {...rest}
      ref={(el) => {
        // Safari 17.4+ yerel anahtar özniteliği; tanımayan tarayıcıda yok sayılır.
        el.setAttribute("switch", "");
        applyRefValue(props.ref, el);
      }}
      id={inputId()}
      type="checkbox"
      role="switch"
      class={standalone ? ["switch", props.class] : "switch"}
      checked={props.checked}
      defaultChecked={props.checked === undefined ? Boolean(props.defaultChecked) : undefined}
      aria-readonly={props.readonly ? "true" : undefined}
      aria-label={props.label ? undefined : props["aria-label"]}
      aria-labelledby={labelledBy()}
      aria-describedby={describedBy()}
      aria-invalid={invalidAttr()}
      onClick={(e) => {
        if (props.readonly) e.preventDefault();
        callHandler(props.onClick, e);
      }}
      onInput={(e) => {
        if (!props.readonly) {
          props.onChange?.(e.currentTarget.checked);
        }
        callHandler(props.onInput, e);
      }}
    />
  );

  return (
    <Show when={props.label != null} fallback={renderInput(true)}>
      <label class={["check-row", props.class]}>
        {renderInput(false)}
        <span>
          {props.label}
          <Show when={props.description != null}>
            <small>{props.description}</small>
          </Show>
        </span>
      </label>
    </Show>
  );
}
