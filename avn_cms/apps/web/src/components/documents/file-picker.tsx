'use client';

import { DOCUMENT_ACCEPT } from '@avn-cms/core/schemas';
import { Loader2, Upload } from 'lucide-react';

import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/cn';

/**
 * A button that opens the file chooser. The real <input type="file"> is visually hidden but stays
 * focusable and named, so keyboard and screen-reader users can use it.
 * The label is `relative` so the hidden input stays inside it: an absolutely positioned input with no
 * positioned ancestor escapes a scrolling table and makes the whole page scroll sideways on a phone.
 */
export function FilePicker({
  label,
  ariaLabel,
  onPick,
  busy = false,
  disabled = false,
  variant = 'secondary',
}: {
  label: string;
  /** Must start with the visible label (WCAG: the name contains the visible text). */
  ariaLabel?: string;
  onPick: (file: File) => void;
  busy?: boolean;
  disabled?: boolean;
  variant?: 'primary' | 'secondary' | 'ghost';
}) {
  return (
    <label
      className={cn(
        buttonVariants({ variant, size: 'sm' }),
        'relative cursor-pointer focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring',
        (disabled || busy) && 'pointer-events-none opacity-50',
      )}
    >
      <input
        type="file"
        accept={DOCUMENT_ACCEPT}
        aria-label={ariaLabel ?? label}
        disabled={disabled || busy}
        className="sr-only"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = ''; // choosing the same file again must still fire
          if (file) onPick(file);
        }}
      />
      {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Upload aria-hidden />}
      {label}
    </label>
  );
}
