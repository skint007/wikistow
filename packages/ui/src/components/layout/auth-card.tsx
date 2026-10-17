import type { ReactNode } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/** The centered card every signed-out page uses. */
export function AuthCard({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <main className="grid min-h-[calc(100svh-var(--titlebar-height))] place-items-center bg-background p-4">
      <div className="grid w-full max-w-sm gap-6">
        <p className="text-center text-2xl font-extrabold tracking-tight text-foreground">
          Wiki<span className="text-primary">Stow</span>
        </p>
        <Card className="rounded-card shadow-card">
          <CardHeader>
            <CardTitle as="h1" className="text-xl font-extrabold">
              {title}
            </CardTitle>
            {description && <CardDescription>{description}</CardDescription>}
          </CardHeader>
          <CardContent>{children}</CardContent>
        </Card>
      </div>
    </main>
  );
}

/** A form-level message: an error, or a notice such as "check your email". */
export function FormMessage({
  tone = 'error',
  children,
}: {
  tone?: 'error' | 'notice';
  children: ReactNode;
}) {
  return (
    <p
      role={tone === 'error' ? 'alert' : 'status'}
      className={tone === 'error' ? 'text-sm text-destructive' : 'text-sm text-muted-foreground'}
    >
      {children}
    </p>
  );
}
