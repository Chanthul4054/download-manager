import * as React from 'react';
import { Slot } from 'radix-ui';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/utils/cn';

const buttonVariants = cva(
  'inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-[background-color,color,border-color,box-shadow] duration-100 select-none disabled:pointer-events-none disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary: 'bg-accent text-accent-fg shadow-[inset_0_1px_0_rgb(255_255_255/0.12)] hover:bg-accent-hover',
        secondary: 'border border-line-strong/80 bg-raised text-fg shadow-[0_1px_1px_rgb(0_0_0/0.04)] hover:bg-subtle',
        ghost: 'text-fg-2 hover:bg-subtle hover:text-fg data-[state=open]:bg-subtle data-[state=open]:text-fg',
        danger: 'bg-danger text-white hover:bg-danger/90',
        'danger-ghost': 'text-danger hover:bg-danger-soft',
        link: 'text-accent hover:underline underline-offset-2 px-0 h-auto',
      },
      size: {
        sm: 'h-6 px-2 text-xs [&_svg]:size-3.5',
        md: 'h-7 px-2.5 text-sm [&_svg]:size-4',
        lg: 'h-8 px-3.5 text-base [&_svg]:size-4',
        icon: 'size-7 [&_svg]:size-4',
        'icon-sm': 'size-6 rounded-sm [&_svg]:size-3.5',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, asChild, type = 'button', ...props }, ref) => {
  const Comp = asChild ? Slot.Root : 'button';
  return <Comp ref={ref} type={asChild ? undefined : type} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
});
Button.displayName = 'Button';
