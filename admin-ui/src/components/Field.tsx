import type { ComponentChildren } from "preact";
import { useId } from "preact/hooks";

interface FieldProps {
  label: string;
  value: string;
  onValue(v: string): void;
  hint?: string;
  type?: "text" | "password";
  mono?: boolean;
  invalid?: boolean;
  required?: boolean;
  maxLength?: number;
  inputMode?: "text" | "numeric" | "url";
  autocomplete?: string;
  autocapitalize?: "off" | "none" | "sentences" | "words";
  spellcheck?: boolean;
  /** The element that gets focus when a dialog opens. */
  "data-autofocus"?: boolean;
  right?: ComponentChildren;
}

/** A labelled input; the label is tied to the input. */
export function Field({ label, value, onValue, hint, type = "text", mono, invalid, required, maxLength, inputMode, autocomplete, autocapitalize, spellcheck, right, ...rest }: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div class="field">
      <label class="field__label" for={id}>
        <span>{label}</span>
        {right}
      </label>
      <input
        id={id}
        type={type as "text"}
        class={`input${mono ? " input--mono" : ""}${invalid ? " is-invalid" : ""}`}
        value={value}
        required={required}
        maxLength={maxLength}
        inputMode={inputMode}
        autocomplete={autocomplete}
        autocapitalize={autocapitalize}
        spellcheck={spellcheck}
        data-autofocus={rest["data-autofocus"] ? "" : undefined}
        aria-describedby={hint ? hintId : undefined}
        aria-invalid={invalid ? true : undefined}
        onInput={(e) => onValue((e.currentTarget as HTMLInputElement).value)}
      />
      {hint ? (
        <div class="field__hint" id={hintId}>
          {hint}
        </div>
      ) : null}
    </div>
  );
}
