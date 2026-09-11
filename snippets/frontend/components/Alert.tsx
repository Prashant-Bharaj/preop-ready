/**
 * scopes: [frontend]
 * flags: []
 * description: shadcn/ui Alert — inline alert box with title/description parts.
 */

import * as React from 'react';
import { cn } from '../lib/utils.js';

export type AlertVariant = 'default' | 'destructive';

const variantClasses: Record<AlertVariant, string> = {
  default: 'bg-white text-slate-950',
  destructive:
    'border-red-500/50 text-red-600 [&>svg]:text-red-600',
};

export interface AlertProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: AlertVariant;
}

export const Alert = React.forwardRef<HTMLDivElement, AlertProps>(
  ({ className, variant = 'default', ...props }, ref) => (
    <div
      ref={ref}
      role="alert"
      className={cn(
        'relative w-full rounded-lg border border-slate-200 p-4 [&>svg~*]:pl-7 [&>svg+div]:translate-y-[-3px] [&>svg]:absolute [&>svg]:left-4 [&>svg]:top-4 [&>svg]:text-slate-950',
        variantClasses[variant],
        className
      )}
      {...props}
    />
  )
);
Alert.displayName = 'Alert';

export const AlertTitle = React.forwardRef<
  HTMLHeadingElement,
  React.HTMLAttributes<HTMLHeadingElement>
>(({ className, ...props }, ref) => (
  <h5
    ref={ref}
    className={cn('mb-1 font-medium leading-none tracking-tight', className)}
    {...props}
  />
));
AlertTitle.displayName = 'AlertTitle';

export const AlertDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn('text-sm [&_p]:leading-relaxed', className)}
    {...props}
  />
));
AlertDescription.displayName = 'AlertDescription';
