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
import { Picker } from '@/components/ui/picker';
import { meQuery } from '../api';
import { revisionQuery, searchIndexChanged, treeQuery } from '../data/queries';
import { errorMessage } from '../errors';
import { ErrorLine, useAction } from '../sharing/use-action';
import { useClient } from '../vault/store';

type Tree = Awaited<ReturnType<typeof spaceOperations.loadTree>>;
type TreePage = Tree['pages'][number];

/** A template with a version to copy: its draft, or for a reader its publication. */
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
  const picked = templates.find((t) => t.page.id === pickedId);
  const label = ({ page, path }: Template) =>
    [...path, page.title?.trim() || 'Untitled'].map(plainText).join(' › ');
  return (
    <div className="grid gap-4">
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-template`}>Template</Label>
        <Picker
          id={`${id}-template`}
          label="Template"
          placeholder="Choose a template"
          value={picked?.page.id ?? null}
          options={templates.map((t) => ({ value: t.page.id, label: label(t) }))}
          onChange={setPickedId}
        />
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
  const audience = page.draftHead === null ? 'published' : 'draft';
  const version = useQuery(revisionQuery(ctx, { spaceId, pageId: page.id }, audience, head));
  const { busy, error, run } = useAction(errorMessage);
  const [typed, setTyped] = useState<Record<string, string>>({});
  // Until the person types a title, it follows the template's, filled in.
  const [title, setTitle] = useState<string | null>(null);
  const [now] = useState(() => new Date());
  const opened = version.data?.opened;
  const payload = opened?.kind === 'current' ? opened.payload : null;
  const fields = useMemo(
    () => (payload ? templateFields(payload.title, payload.markdown) : []),
    [payload],
  );

  if (!version.data) {
    return failedToLoad(version) ? (
      <LoadFailed what="the template" queries={[version]} />
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
    const filled = { ...values, title: name, now: new Date() };
    await run(async () => {
      const pageId = await pageOperations.createFromTemplate(ctx, {
        spaceId,
        parentId,
        template,
        title: name,
        markdown: fillTemplate(payload.markdown, filled),
      });
      searchIndexChanged(queryClient);
      await queryClient.invalidateQueries({ queryKey: treeQuery(ctx, spaceId).queryKey });
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
          autoFocus
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
