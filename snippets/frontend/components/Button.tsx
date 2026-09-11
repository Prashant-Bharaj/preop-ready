/**
 * scopes: [frontend]
 * flags: []
 * description: shadcn/ui Button — accessible button primitive with size + variant + asChild.
 */

import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cn } from '../lib/utils.js';

export type ButtonVariant =
  | 'default'
  | 'destructive'
  | 'outline'
  | 'secondary'
  | 'ghost'
  | 'link';

export type ButtonSize = 'default' | 'sm' | 'lg' | 'icon';

const variantClasses: Record<ButtonVariant, string> = {
  default:
    'bg-slate-900 text-slate-50 hover:bg-slate-900/90',
  destructive: 'bg-red-600 text-slate-50 hover:bg-red-600/90',
  outline:
    'border border-slate-200 bg-white hover:bg-slate-100 hover:text-slate-900',
  secondary: 'bg-slate-100 text-slate-900 hover:bg-slate-100/80',
  ghost: 'hover:bg-slate-100 hover:text-slate-900',
  link: 'text-slate-900 underline-offset-4 hover:underline',
};

const sizeClasses: Record<ButtonSize, string> = {
  default: 'h-10 px-4 py-2',
  sm: 'h-9 rounded-md px-3',
  lg: 'h-11 rounded-md px-8',
  icon: 'h-10 w-10',
};

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** If true, renders the child element (e.g. an `<a>`) instead of a `<button>`. */
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    { className, variant = 'default', size = 'default', asChild = false, ...props },
    ref
  ) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        ref={ref}
        className={cn(
          'inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-950 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50',
          variantClasses[variant],
          sizeClasses[size],
          className
        )}
        {...props}
      />
    );
  }
);
Button.displayName = 'Button';
