/**
 * scopes: [frontend]
 * flags: []
 * description: shadcn/ui `cn()` helper — merges clsx + tailwind-merge for safe Tailwind class composition.
 */

/**
 * shadcn/ui cn() helper.
 *
 * Combines clsx (conditional joins) with tailwind-merge (last-wins conflict
 * resolution for Tailwind utility classes). Use this in every shadcn component
 * that accepts a `className` override:
 *
 *   <button className={cn('rounded px-3 py-2', className)} />
 *
 * Dependencies:
 *   npm install clsx tailwind-merge
 */

import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
