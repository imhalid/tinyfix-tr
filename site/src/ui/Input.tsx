import { Show, omit } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Svg, applyRefValue, callHandler, useFieldContext, type Size } from "./lib";

export interface InputProps
  extends Omit<JSX.InputHTMLAttributes<HTMLInputElement>, "size" | "prefix"> {
  size?: Size;
  prefix?: JSX.Element;
  suffix?: JSX.Element;
  clearable?: boolean;
  onClear?: () => void;
}

function nativeSetValue(el: HTMLInputElement, value: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  descriptor?.set?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

export function Input(props: InputProps) {
  const field = useFieldContext();
  const rest = omit(
    props,
    "size",
    "prefix",
    "suffix",
    "clearable",
    "onClear",
    "class",
    "style",
    "ref",
    "id",
    "placeholder",
    "onKeyDown",
    "onBlur",
    "aria-describedby",
    "aria-invalid",
    "aria-labelledby",
    "aria-keyshortcuts",
  );

  let inputEl: HTMLInputElement | undefined;
  let boxEl: HTMLDivElement | undefined;

  const isAffixed = () =>
    props.prefix != null || props.suffix != null || Boolean(props.clearable);

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

  const canClear = () =>
    Boolean(props.clearable) && !props.disabled && !props.readonly;

  const clear = () => {
    if (!inputEl) return;
    nativeSetValue(inputEl, "");
    props.onClear?.();
    inputEl.focus();
  };

  const setInputRef = (el: HTMLInputElement) => {
    inputEl = el;
    applyRefValue(props.ref, el);
  };

  const handleKeyDown: JSX.EventHandler<HTMLInputElement, KeyboardEvent> = (e) => {
    callHandler(props.onKeyDown, e);
    if (e.key !== "Escape" || e.defaultPrevented || e.isComposing) return;
    if (!canClear() || e.currentTarget.value === "") return;
    e.preventDefault();
    e.stopPropagation();
    clear();
  };

  const shortcuts = () => {
    if (!canClear()) return props["aria-keyshortcuts"];
    return [props["aria-keyshortcuts"], "Escape"].filter(Boolean).join(" ");
  };

  return (
    <Show
      when={isAffixed()}
      fallback={
        <input
          {...rest}
          ref={setInputRef}
          id={inputId()}
          placeholder={props.placeholder}
          aria-labelledby={labelledBy()}
          aria-describedby={describedBy()}
          aria-invalid={invalidAttr()}
          aria-keyshortcuts={props["aria-keyshortcuts"]}
          class={["input", props.class]}
          style={props.style}
          data-size={props.size}
          onBlur={props.onBlur}
          onKeyDown={props.onKeyDown}
        />
      }
    >
      <div
        ref={(el) => {
          boxEl = el;
        }}
        class={["input", "affixed", { disabled: Boolean(props.disabled) }, props.class]}
        style={props.style}
        data-size={props.size}
        onPointerDown={(e) => {
          if (e.target === e.currentTarget) {
            e.preventDefault();
            inputEl?.focus();
          }
        }}
      >
        <Show when={props.prefix != null}>
          <span class="input-adorn">{props.prefix}</span>
        </Show>
        <input
          {...rest}
          ref={setInputRef}
          id={inputId()}
          class="input-el"
          placeholder={props.clearable ? (props.placeholder ?? " ") : props.placeholder}
          aria-labelledby={labelledBy()}
          aria-describedby={describedBy()}
          aria-invalid={invalidAttr()}
          aria-keyshortcuts={shortcuts()}
          onBlur={(e) => {
            if (!boxEl?.contains(e.relatedTarget as Node | null)) {
              callHandler(props.onBlur, e);
            }
          }}
          onKeyDown={handleKeyDown}
        />
        <Show when={canClear()}>
          <button
            type="button"
            class="input-btn input-clear"
            aria-label="Temizle"
            tabindex={-1}
            form={props.form}
            onMouseDown={(e) => e.preventDefault()}
            onClick={clear}
          >
            <Svg viewBox="0 0 16 16" width={12} height={12}>
              <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
            </Svg>
          </button>
        </Show>
        <Show when={props.suffix != null}>
          <span class="input-adorn">{props.suffix}</span>
        </Show>
      </div>
    </Show>
  );
}
