/**
 * scopes: [frontend]
 * flags: []
 * description: shadcn/ui Label — Radix-based label primitive with peer-disabled styling.
 */

import * as React from 'react';
import * as LabelPrimitive from '@radix-ui/react-label';
import { cn } from '../lib/utils.js';

export const Label = React.forwardRef<
  React.ElementRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root>
>(({ className, ...props }, ref) => (
  <LabelPrimitive.Root
    ref={ref}
    className={cn(
      'text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70',
      className
    )}
    {...props}
  />
));
Label.displayName = LabelPrimitive.Root.displayName;
