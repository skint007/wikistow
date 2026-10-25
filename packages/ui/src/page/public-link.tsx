// Public links (ADR 0005): the dialog that turns a page's link on and off,
// the Publish confirmation for a page with one, and the marker that shows
// which pages are public. A readable copy goes up only from a button in
// one of these dialogs, never in the background.
import { publicLinkOperations, type pageOperations, type RevisionId } from '@wikistow/client';
import { ApiError } from '@wikistow/client/api';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Globe } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Name } from '@/components/name';
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
import { cn } from '@/lib/utils';
import { installationQuery } from '../api';
import { errorMessage } from '../errors';
import { publicLinksQuery, revisionQuery, treeQuery } from '../data/queries';
import { ErrorLine, HoldOpen, useAction, useHoldOpen } from '../sharing/use-action';
import { useClient } from '../vault/store';
import { publicLinkMessage } from './messages';

/** A version just published, which the Publish confirmation uploads without opening it again. */
type Published = NonNullable<
  NonNullable<Parameters<typeof publicLinkOperations.shareCopy>[2]>['published']
>;

/** The page's public link as the server lists it to this person, or null if it has none. */
export function usePublicLink(page: pageOperations.PageRef) {
  const ctx = useClient();
  const { data } = useQuery(publicLinksQuery(ctx, page.spaceId));
  return data?.find((link) => link.pageId === page.pageId) ?? null;
}

/**
 * What a public copy of `markdown` shows of other pages, said where a copy
 * is made: anyone with the link can read it too, as it was at the publish.
 * Nothing while `markdown` isn't known, or shows nothing of them.
 */
function FromOtherPages({ markdown }: { markdown: string | null | undefined }) {
  const shows = useMemo(
    () => (markdown == null ? null : publicLinkOperations.fromOtherPages(markdown)),
    [markdown],
  );
  if (!shows?.values) return null;
  return (
    <p role="note" className="rounded-control bg-muted p-3 text-sm">
      <strong>This page shows values from other pages.</strong> Anyone with the link can read them
      too. They’re taken from those pages’ published versions, as they are when this page is
      published, and stay so until it’s published again.
    </p>
  );
}

/** The page's published version's Markdown, once opened; null if it has none this app can read. */
function usePublishedMarkdown(page: pageOperations.PageRef, head: RevisionId | null | undefined) {
  const ctx = useClient();
  const { data } = useQuery({
    ...revisionQuery(ctx, page, 'published', head ?? ('' as RevisionId)),
    enabled: !!head,
  });
  if (!head) return null;
  return data?.opened.kind === 'current' ? data.opened.payload.markdown : undefined;
}

/** Load the space's public links again, after this person changed one. */
function useRefreshLinks(page: pageOperations.PageRef) {
  const ctx = useClient();
  const queryClient = useQueryClient();
  return () =>
    queryClient.invalidateQueries({ queryKey: publicLinksQuery(ctx, page.spaceId).queryKey });
}

/** The small globe that marks a page with a public link, in the tree and on the page. */
export function PublicMarker({ className }: { className?: string }) {
  return (
    <span data-hint="Public link" className={cn('shrink-0 text-muted-foreground', className)}>
      <Globe aria-hidden className="size-3.5" strokeWidth={1.75} />
      <span className="sr-only">Public link</span>
    </span>
  );
}

/**
 * Share public link…: before the first link, what a link means and a
 * button that turns it on and uploads the published version; with one,
 * the link, Copy link, Turn off the link, and Update public page when the
 * public page is out of date. For people who can publish the page.
 */
export function PublicLinkDialog({
  page,
  title,
  open,
  onOpenChange,
}: {
  page: pageOperations.PageRef;
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { locked, hold } = useHoldOpen();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent locked={locked}>
        <HoldOpen value={hold}>
          <LinkSteps page={page} title={title} onClose={() => onOpenChange(false)} />
        </HoldOpen>
      </DialogContent>
    </Dialog>
  );
}

function LinkSteps({
  page,
  title,
  onClose,
}: {
  page: pageOperations.PageRef;
  title: string;
  onClose: () => void;
}) {
  const ctx = useClient();
  const links = useQuery(publicLinksQuery(ctx, page.spaceId));
  // Unpublished while the dialog is open: it can have no link now.
  const { data: tree } = useQuery(treeQuery(ctx, page.spaceId));
  const publishedHead = tree?.pages.find((p) => p.id === page.pageId)?.publishedHead;
  const unpublished = publishedHead === null;
  const published = usePublishedMarkdown(page, publishedHead);
  const refresh = useRefreshLinks(page);
  const { busy, error, run } = useAction(publicLinkMessage);
  // What's running, said as it goes.
  const [step, setStep] = useState<string | null>(null);
  const link = links.data?.find((listed) => listed.pageId === page.pageId);

  // Each ends by loading the links again, so a link turned on whose upload failed shows as on.
  const upload = (turnOn: boolean) =>
    run(async () => {
      try {
        // Opened first, so a version this app can't read turns no link on.
        const published = await publicLinkOperations.openPublished(ctx, page);
        if (turnOn) {
          setStep('Turning on the link…');
          await publicLinkOperations.turnOn(ctx, page.pageId);
        }
        setStep('Uploading the public page…');
        await publicLinkOperations.shareCopy(ctx, page, { published });
      } finally {
        setStep(null);
        await refresh();
      }
    });
  const turnOff = () =>
    run(async () => {
      try {
        setStep('Turning off the link…');
        await publicLinkOperations.turnOff(ctx, page.pageId);
        onClose();
      } finally {
        setStep(null);
        await refresh();
      }
    });

  const status = (
    <>
      {step && (
        <p aria-live="polite" className="text-sm text-muted-foreground">
          {step}
        </p>
      )}
      <ErrorLine error={error} />
    </>
  );

  if (!links.data) {
    return (
      <div className="grid gap-4">
        <DialogHeader>
          <DialogTitle>
            Public link for “<Name>{title}</Name>”
          </DialogTitle>
          <DialogDescription>
            {links.isError ? errorMessage(links.error) : 'Checking for a public link…'}
          </DialogDescription>
        </DialogHeader>
      </div>
    );
  }

  if (!link && unpublished) {
    return (
      <div className="grid gap-4">
        <DialogHeader>
          <DialogTitle>
            Public link for “<Name>{title}</Name>”
          </DialogTitle>
          <DialogDescription>
            This page isn’t published any more, so it has no public link. Publish it to share it
            again.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </div>
    );
  }

  if (!link) {
    return (
      <div className="grid gap-4">
        <DialogHeader>
          <DialogTitle>
            Share “<Name>{title}</Name>” with a public link?
          </DialogTitle>
          <DialogDescription>
            Anyone with the link can read the published version of this page. They don’t need an
            account.
          </DialogDescription>
        </DialogHeader>
        <p role="note" className="rounded-control bg-muted p-3 text-sm">
          <strong>The server keeps a readable copy.</strong> Your pages stay encrypted. For the link
          to work, the server keeps a readable copy of the published version, with the images and
          files it uses, until you turn the link off. Drafts stay private.
        </p>
        <FromOtherPages markdown={published} />
        {status}
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={() => void upload(true)}>
            Turn on public link
          </Button>
        </DialogFooter>
      </div>
    );
  }

  return (
    <div className="grid gap-4">
      <DialogHeader>
        <DialogTitle>
          Public link for “<Name>{title}</Name>”
        </DialogTitle>
        <DialogDescription>
          Anyone with this link can read the published version of this page.
        </DialogDescription>
      </DialogHeader>
      {link.id ? (
        <LinkField id={link.id} />
      ) : (
        <p className="text-sm text-muted-foreground">
          Only someone who can publish this page can see its link.
        </p>
      )}
      {!link.live && (
        <div role="note" className="grid justify-items-start gap-2 rounded-control bg-muted p-3">
          <p className="text-sm">
            <strong>The public page is out of date.</strong> Until it’s updated, visitors see a note
            that the page is being updated.
          </p>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void upload(false)}>
            Update public page
          </Button>
        </div>
      )}
      <FromOtherPages markdown={published} />
      <p className="text-sm text-muted-foreground">
        Turning the link off deletes the public copy at once. Turning it on again makes a new link.
      </p>
      {status}
      <DialogFooter>
        <Button variant="destructive" disabled={busy} onClick={() => void turnOff()}>
          Turn off the link
        </Button>
        <Button variant="secondary" disabled={busy} onClick={onClose}>
          Done
        </Button>
      </DialogFooter>
    </div>
  );
}

/**
 * The link as `<origin>/p/<id>`, by the server's own origin, which the
 * desktop app isn't on. Empty, with nothing to copy, until that is known.
 */
function LinkField({ id }: { id: string }) {
  const { data } = useQuery(installationQuery);
  const url = data ? `${data.origin}/p/${id}` : '';
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex gap-2">
      <Input readOnly aria-label="Public link" value={url} className="font-mono text-sm" />
      <Button
        variant="outline"
        disabled={!url}
        onClick={() =>
          void navigator.clipboard.writeText(url).then(
            () => setCopied(true),
            () => setCopied(false),
          )
        }
      >
        {copied ? <Check strokeWidth={1.75} /> : <Copy strokeWidth={1.75} />}
        {copied ? 'Copied' : 'Copy link'}
      </Button>
    </div>
  );
}

/**
 * Publish on a page with a public link asks first, then publishes and
 * uploads the version just published at once. If the upload fails, the
 * page stays published, and the dialog offers to try the upload again.
 * `onDone` runs once it closes after a publish.
 */
export function PublishWithLinkDialog({
  page,
  title,
  markdown,
  open,
  onOpenChange,
  publish,
  onDone,
}: {
  page: pageOperations.PageRef;
  title: string;
  /** The draft as it is when Publish is clicked, for what the copy will show; the version published once it is. */
  markdown?: string | null | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Publish the draft, answering the version published. */
  publish: () => Promise<Published>;
  onDone: () => void;
}) {
  const { locked, hold } = useHoldOpen();
  // The version published, kept while its upload is tried again.
  const [published, setPublished] = useState<Published | null>(null);
  useEffect(() => {
    if (open) setPublished(null);
  }, [open]);
  const close = () => {
    onOpenChange(false);
    if (published) onDone();
  };
  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent locked={locked}>
        <HoldOpen value={hold}>
          <PublishSteps
            page={page}
            title={title}
            markdown={published?.payload.markdown ?? markdown}
            published={published}
            publish={async () => {
              const version = await publish();
              setPublished(version);
              return version;
            }}
            onUploaded={() => {
              onOpenChange(false);
              onDone();
            }}
            onClose={close}
          />
        </HoldOpen>
      </DialogContent>
    </Dialog>
  );
}

function PublishSteps({
  page,
  title,
  markdown,
  published,
  publish,
  onUploaded,
  onClose,
}: {
  page: pageOperations.PageRef;
  title: string;
  markdown: string | null | undefined;
  published: Published | null;
  publish: () => Promise<Published>;
  onUploaded: () => void;
  onClose: () => void;
}) {
  const ctx = useClient();
  const refresh = useRefreshLinks(page);
  const { busy, error, run } = useAction(errorMessage);
  const [step, setStep] = useState<string | null>(null);
  // Once the page is published again, its link is off, or the person can't
  // publish it, the version kept here can't be sent: only Close is left.
  const [stale, setStale] = useState(false);
  const confirm = () =>
    run(async () => {
      let version = published;
      if (!version) {
        setStep('Publishing…');
        try {
          version = await publish();
        } finally {
          setStep(null);
        }
      }
      setStep('Updating the public page…');
      try {
        await publicLinkOperations.shareCopy(ctx, page, { published: version });
      } catch (caught) {
        // A newer publication can't be sent from here, which has only this one.
        const code = caught instanceof ApiError ? caught.code : null;
        setStale(code === 'stale-head' || code === 'not-found' || code === 'forbidden');
        const why =
          code === 'stale-head' || code === 'not-found'
            ? 'The page or its public link changed meanwhile. Use Share public link… to see where it stands.'
            : publicLinkMessage(caught);
        throw new Error(`Published, but the public page wasn’t updated. ${why}`, {
          cause: caught,
        });
      } finally {
        setStep(null);
        await refresh();
      }
      onUploaded();
    });
  return (
    <div className="grid gap-4">
      <DialogHeader>
        <DialogTitle>
          Publish “<Name>{title}</Name>”?
        </DialogTitle>
        <DialogDescription>
          This page has a public link. Publishing updates the public page too.
        </DialogDescription>
      </DialogHeader>
      <FromOtherPages markdown={markdown} />
      {step && (
        <p aria-live="polite" className="text-sm text-muted-foreground">
          {step}
        </p>
      )}
      <ErrorLine error={error} />
      <DialogFooter>
        <Button variant="ghost" disabled={busy} onClick={onClose}>
          {published ? 'Close' : 'Cancel'}
        </Button>
        {!stale && (
          <Button disabled={busy} onClick={() => void confirm()}>
            {published ? 'Update public page' : 'Publish'}
          </Button>
        )}
      </DialogFooter>
    </div>
  );
}
