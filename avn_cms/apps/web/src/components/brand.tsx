import { cn } from '@/lib/cn';

/** aVn CMS wordmark. The external LeadXP service is never branded here. */
export function Brand({ className, compact = false }: { className?: string; compact?: boolean }) {
  return (
    <span
      className={cn('inline-flex items-center gap-2 font-semibold tracking-tight text-foreground', className)}
    >
      <span
        aria-hidden
        className="grid size-8 place-items-center rounded-lg bg-primary text-[13px] font-bold text-primary-foreground shadow-card"
      >
        aVn
      </span>
      {!compact && (
        <span className="text-[15px]">
          aVn <span className="font-medium text-muted-foreground">CMS</span>
        </span>
      )}
    </span>
  );
}
