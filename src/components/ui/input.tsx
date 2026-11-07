import * as React from 'react';
import { cn } from '@/utils/cn';

const field =
  'w-full min-w-0 rounded-md border border-line-strong/80 bg-surface px-2 text-sm text-fg placeholder:text-fg-3 shadow-[inset_0_1px_1px_rgb(0_0_0/0.03)] transition-[border-color,box-shadow] outline-none focus:border-accent focus:ring-3 focus:ring-ring/40 disabled:opacity-50 aria-invalid:border-danger';

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(({ className, type = 'text', ...props }, ref) => (
  <input ref={ref} type={type} spellCheck={false} className={cn(field, 'h-7', type === 'number' && 'tnum', className)} {...props} />
));
Input.displayName = 'Input';

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...props }, ref) => (
  <textarea ref={ref} spellCheck={false} className={cn(field, 'min-h-16 resize-y py-1.5 leading-relaxed', className)} {...props} />
));
Textarea.displayName = 'Textarea';

/** A number field that keeps the value a number. */
export function NumberInput({ value, onValue, className, ...props }: Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'> & { value: number; onValue: (n: number) => void }) {
  return <Input type="number" value={Number.isFinite(value) ? value : ''} onChange={(e) => onValue(Number(e.target.value))} className={cn('w-20', className)} {...props} />;
}
