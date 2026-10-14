import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_app/_vault/s/$spaceId/')({ component: Empty });

function Empty() {
  return (
    <section className="grid h-full place-items-center rounded-card bg-card p-8 text-center shadow-card">
      <div className="grid max-w-sm gap-2">
        <h1 className="text-xl font-extrabold">Pick a page</h1>
        <p className="text-sm text-muted-foreground">
          Choose a page from the list, or start a new one with New page.
        </p>
      </div>
    </section>
  );
}
