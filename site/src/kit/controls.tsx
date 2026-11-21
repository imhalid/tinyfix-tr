import type { JSX } from "@solidjs/web";
import { For } from "solid-js";

let uid = 0;
const nextId = (prefix: string) => `${prefix}-${++uid}`;

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  description?: JSX.Element;
}

/** Açık/kapalı anahtar: yerel checkbox, `role="switch"`; etiket ve açıklama tıklanabilir. */
export function Switch(props: SwitchProps) {
  const id = nextId("switch");
  return (
    <label class="switch-row" for={id}>
      <span class="switch-text">
        <span class="switch-label">{props.label}</span>
        {props.description ? <span class="switch-description">{props.description}</span> : null}
      </span>
      <input
        id={id}
        type="checkbox"
        role="switch"
        class="switch"
        checked={props.checked}
        onChange={(event) => props.onChange(event.currentTarget.checked)}
      />
    </label>
  );
}

export interface ChoiceOption<T extends string> {
  value: T;
  label: string;
}

export interface ChoiceProps<T extends string> {
  label: string;
  options: readonly ChoiceOption<T>[];
  value: T;
  onChange: (value: T) => void;
}

/** Yan yana birkaç seçenekten biri: yerel radyo grubu, sade bir ray görünümünde. */
export function Choice<T extends string>(props: ChoiceProps<T>) {
  const name = nextId("choice");
  return (
    <div class="choice" role="radiogroup" aria-label={props.label}>
      <For each={props.options}>
        {(option) => (
          <label class="choice-option">
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={props.value === option.value}
              onChange={() => props.onChange(option.value)}
            />
            <span>{option.label}</span>
          </label>
        )}
      </For>
    </div>
  );
}
