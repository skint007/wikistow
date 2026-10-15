import { cn } from '@/lib/utils';

const DOTS = ['[animation-delay:0ms]', '[animation-delay:150ms]', '[animation-delay:300ms]'];

/**
 * Says the assistant is working on a message, from the moment it's sent
 * until the reply ends, fails or is stopped. The live region stays mounted,
 * so screen readers hear it once as work starts; with reduced motion the
 * dots hold still.
 */
export function Working({ working }: { working: boolean }) {
  return (
    <p
      role="status"
      className={cn('flex items-center gap-2 text-xs text-muted-foreground', !working && 'sr-only')}
    >
      {working && (
        <>
          <span aria-hidden className="flex gap-1">
            {DOTS.map((delay) => (
              <span
                key={delay}
                className={cn(
                  'size-1.5 animate-bounce rounded-full bg-current motion-reduce:animate-none',
                  delay,
                )}
              />
            ))}
          </span>
          Assistant is working…
        </>
      )}
    </p>
  );
}
