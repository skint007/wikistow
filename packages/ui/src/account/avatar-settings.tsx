import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '@wikistow/client/api';
import { accountRoutes, ApiErrorBody } from '@wikistow/contracts';
import { useEffect, useRef, useState } from 'react';
import { Avatar } from '@/components/avatar';
import { FormMessage } from '@/components/layout/auth-card';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { api, meQuery } from '../api';
import { errorMessage } from '../errors';
import { PLAIN } from '../vault/store';

const ACCEPT = '.jpg,.jpeg,.png,.gif,.svg,image/jpeg,image/png,image/gif,image/svg+xml';
const EXTENSION = /\.(jpe?g|png|gif|svg)$/i;
const TYPES: readonly string[] = ['image/jpeg', 'image/png', 'image/gif', 'image/svg+xml'];
const LIMIT_MB = accountRoutes.MAX_AVATAR_BYTES / (1024 * 1024);

// A quick look before uploading. The server checks the bytes themselves.
function fileProblem(file: File): string | null {
  if (!EXTENSION.test(file.name) && !TYPES.includes(file.type)) {
    return 'Choose a JPEG, PNG, GIF or SVG image.';
  }
  if (file.size > accountRoutes.MAX_AVATAR_BYTES) {
    return `That image is ${(file.size / (1024 * 1024)).toFixed(1)} MB. Avatars can be up to ${LIMIT_MB} MB.`;
  }
  return null;
}

/**
 * Send `file` as the account's avatar, reporting how much has gone. With
 * XMLHttpRequest, since fetch can't report upload progress.
 */
function uploadAvatar(file: File, onProgress: (fraction: number) => void) {
  return new Promise<accountRoutes.AvatarId>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('PUT', accountRoutes.AVATAR_UPLOAD_PATH);
    request.setRequestHeader('content-type', 'application/octet-stream');
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    request.onerror = () => reject(new ApiError(0, 'network', 'No answer from the server'));
    request.onload = () => {
      const json: unknown = (() => {
        try {
          return JSON.parse(request.responseText);
        } catch {
          return undefined;
        }
      })();
      if (request.status === 200) {
        const parsed = accountRoutes.AvatarUpload.safeParse(json);
        if (parsed.success) resolve(parsed.data.avatar);
        else reject(new ApiError(request.status, 'unreadable-response', 'Unexpected response'));
        return;
      }
      const refused = ApiErrorBody.safeParse(json);
      reject(
        refused.success
          ? new ApiError(request.status, refused.data.error.code, refused.data.error.message)
          : new ApiError(request.status, 'unreadable-response', 'Unexpected response'),
      );
    };
    request.send(file);
  });
}

type Status =
  | { kind: 'idle' }
  /** `fraction` is null until the browser reports progress, which the desktop app's doesn't. */
  | { kind: 'uploading'; fraction: number | null }
  | { kind: 'removing' }
  | { kind: 'done'; text: string }
  | { kind: 'failed'; text: string };

/**
 * Choose, preview, upload, replace or remove the account's avatar. A chosen
 * image shows in place until it is saved or dropped.
 */
export function AvatarSettings() {
  const queryClient = useQueryClient();
  const { data: me } = useQuery(meQuery);
  const input = useRef<HTMLInputElement>(null);
  const [chosen, setChosen] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | undefined>(undefined);
  // Whether the chosen file decoded; it can't be saved before.
  const [drawable, setDrawable] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  // The chosen file as a local address for its preview, released when it
  // goes. A file this browser can't draw is dropped: saved, it would only
  // ever show as initials.
  useEffect(() => {
    setDrawable(false);
    if (!chosen) {
      setPreview(undefined);
      return;
    }
    const url = URL.createObjectURL(chosen);
    setPreview(url);
    let current = true;
    const probe = new Image();
    probe.src = url;
    probe.decode().then(
      () => {
        if (current) setDrawable(true);
      },
      () => {
        if (!current) return;
        setChosen(null);
        setStatus({
          kind: 'failed',
          text: 'This image is damaged or can’t be shown. Choose another.',
        });
      },
    );
    return () => {
      current = false;
      URL.revokeObjectURL(url);
    };
  }, [chosen]);

  if (!me) return null;
  const busy = status.kind === 'uploading' || status.kind === 'removing';

  // Everywhere the avatar shows: the account menu, and lists of people.
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: meQuery.queryKey }),
      queryClient.invalidateQueries({ queryKey: [PLAIN, 'people'] }),
    ]);
  };

  const choose = (file: File | undefined) => {
    if (input.current) input.current.value = '';
    if (!file) return;
    const problem = fileProblem(file);
    if (problem) {
      setChosen(null);
      setStatus({ kind: 'failed', text: problem });
      return;
    }
    setChosen(file);
    setStatus({ kind: 'idle' });
  };

  const save = async () => {
    if (!chosen) return;
    setStatus({ kind: 'uploading', fraction: null });
    try {
      await uploadAvatar(chosen, (fraction) => setStatus({ kind: 'uploading', fraction }));
      await refresh();
      setChosen(null);
      setStatus({ kind: 'done', text: 'Avatar saved.' });
    } catch (caught) {
      // A refused file would only be refused again; anything else may work on a retry.
      const refused =
        caught instanceof ApiError &&
        (caught.code === 'unsupported-image' || caught.code === 'payload-too-large');
      if (refused) setChosen(null);
      // Only a server from before avatars has no upload route.
      const unsupported = caught instanceof ApiError && caught.status === 404;
      setStatus({
        kind: 'failed',
        text: unsupported ? 'This server doesn’t support avatars yet.' : errorMessage(caught),
      });
    }
  };

  const remove = async () => {
    setStatus({ kind: 'removing' });
    try {
      await api.call(accountRoutes.removeAvatar);
      await refresh();
      setStatus({ kind: 'done', text: 'Avatar removed. Your initials show instead.' });
    } catch (caught) {
      setStatus({ kind: 'failed', text: errorMessage(caught) });
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-5">
      <Avatar
        name={me.account.name}
        avatar={me.account.avatar}
        preview={preview}
        className="size-20 text-2xl"
      />
      <div className="grid min-w-0 flex-1 gap-3">
        <input
          ref={input}
          type="file"
          accept={ACCEPT}
          className="hidden"
          aria-label="Avatar image"
          onChange={(event) => choose(event.target.files?.[0])}
        />
        <div className="flex flex-wrap gap-2">
          {chosen ? (
            <>
              <Button disabled={busy || !drawable} onClick={() => void save()}>
                Save avatar
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setChosen(null);
                  setStatus({ kind: 'idle' });
                }}
              >
                Cancel
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" disabled={busy} onClick={() => input.current?.click()}>
                {me.account.avatar ? 'Replace image…' : 'Choose image…'}
              </Button>
              {me.account.avatar && (
                <Button variant="outline" disabled={busy} onClick={() => void remove()}>
                  Remove
                </Button>
              )}
            </>
          )}
        </div>
        {status.kind === 'uploading' ? (
          <div className="grid max-w-xs gap-1.5">
            <p role="status" className="text-sm font-bold">
              Uploading…
              {status.fraction !== null && ` ${Math.round(status.fraction * 100)}%`}
            </p>
            <div
              role="progressbar"
              aria-label="Upload progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={
                status.fraction === null ? undefined : Math.round(status.fraction * 100)
              }
              className="h-2 overflow-hidden rounded-full bg-muted"
            >
              {/* Set through the CSSOM, which the style policy allows. */}
              <div
                className={cn(
                  'h-full rounded-full bg-primary transition-[width]',
                  status.fraction === null && 'animate-pulse',
                )}
                style={{ width: `${(status.fraction ?? 1) * 100}%` }}
              />
            </div>
          </div>
        ) : status.kind === 'done' ? (
          <FormMessage tone="notice">{status.text}</FormMessage>
        ) : status.kind === 'failed' ? (
          <FormMessage>{status.text}</FormMessage>
        ) : (
          <p className="text-sm text-muted-foreground">
            {chosen
              ? `Previewing ${chosen.name}. Save it to use it everywhere.`
              : `JPEG, PNG, GIF or SVG, up to ${LIMIT_MB} MB.`}
          </p>
        )}
      </div>
    </div>
  );
}
