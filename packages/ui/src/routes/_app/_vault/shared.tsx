import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { Folder, Library } from 'lucide-react';
import { Name } from '@/components/name';
import { sharedWithMeQuery } from '../../../data/queries';
import { sharingMessage } from '../../../sharing/messages';
import { ACCESS_LABELS, accessOf } from '../../../sharing/model';
import { nameOf } from '../../../sharing/names';
import { useClient } from '../../../vault/store';

export const Route = createFileRoute('/_app/_vault/shared')({ component: SharedWithMe });

/**
 * Shared with me (protocol section 7.7): each folder or space someone shared
 * with this person, by its own name and who shared it. Nothing above a
 * shared folder is named, because nothing above it was shared.
 */
function SharedWithMe() {
  const ctx = useClient();
  const { data: items, error } = useQuery(sharedWithMeQuery(ctx));
  return (
    <section className="h-full min-h-0 overflow-y-auto rounded-card bg-card shadow-card">
      <div className="mx-auto grid w-full max-w-[720px] gap-6 px-11 py-10 max-[899px]:px-[18px] max-[899px]:py-8">
        <header className="grid gap-1">
          <h1 className="text-[32px] leading-tight font-extrabold">Shared with me</h1>
          <p className="text-sm text-muted-foreground">
            Folders and spaces other people shared with you.
          </p>
        </header>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {sharingMessage(error)}
          </p>
        )}
        {items?.length === 0 && (
          <p className="text-sm text-muted-foreground">Nothing has been shared with you yet.</p>
        )}
        <ul className="grid gap-3">
          {items?.map(({ share, role, canPublish, root, sharedBy }) => {
            const Icon = share.rootId === null ? Library : Folder;
            return (
              <li key={share.shareId}>
                <Link
                  to="/s/$spaceId"
                  params={{ spaceId: share.spaceId }}
                  className="flex items-center gap-3 rounded-control border p-3 hover:bg-accent"
                >
                  <span className="grid size-10 shrink-0 place-items-center rounded-tile bg-folder-blue">
                    <Icon className="size-5" strokeWidth={1.75} />
                  </span>
                  <span className="grid min-w-0 flex-1">
                    <span className="truncate font-extrabold">
                      <Name>{nameOf(root) ?? 'A folder this app can’t read'}</Name>
                    </span>
                    <span className="truncate text-sm text-muted-foreground">
                      {share.rootId === null ? 'A whole space' : 'A folder'}, shared by{' '}
                      {sharedBy?.label ? <Name>{sharedBy.label}</Name> : 'an owner'}
                    </span>
                  </span>
                  <span className="shrink-0 rounded-full bg-muted px-2.5 py-[3px] text-[12.5px] font-bold text-muted-foreground">
                    {ACCESS_LABELS[accessOf({ role, canPublish })]}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
