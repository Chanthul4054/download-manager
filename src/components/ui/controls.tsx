// Checkbox, switch, radio, select, slider and label — Radix primitives in the OpenDM style.
import * as React from 'react';
import { Checkbox as CheckboxP, Switch as SwitchP, RadioGroup as RadioP, Select as SelectP, Slider as SliderP } from 'radix-ui';
import { Check, ChevronDown, Minus } from 'lucide-react';
import { cn } from '@/utils/cn';

export function Checkbox({ checked, onChange, className, ...props }: Omit<React.ComponentProps<typeof CheckboxP.Root>, 'checked' | 'onCheckedChange' | 'onChange'> & { checked: boolean | 'indeterminate'; onChange?: (v: boolean) => void }) {
  return (
    <CheckboxP.Root
      checked={checked}
      onCheckedChange={(v) => onChange?.(v === true)}
      onClick={(e) => e.stopPropagation()}
      className={cn(
        'peer grid size-3.5 shrink-0 place-items-center rounded-[4px] border border-line-strong bg-surface transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/40 data-[state=checked]:border-accent data-[state=checked]:bg-accent data-[state=indeterminate]:border-accent data-[state=indeterminate]:bg-accent text-accent-fg disabled:opacity-50',
        className,
      )}
      {...props}
    >
      <CheckboxP.Indicator>{checked === 'indeterminate' ? <Minus className="size-2.5" strokeWidth={3} /> : <Check className="size-2.5" strokeWidth={3.5} />}</CheckboxP.Indicator>
    </CheckboxP.Root>
  );
}

/** A checkbox with its label; the label text wraps. */
export function CheckField({ label, hint, checked, onChange, disabled }: { label: React.ReactNode; hint?: React.ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  const id = React.useId();
  return (
    <div className={cn('flex items-start gap-2', disabled && 'opacity-50')}>
      <Checkbox id={id} checked={checked} onChange={onChange} disabled={disabled} className="mt-[3px]" />
      <label htmlFor={id} className="min-w-0 text-sm leading-[1.4] text-fg">
        {label}
        {hint && <span className="mt-0.5 block text-xs text-fg-3">{hint}</span>}
      </label>
    </div>
  );
}

export function Switch({ checked, onChange, className, ...props }: Omit<React.ComponentProps<typeof SwitchP.Root>, 'checked' | 'onCheckedChange' | 'onChange'> & { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <SwitchP.Root
      checked={checked}
      onCheckedChange={onChange}
      className={cn('inline-flex h-[18px] w-[30px] shrink-0 items-center rounded-full border border-transparent bg-line-strong p-px transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/40 data-[state=checked]:bg-accent disabled:opacity-50', className)}
      {...props}
    >
      <SwitchP.Thumb className="block size-[14px] rounded-full bg-white shadow-[0_1px_2px_rgb(0_0_0/0.25)] transition-transform duration-150 data-[state=checked]:translate-x-3" />
    </SwitchP.Root>
  );
}

export function RadioGroup<T extends string>({ value, onChange, options, className }: { value: T; onChange: (v: T) => void; options: { value: T; label: React.ReactNode; hint?: React.ReactNode }[]; className?: string }) {
  return (
    <RadioP.Root value={value} onValueChange={(v) => onChange(v as T)} className={cn('flex flex-col gap-2.5', className)}>
      {options.map((o) => (
        <label key={o.value} className="flex cursor-default items-start gap-2 text-sm">
          <RadioP.Item value={o.value} className="mt-[2px] grid size-3.5 shrink-0 place-items-center rounded-full border border-line-strong bg-surface outline-none focus-visible:ring-3 focus-visible:ring-ring/40 data-[state=checked]:border-accent">
            <RadioP.Indicator className="size-1.5 rounded-full bg-accent" />
          </RadioP.Item>
          <span>
            {o.label}
            {o.hint && <span className="mt-0.5 block text-xs text-fg-3">{o.hint}</span>}
          </span>
        </label>
      ))}
    </RadioP.Root>
  );
}

export type Option<T extends string | number> = readonly [T, React.ReactNode] | { value: T; label: React.ReactNode };
const optValue = <T extends string | number>(o: Option<T>) => (Array.isArray(o) ? o[0] : (o as { value: T }).value);
const optLabel = <T extends string | number>(o: Option<T>) => (Array.isArray(o) ? o[1] : (o as { label: React.ReactNode }).label);

/** Select with typed values; numbers come back as numbers. */
export function Select<T extends string | number>({ value, onChange, options, className, disabled, placeholder, 'aria-label': ariaLabel }: { value: T; onChange: (v: T) => void; options: readonly Option<T>[]; className?: string; disabled?: boolean; placeholder?: string; 'aria-label'?: string }) {
  const isNum = typeof value === 'number';
  // Radix Select cannot hold "" as a value.
  const enc = (v: T) => (String(v) === '' ? '__empty' : String(v));
  const dec = (s: string) => (s === '__empty' ? '' : isNum ? Number(s) : s) as T;
  return (
    <SelectP.Root value={enc(value)} onValueChange={(s) => onChange(dec(s))} disabled={disabled}>
      <SelectP.Trigger
        aria-label={ariaLabel}
        className={cn(
          'inline-flex h-7 min-w-0 items-center justify-between gap-2 rounded-md border border-line-strong/80 bg-raised px-2 text-sm text-fg shadow-[0_1px_1px_rgb(0_0_0/0.04)] outline-none hover:bg-subtle focus-visible:ring-3 focus-visible:ring-ring/40 disabled:opacity-50 data-[placeholder]:text-fg-3',
          className,
        )}
      >
        <span className="truncate">
          <SelectP.Value placeholder={placeholder} />
        </span>
        <SelectP.Icon>
          <ChevronDown className="size-3.5 text-fg-3" />
        </SelectP.Icon>
      </SelectP.Trigger>
      <SelectP.Portal>
        <SelectP.Content position="popper" sideOffset={4} className="z-50 max-h-[min(var(--radix-select-content-available-height),22rem)] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-lg bg-raised p-1 shadow-pop animate-pop">
          <SelectP.Viewport>
            {options.map((o) => (
              <SelectP.Item
                key={String(optValue(o))}
                value={enc(optValue(o))}
                className="relative flex h-7 cursor-default items-center rounded-md pr-2 pl-6 text-sm text-fg outline-none select-none data-[highlighted]:bg-subtle data-[disabled]:opacity-50"
              >
                <SelectP.ItemIndicator className="absolute left-1.5">
                  <Check className="size-3.5 text-accent" />
                </SelectP.ItemIndicator>
                <SelectP.ItemText>{optLabel(o)}</SelectP.ItemText>
              </SelectP.Item>
            ))}
          </SelectP.Viewport>
        </SelectP.Content>
      </SelectP.Portal>
    </SelectP.Root>
  );
}

export function Slider({ value, onChange, min, max, step, className }: { value: number; onChange: (v: number) => void; min: number; max: number; step: number; className?: string }) {
  return (
    <SliderP.Root value={[value]} min={min} max={max} step={step} onValueChange={([v]) => onChange(v)} className={cn('relative flex h-4 w-40 touch-none items-center select-none', className)}>
      <SliderP.Track className="relative h-1 grow overflow-hidden rounded-full bg-muted">
        <SliderP.Range className="absolute h-full bg-accent" />
      </SliderP.Track>
      <SliderP.Thumb aria-label="Volume" className="block size-3.5 rounded-full border border-line-strong bg-white shadow outline-none focus-visible:ring-3 focus-visible:ring-ring/40" />
    </SliderP.Root>
  );
}

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn('text-sm font-medium text-fg', className)} {...props} />;
}

export function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
  return <kbd className={cn('inline-flex h-4 min-w-4 items-center justify-center rounded-[4px] border border-line bg-subtle px-1 font-sans text-2xs font-medium text-fg-3', className)}>{children}</kbd>;
}
