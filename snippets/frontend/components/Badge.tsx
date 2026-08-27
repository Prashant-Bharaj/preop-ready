/**
 * scopes: [frontend]
 * flags: []
 * description: shadcn/ui Badge — small inline status pill with variants.
 */

import * as React from 'react';
import { cn } from '../lib/utils.js';

export type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline';

const variantClasses: Record<BadgeVariant, string> = {
  default:
    'border-transparent bg-slate-900 text-slate-50 hover:bg-slate-900/80',
  secondary:
    'border-transparent bg-slate-100 text-slate-900 hover:bg-slate-100/80',
  destructive:
    'border-transparent bg-red-600 text-slate-50 hover:bg-red-600/80',
  outline: 'text-slate-950',
};

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: BadgeVariant;
}

export function Badge({
  className,
  variant = 'default',
  ...props
}: BadgeProps): React.JSX.Element {
  return (
    <div
      className={cn(
        'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-slate-950 focus:ring-offset-2',
        variantClasses[variant],
        className
      )}
      {...props}
    />
  );
}
