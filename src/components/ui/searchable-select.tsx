"use client";

import * as Popover from "@radix-ui/react-popover";
import { Check, ChevronDown } from "lucide-react";
import { Children, isValidElement, useEffect, useId, useRef, useState, type ComponentPropsWithRef, type KeyboardEvent, type ReactNode } from "react";
import { optionMatches } from "@/lib/option-search";
import { useI18n } from "@/i18n/provider";
import { cn } from "@/lib/utils";

type OptionProps = { value?: string | number; label?: string; disabled?: boolean; children?: ReactNode };

function readOptions(children: ReactNode) {
  return Children.toArray(children).flatMap((child) => {
    if (!isValidElement<OptionProps>(child) || child.type !== "option") return [];
    const text = Children.toArray(child.props.children).join("").trim();
    return [{ label: child.props.label ?? text, value: String(child.props.value ?? text), disabled: child.props.disabled }];
  });
}

function selectedValues(select: HTMLSelectElement) {
  return Array.from(select.selectedOptions, (option) => option.value);
}

export function Select({
  children, className, id, dir, title, tabIndex, ref, value, defaultValue, disabled, multiple, required, onChange, onBlur, onInvalid,
  "aria-label": ariaLabel, "aria-labelledby": labelledBy, "aria-describedby": describedBy, "aria-invalid": invalid,
  ...props
}: ComponentPropsWithRef<"select">) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const [selection, setSelection] = useState<string[]>();
  const [validationError, setValidationError] = useState(false);
  const selectRef = useRef<HTMLSelectElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const errorId = `${listId}-error`;
  const options = readOptions(children);
  const initialValue = value ?? defaultValue;
  const currentValues = value === undefined && selection ? selection
    : Array.isArray(initialValue) ? initialValue.map(String)
    : initialValue === undefined ? [] : [String(initialValue)];
  const values = new Set(currentValues);
  const chosen = options.filter((option) => values.has(option.value));
  const singleOption = chosen[0] ?? options.find((option) => !option.disabled);
  const visibleValue = multiple ? chosen.map((option) => option.label).join(locale === "fa-IR" ? "، " : ", ")
    : singleOption?.label;
  const matches = optionMatches(query);
  const filtered = open ? options.map((option, index) => ({ ...option, index }))
    .filter((option) => matches(`${option.label} ${option.value}`)) : [];
  const enabled = filtered.filter((option) => !option.disabled);
  const active = enabled[activeIndex];

  useEffect(() => {
    const select = selectRef.current;
    const form = select?.form;
    if (!select || !form || value !== undefined) return;
    const reset = () => queueMicrotask(() => {
      setSelection(selectedValues(select));
      setValidationError(false);
    });
    form.addEventListener("reset", reset);
    return () => form.removeEventListener("reset", reset);
  }, [props.form, value]);

  function changeOpen(next: boolean) {
    setOpen(next);
    if (next) {
      setQuery("");
      setActiveIndex(-1);
    }
  }

  function choose(index: number) {
    const select = selectRef.current;
    if (!select || select.matches(":disabled")) return;
    if (multiple) select.options[index].selected = !select.options[index].selected;
    else select.selectedIndex = index;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    if (!multiple) setOpen(false);
  }

  function navigate(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      const option = active ?? enabled[0];
      if (option) choose(option.index);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!enabled.length) return;
      const offset = event.key === "ArrowDown" ? 1 : -1;
      const next = active ? (activeIndex + offset + enabled.length) % enabled.length : offset === 1 ? 0 : enabled.length - 1;
      setActiveIndex(next);
      document.getElementById(`${listId}-${enabled[next].index}`)?.scrollIntoView({ block: "nearest" });
    }
  }

  return <span className="relative block min-w-0">
    <Popover.Root open={open && !disabled} onOpenChange={changeOpen}>
      <Popover.Trigger ref={triggerRef} type="button" id={id} dir={dir} title={title} tabIndex={tabIndex} disabled={disabled}
        aria-label={ariaLabel} aria-labelledby={labelledBy}
        aria-describedby={validationError ? [describedBy, errorId].filter(Boolean).join(" ") : describedBy}
        aria-invalid={validationError || invalid}
        onBlur={(event) => {
          if (onBlur && !open) selectRef.current?.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: event.relatedTarget }));
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            changeOpen(true);
          }
        }}
        className={cn("flex h-10 w-full min-w-0 items-center justify-between gap-2 rounded-lg border border-border bg-card px-3 text-start text-sm outline-none focus:ring-2 focus:ring-ring disabled:opacity-50", validationError && "border-destructive", className)}>
        <span className="truncate" dir="auto">{visibleValue || t("common.selectOption")}</span>
        <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content aria-label={t("common.selectOption")} dir={dir} align="start" sideOffset={4} collisionPadding={8}
          className="z-[60] flex max-h-[var(--radix-popover-content-available-height)] w-[var(--radix-popover-trigger-width)] min-w-48 max-w-[calc(100vw-1rem)] flex-col overflow-hidden rounded-lg border border-border bg-card p-1.5 shadow-lg">
          <input type="text" role="combobox" aria-expanded="true" aria-autocomplete="list" aria-controls={listId}
            aria-activedescendant={active ? `${listId}-${active.index}` : undefined} aria-label={t("common.searchOptions")}
            placeholder={t("common.searchOptions")} dir="auto" value={query} onChange={(event) => { setQuery(event.target.value); setActiveIndex(-1); }}
            onKeyDownCapture={(event) => {
              if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey) return;
              // Resume native tab order from the trigger instead of cycling inside the popup.
              event.stopPropagation();
              triggerRef.current?.focus();
              setOpen(false);
            }}
            onKeyDown={navigate} className="h-9 w-full shrink-0 rounded-md border border-border bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-inset focus:ring-ring" />
          <div id={listId} role="listbox" aria-label={t("common.options")} aria-multiselectable={multiple} aria-required={required}
            className="mt-1 max-h-64 min-h-0 overflow-y-auto overscroll-contain">
            {filtered.map((option) => {
              const selected = multiple ? values.has(option.value) : singleOption === options[option.index];
              return <div key={option.index} id={`${listId}-${option.index}`} role="option" aria-selected={selected} aria-disabled={option.disabled}
                onMouseDown={(event) => event.preventDefault()} onClick={() => { if (!option.disabled) choose(option.index); }}
                className={cn("flex items-center gap-2 rounded-md px-2 py-2 text-sm", option.disabled ? "opacity-50" : "cursor-pointer hover:bg-muted", active?.index === option.index && "bg-muted")}>
                <Check aria-hidden="true" className={cn("size-4 shrink-0 text-primary", !selected && "invisible")} />
                <span dir="auto">{option.label}</span>
              </div>;
            })}
          </div>
          {!filtered.length && <p role="status" className="px-2 py-3 text-sm text-muted-foreground">{t("common.noOptions")}</p>}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
    {/* Keep native form submission, validation, and registered refs. */}
    <select {...props} ref={(element) => {
      selectRef.current = element;
      if (typeof ref === "function") return ref(element);
      if (ref) ref.current = element;
    }} value={value} defaultValue={defaultValue} multiple={multiple} disabled={disabled} required={required}
      aria-hidden="true" tabIndex={-1} className="pointer-events-none absolute inset-0 size-full opacity-0"
      onBlur={onBlur}
      onFocus={() => triggerRef.current?.focus()}
      onInvalid={(event) => {
        onInvalid?.(event);
        setValidationError(true);
      }}
      onChange={(event) => {
        if (value === undefined) setSelection(selectedValues(event.currentTarget));
        if (event.currentTarget.validity.valid) setValidationError(false);
        onChange?.(event);
      }}>{children}</select>
    {validationError && <span id={errorId} role="alert" className="mt-1 block text-xs text-destructive">{t("common.chooseOption")}</span>}
  </span>;
}
