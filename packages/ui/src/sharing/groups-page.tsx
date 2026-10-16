import type { SpaceId } from '@wikistow/client';
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';

/** The page card the Groups pages share: a way back, the heading, then the rest. */
export function GroupsPage({
  title,
  about,
  spaceId,
  back,
  actions,
  children,
}: {
  title: ReactNode;
  about: ReactNode;
  spaceId: SpaceId;
  back: { to: '/s/$spaceId/members' | '/s/$spaceId/groups'; label: string };
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="h-full min-h-0 overflow-y-auto rounded-card bg-card shadow-card">
      <div className="mx-auto grid w-full max-w-[720px] gap-6 px-11 py-10 max-[899px]:px-[18px] max-[899px]:py-8">
        <header className="grid gap-1">
          <Link
            to={back.to}
            params={{ spaceId }}
            className="text-sm font-bold text-primary-ink hover:underline"
          >
            ← {back.label}
          </Link>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="flex-1 text-[32px] leading-tight font-extrabold">{title}</h1>
            {actions}
          </div>
          <p className="text-sm text-muted-foreground">{about}</p>
        </header>
        {children}
      </div>
    </section>
  );
}
