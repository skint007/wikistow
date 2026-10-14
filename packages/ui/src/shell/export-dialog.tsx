import { exportOperations, type FolderId, type SpaceId } from '@wikistow/client';
import { useEffect, useRef, useState } from 'react';
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
import { runCommand } from '../commands/command';
import { exportMarkdown, requirementsHere } from '../commands/ui-commands';
import { errorMessage } from '../errors';
import { ErrorLine } from '../sharing/use-action';
import { useClient } from '../vault/store';
import { exportStatus, summaryStatus } from './export-model';

/** What is being exported: the whole space (`folderId` null) or a folder, by the name shown. */
export type Exporting = { folderId: FolderId | null; name: string };

/**
 * Export a space, or a folder of it, as a zip of Markdown files the
 * browser downloads. It shows how far it has got, and stops if the dialog
 * is closed. Nothing decrypted is stored: the zip is built in memory and
 * its download URL revoked once the browser has it.
 */
export function ExportDialog({
  spaceId,
  exporting,
  onOpenChange,
}: {
  spaceId: SpaceId;
  /** Null while closed. */
  exporting: Exporting | null;
  onOpenChange: (open: boolean) => void;
}) {
  const ctx = useClient();
  const [progress, setProgress] = useState<exportOperations.ExportProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<string | null>(null);
  const running = useRef<AbortController | null>(null);
  const opened = exporting === null ? null : `${exporting.folderId}`;
  useEffect(() => {
    if (opened === null) return;
    setProgress(null);
    setError(null);
    setSkipped(null);
    // Closing the dialog, or leaving the space, stops the export.
    return () => running.current?.abort();
  }, [opened]);

  const start = async (target: Exporting) => {
    const controller = new AbortController();
    running.current = controller;
    setError(null);
    setSkipped(null);
    setProgress({ phase: 'pages', done: 0, total: 0 });
    let left: string | null = null;
    try {
      await runCommand(
        exportMarkdown,
        { spaceId, folderId: target.folderId, name: target.name },
        {
          satisfies: requirementsHere(),
          ctx,
          // What is left running once it has finished says nothing more.
          onProgress: (next) => {
            if (!controller.signal.aborted) setProgress(next);
          },
          onExported: (summary) => {
            left = summaryStatus(summary);
          },
          signal: controller.signal,
        },
      );
    } catch (caught) {
      if (controller.signal.aborted || caught instanceof exportOperations.ExportAbandoned) return;
      setError(errorMessage(caught));
      return;
    } finally {
      // Stop what is left running: once one download fails the export, the others.
      controller.abort();
      if (running.current === controller) running.current = null;
      setProgress(null);
    }
    if (left !== null) setSkipped(left);
    else onOpenChange(false);
  };

  const busy = progress !== null;
  return (
    <Dialog open={exporting !== null} onOpenChange={onOpenChange}>
      <DialogContent className="grid gap-4">
        <DialogHeader>
          <DialogTitle>
            Export “<Name>{exporting?.name ?? ''}</Name>”
          </DialogTitle>
          <DialogDescription>
            Download the pages you can read here as Markdown files in a zip, with their attachments.
            Links between them keep working in Obsidian. Each page is exported as you see it: its
            draft if you edit it, else the published version.
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          The files aren’t encrypted, so keep them somewhere safe.
        </p>
        {progress !== null && (
          <div className="grid gap-2">
            <p role="status" className="text-sm font-bold">
              {exportStatus(progress)}
            </p>
            <div
              role="progressbar"
              aria-label="Export progress"
              aria-valuemin={0}
              aria-valuemax={progress.total}
              aria-valuenow={progress.done}
              className="h-2 overflow-hidden rounded-full bg-muted"
            >
              {/* Set through the CSSOM, which the style policy allows. */}
              <div
                className="h-full rounded-full bg-primary transition-[width]"
                style={{
                  width: `${progress.total > 0 ? (100 * progress.done) / progress.total : 0}%`,
                }}
              />
            </div>
          </div>
        )}
        {skipped !== null && (
          <p role="status" className="text-sm font-bold">
            {skipped}
          </p>
        )}
        <ErrorLine error={error} />
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {skipped !== null ? 'Close' : 'Cancel'}
          </Button>
          {skipped === null && (
            <Button disabled={busy} onClick={() => exporting && void start(exporting)}>
              {busy ? 'Exporting…' : 'Export'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
