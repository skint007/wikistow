import {
  archiveFiles,
  cleanPath,
  importOperations,
  readJoplinExport,
  type FolderId,
  type ImportFile,
  type JoplinExport,
  type SpaceId,
} from '@wikistow/client';
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
import { errorMessage } from '../errors';
import { ErrorLine } from '../sharing/use-action';
import { useClient } from '../vault/store';
import { doneStatus, foundStatus, importStatus, skipReason } from './import-model';

/** Where an import goes: the top of the space (`folderId` null) or a folder, by the name shown. */
export type Importing = { folderId: FolderId | null; name: string };

type Stage =
  | { kind: 'choose' }
  | { kind: 'reading' }
  | { kind: 'found'; joplin: JoplinExport }
  | { kind: 'importing'; progress: importOperations.ImportProgress | null }
  | { kind: 'done'; summary: importOperations.ImportSummary };

/** A picked folder's files, its own name taken off their paths, as an export's. */
function folderFiles(list: FileList): ImportFile[] {
  const files: ImportFile[] = [];
  for (const file of list) {
    const path = cleanPath(file.webkitRelativePath.split('/').slice(1).join('/'));
    if (path === null) continue;
    files.push({
      path,
      size: file.size,
      read: async () => new Uint8Array(await file.arrayBuffer()),
    });
  }
  return files;
}

/**
 * Import a Joplin export into a space, or a folder of it: a JEX file, or a
 * Markdown + Front Matter export as its folder or a zip of it. It reads the
 * export first and says what it found, then makes the folders and pages
 * (`importJoplin`), showing how far it has got, and stops at the next step
 * if Cancel is pressed or the dialog closed. Running it again finishes an
 * import cut short and changes nothing already imported. At the end it says
 * what it made, and lists links it couldn't rewrite and notes left out.
 */
export function ImportDialog({
  spaceId,
  importing,
  onOpenChange,
}: {
  spaceId: SpaceId;
  /** Null while closed. */
  importing: Importing | null;
  onOpenChange: (open: boolean) => void;
}) {
  const ctx = useClient();
  const [stage, setStage] = useState<Stage>({ kind: 'choose' });
  const [error, setError] = useState<string | null>(null);
  const running = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const opened = importing === null ? null : `${importing.folderId}`;
  useEffect(() => {
    if (opened === null) return;
    setStage({ kind: 'choose' });
    setError(null);
    // Closing the dialog, or leaving the space, stops the import.
    return () => running.current?.abort();
  }, [opened]);
  useEffect(() => {
    // Not in React's attribute types: set on the element itself.
    if (folderInput.current) folderInput.current.webkitdirectory = true;
  });

  const read = async (files: () => Promise<ImportFile[]>) => {
    setError(null);
    setStage({ kind: 'reading' });
    try {
      const joplin = await readJoplinExport(await files());
      if (joplin.notes.length === 0 && joplin.encrypted === 0) {
        setError('No Joplin notes were found there.');
        setStage({ kind: 'choose' });
        return;
      }
      setStage({ kind: 'found', joplin });
    } catch (caught) {
      setError(errorMessage(caught));
      setStage({ kind: 'choose' });
    }
  };

  const start = async (target: Importing, joplin: JoplinExport) => {
    const controller = new AbortController();
    running.current = controller;
    setError(null);
    setStage({ kind: 'importing', progress: null });
    try {
      const summary = await importOperations.importJoplin(ctx, {
        scope: { spaceId, ...(target.folderId === null ? {} : { folderId: target.folderId }) },
        joplin,
        onProgress: (progress) => {
          if (!controller.signal.aborted) setStage({ kind: 'importing', progress });
        },
        signal: controller.signal,
      });
      setStage({ kind: 'done', summary });
    } catch (caught) {
      if (controller.signal.aborted || caught instanceof importOperations.ImportStopped) return;
      setError(`${errorMessage(caught)} Import again to finish: what is already there stays.`);
      setStage({ kind: 'found', joplin });
    } finally {
      if (running.current === controller) running.current = null;
    }
  };

  const busy = stage.kind === 'reading' || stage.kind === 'importing';
  const { progress } = stage.kind === 'importing' ? stage : { progress: null };
  return (
    <Dialog open={importing !== null} onOpenChange={onOpenChange}>
      <DialogContent className="grid gap-4">
        <DialogHeader>
          <DialogTitle>
            Import into “<Name>{importing?.name ?? ''}</Name>”
          </DialogTitle>
          <DialogDescription>
            Bring in notes from Joplin. In Joplin, choose File, Export all, then JEX or Markdown +
            Front Matter. Each notebook becomes a folder, and each note a published page.
          </DialogDescription>
        </DialogHeader>
        {(stage.kind === 'choose' || stage.kind === 'reading') && (
          <>
            <p className="text-sm text-muted-foreground">
              Encrypted notes must be decrypted in Joplin before you export them.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => fileInput.current?.click()}
              >
                Choose a JEX or zip file…
              </Button>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => folderInput.current?.click()}
              >
                Choose an export folder…
              </Button>
            </div>
            <input
              ref={fileInput}
              type="file"
              accept=".jex,.zip,.tar"
              hidden
              aria-label="Joplin export file"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = '';
                if (file)
                  void read(async () => archiveFiles(new Uint8Array(await file.arrayBuffer())));
              }}
            />
            <input
              ref={folderInput}
              type="file"
              hidden
              aria-label="Joplin export folder"
              onChange={(event) => {
                const list = event.currentTarget.files;
                const files = list ? folderFiles(list) : [];
                event.currentTarget.value = '';
                void read(async () => files);
              }}
            />
            {stage.kind === 'reading' && (
              <p role="status" className="text-sm font-bold">
                Reading the export…
              </p>
            )}
          </>
        )}
        {stage.kind === 'found' && (
          <p role="status" className="text-sm font-bold">
            {foundStatus(stage.joplin)}
          </p>
        )}
        {stage.kind === 'importing' && (
          <div className="grid gap-2">
            <p role="status" className="text-sm font-bold">
              {progress ? importStatus(progress) : 'Starting…'}
            </p>
            <div
              role="progressbar"
              aria-label="Import progress"
              aria-valuemin={0}
              aria-valuemax={progress?.total ?? 0}
              aria-valuenow={progress?.done ?? 0}
              className="h-2 overflow-hidden rounded-full bg-muted"
            >
              {/* Set through the CSSOM, which the style policy allows. */}
              <div
                className="h-full rounded-full bg-primary transition-[width]"
                style={{
                  width: `${progress && progress.total > 0 ? (100 * progress.done) / progress.total : 0}%`,
                }}
              />
            </div>
          </div>
        )}
        {stage.kind === 'done' && <Report summary={stage.summary} />}
        <ErrorLine error={error} />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {stage.kind === 'done' ? 'Close' : 'Cancel'}
          </Button>
          {(stage.kind === 'found' || stage.kind === 'importing') && (
            <Button
              disabled={busy}
              onClick={() =>
                importing && stage.kind === 'found' && void start(importing, stage.joplin)
              }
            >
              {busy ? 'Importing…' : 'Import'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** What an import made, then each link it left as written and each note it left out. */
function Report({ summary }: { summary: importOperations.ImportSummary }) {
  const { unresolved, skipped } = summary;
  return (
    <div className="grid gap-3">
      <p role="status" className="text-sm font-bold">
        {doneStatus(summary)}
      </p>
      {unresolved.length > 0 && (
        <section className="grid gap-1">
          <h3 className="text-sm font-bold">Links left as they were</h3>
          <p className="text-sm text-muted-foreground">
            They name a note or file that wasn’t imported, a note whose title a wikilink can’t hold
            (with | or #), or one of two notes of one title in one notebook.
          </p>
          <ul className="max-h-40 overflow-y-auto rounded-control bg-muted px-3 py-2 text-sm">
            {unresolved.map(({ path, link }, i) => (
              <li key={i} className="truncate">
                <Name>{path}</Name>: <Name>{link}</Name>
              </li>
            ))}
          </ul>
        </section>
      )}
      {skipped.length > 0 && (
        <section className="grid gap-1">
          <h3 className="text-sm font-bold">Notes left out</h3>
          <ul className="max-h-40 overflow-y-auto rounded-control bg-muted px-3 py-2 text-sm">
            {skipped.map(({ path, reason }, i) => (
              <li key={i} className="truncate">
                <Name>{path}</Name>: {skipReason(reason)}
              </li>
            ))}
          </ul>
        </section>
      )}
      {summary.encrypted > 0 && (
        <p className="text-sm text-muted-foreground">
          The export still has encrypted items. Decrypt them in Joplin, export again, and import
          again here: what is already imported stays as it is.
        </p>
      )}
    </div>
  );
}
