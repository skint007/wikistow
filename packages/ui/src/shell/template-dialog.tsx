import {
  fillTemplate,
  pageOperations,
  spaceOperations,
  templateFields,
  templatesIn,
  type FolderId,
  type PageId,
  type RevisionId,
  type SpaceId,
} from '@wikistow/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useMemo, useState } from 'react';
import { submitData } from '@/components/form/submit';
import { failedToLoad, LoadFailed } from '@/components/load-failed';
import { plainText } from '@/components/name';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { meQuery } from '../api';
import { pageQuery, revisionQuery, searchIndexChanged, treeQuery } from '../data/queries';
import { errorMessage } from '../errors';
import { ErrorLine, useAction } from '../sharing/use-action';
import { useClient } from '../vault/store';

type Tree = Awaited<ReturnType<typeof spaceOperations.loadTree>>;
type TreePage = Tree['pages'][number];

/**
 * A template with a version to copy, its draft or for a reader its
 * publication, as the tree last listed it.
 */
type Template = { page: TreePage; path: string[]; head: RevisionId };

/**
 * New page from template: pick one of the space's templates, the pages in
 * a folder named Templates, fill in the fields its `{{variables}}` ask for,
 * and the page is made in `parentId`, open while `parentId` isn't undefined.
 */
export function TemplateDialog({
  spaceId,
  tree,
  parentId,
  onClose,
  onCreated,
}: {
  spaceId: SpaceId;
  tree: Tree;
  parentId: FolderId | null | undefined;
  onClose: () => void;
  onCreated: (pageId: PageId) => void;
}) {
  const templates = useMemo(() => {
    const folders = tree.folders.map(({ id, parentId, metadata }) => ({
      id,
      parentId,
      name: metadata?.opened.kind === 'current' ? metadata.opened.metadata.name : null,
    }));
    return templatesIn(folders, tree.pages).flatMap(({ page, path }) => {
      // A copy unpublished here has neither, and nothing to copy from.
      const head = page.draftHead ?? page.publishedHead;
      return head ? [{ page, path, head }] : [];
    });
  }, [tree]);
  return (
    <Dialog open={parentId !== undefined} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="grid gap-4">
        <DialogHeader>
          <DialogTitle>New page from template</DialogTitle>
          <DialogDescription>
            It starts as a private draft, with the template’s fields filled in.
          </DialogDescription>
        </DialogHeader>
        {parentId !== undefined &&
          (templates.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              There are no templates here yet. Any page in a folder named Templates is one. Write{' '}
              <code>{'{{Name}}'}</code> where a value should be asked for.
            </p>
          ) : (
            <ChooseTemplate
              spaceId={spaceId}
              parentId={parentId}
              templates={templates}
              onCreated={onCreated}
            />
          ))}
      </DialogContent>
    </Dialog>
  );
}

// A template as listed: the folders it's in, then its title.
const label = ({ page, path }: Template) =>
  [...path, page.title?.trim() || 'Untitled'].map(plainText).join(' › ');

function ChooseTemplate({
  spaceId,
  parentId,
  templates,
  onCreated,
}: {
  spaceId: SpaceId;
  parentId: FolderId | null;
  templates: Template[];
  onCreated: (pageId: PageId) => void;
}) {
  const id = useId();
  const [pickedId, setPickedId] = useState(templates[0]?.page.id);
  const [filter, setFilter] = useState('');
  const matching = (text: string) =>
    templates.filter((t) => label(t).toLowerCase().includes(text.trim().toLowerCase()));
  const shown = matching(filter);
  // None while the filter shows nothing; the pick comes back as it shows it again.
  const picked = shown.find((t) => t.page.id === pickedId);
  return (
    <div className="grid gap-4">
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-find`}>Template</Label>
        <Input
          id={`${id}-find`}
          placeholder="Find a template"
          autoFocus
          value={filter}
          onChange={(event) => {
            const text = event.target.value;
            setFilter(text);
            // Filtering out the one picked picks the first shown, which then stays picked.
            const found = matching(text);
            const first = found[0];
            if (first && !found.some((t) => t.page.id === pickedId)) setPickedId(first.page.id);
          }}
        />
        {/* In the dialog's flow, not floating over it, so its scrolling can't cut it off. */}
        <div
          role="radiogroup"
          aria-label="Templates"
          className="grid max-h-48 gap-0.5 overflow-y-auto rounded-control border border-input p-1"
        >
          {shown.length === 0 && (
            <p className="px-2 py-1.5 text-sm text-muted-foreground">No template matches.</p>
          )}
          {shown.map((t) => (
            <label
              key={t.page.id}
              className={cn(
                'flex cursor-pointer items-center rounded-row px-2 py-1.5 text-sm hover:tint has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring',
                t === picked && 'bg-primary-soft text-primary-ink',
              )}
            >
              <input
                type="radio"
                name={`${id}-template`}
                className="sr-only"
                checked={t === picked}
                onChange={() => setPickedId(t.page.id)}
              />
              <span className="min-w-0 truncate">{label(t)}</span>
            </label>
          ))}
        </div>
      </div>
      {picked && (
        <FillTemplate
          key={picked.page.id}
          spaceId={spaceId}
          parentId={parentId}
          template={picked}
          onCreated={onCreated}
        />
      )}
    </div>
  );
}

/** The picked template's fields and the title, filled in as they're typed. */
function FillTemplate({
  spaceId,
  parentId,
  template: { page, head },
  onCreated,
}: {
  spaceId: SpaceId;
  parentId: FolderId | null;
  template: Template;
  onCreated: (pageId: PageId) => void;
}) {
  const ctx = useClient();
  const queryClient = useQueryClient();
  const id = useId();
  const { data: me } = useQuery(meQuery);
  // The tree's heads can be from before the template's last save: ask for them now.
  const info = useQuery(pageQuery(ctx, page.id));
  const heads = info.isFetchedAfterMount ? info.data?.heads : undefined;
  const latest = heads ? (heads.draftHead ?? heads.publishedHead) : undefined;
  const audience = heads?.draftHead ? 'draft' : 'published';
  const version = useQuery({
    ...revisionQuery(ctx, { spaceId, pageId: page.id }, audience, latest ?? head),
    enabled: Boolean(latest),
  });
  const { busy, error, run } = useAction(errorMessage);
  const [typed, setTyped] = useState<Record<string, string>>({});
  // Until the person types a title, it follows the template's, filled in.
  const [title, setTitle] = useState<string | null>(null);
  // One time for the title and the page, when the template was picked.
  const [now] = useState(() => new Date());
  const opened = version.data?.opened;
  const payload = opened?.kind === 'current' ? opened.payload : null;
  const fields = useMemo(
    () => (payload ? templateFields(payload.title, payload.markdown) : []),
    [payload],
  );

  if (heads && !latest) {
    return <p className="text-sm text-muted-foreground">This template has nothing to copy yet.</p>;
  }
  if (!version.data) {
    return failedToLoad(info) || failedToLoad(version) ? (
      <LoadFailed what="the template" queries={[info, version]} />
    ) : (
      <p className="text-sm text-muted-foreground">Loading…</p>
    );
  }
  if (!payload) {
    return (
      <p className="text-sm text-muted-foreground">
        A newer version of WikiStow saved this template. Update the app to use it.
      </p>
    );
  }
  const asked = Object.fromEntries(fields.map((f) => [f.key, typed[f.key] ?? f.initial]));
  const values = { me: me?.account.name ?? '', asked };
  // Only a title with variables is suggested: two pages of one title make its wikilinks ambiguous.
  const filledTitle = fillTemplate(payload.title, { ...values, title: '', now }).trim();
  const shownTitle = title ?? (filledTitle === payload.title.trim() ? '' : filledTitle);

  const template = version.data;
  async function submit() {
    const name = shownTitle.trim();
    if (!name || !payload) return;
    const filled = { ...values, title: name, now };
    await run(async () => {
      let pageId: PageId;
      try {
        pageId = await pageOperations.createFromTemplate(ctx, {
          spaceId,
          parentId,
          template,
          title: name,
          markdown: fillTemplate(payload.markdown, filled),
        });
      } finally {
        // A page whose attachments failed is made all the same, and listed.
        searchIndexChanged(queryClient);
        await queryClient.invalidateQueries({ queryKey: treeQuery(ctx, spaceId).queryKey });
      }
      onCreated(pageId);
    });
  }

  return (
    <form onSubmit={submitData(submit)} className="grid gap-4">
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-title`}>Title</Label>
        <Input
          id={`${id}-title`}
          required
          maxLength={200}
          value={shownTitle}
          placeholder={plainText(payload.title)}
          onChange={(event) => setTitle(event.target.value)}
        />
      </div>
      {fields.map((field, index) => (
        <div key={field.key} className="grid gap-1.5">
          <Label htmlFor={`${id}-${index}`}>{plainText(field.label)}</Label>
          <Input
            id={`${id}-${index}`}
            value={asked[field.key] ?? ''}
            onChange={(event) =>
              setTyped((current) => ({ ...current, [field.key]: event.target.value }))
            }
          />
        </div>
      ))}
      <ErrorLine error={error} />
      <DialogFooter>
        <Button type="submit" disabled={busy}>
          Create page
        </Button>
      </DialogFooter>
    </form>
  );
}
