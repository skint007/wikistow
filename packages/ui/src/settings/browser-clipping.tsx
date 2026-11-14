import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { ClipBrowser, ClippingState, DesktopBridge } from '@wikistow/contracts';
import { FormMessage } from '@/components/layout/auth-card';
import { Switch } from '@/components/ui/switch';
import { errorMessage } from '../errors';
import { useVault } from '../vault/store';
import { SettingRow, THIS_DEVICE } from './rows';

const BROWSER_NAMES: Record<ClipBrowser, string> = {
  chrome: 'Chrome',
  chromium: 'Chromium',
  edge: 'Edge',
  brave: 'Brave',
  firefox: 'Firefox',
};

const clippingKey = ['desktop-clipping'];

/** Browsers, as a sentence's list: "Chrome, Edge and Firefox". */
function browserList(browsers: ClipBrowser[]) {
  const names = browsers.map((browser) => BROWSER_NAMES[browser]);
  return names.length < 2
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

function clippingState(state: ClippingState | undefined) {
  if (!state) return null;
  if (!state.on) return 'Browser extensions can’t reach WikiStow on this computer.';
  switch (state.problem) {
    case 'translocated':
      return 'Move WikiStow into Applications, then open it again, to clip from your browser.';
    case 'development':
      return 'This copy sets up no browser. To try clipping in a development build, build the helper with scripts/clip-host.sh and start it with --clip-manifests.';
    case 'unavailable':
      return 'WikiStow couldn’t start listening for your browser. Quit and open it again to try again.';
  }
  return state.browsers.length === 0
    ? 'The WikiStow extension can save pages here as drafts. No browser it works with is set up on this computer yet; WikiStow looks again each time it opens.'
    : `The WikiStow extension in ${browserList(state.browsers)} can save pages here as drafts.`;
}

/**
 * **Browser clipping** in the desktop app (ADR 0017, decision 2): whether
 * the WikiStow extension can reach the app on this computer. Off, the app
 * closes its socket and deletes the browsers' host manifests. Under it,
 * this session's last ten clips, each a link to its draft (decision 3).
 */
export function BrowserClipping({ desktop }: { desktop: DesktopBridge }) {
  const queryClient = useQueryClient();
  // The clips' titles and paths are the vault's: shown only while it's
  // open, and asked for again as it opens or locks.
  const unlocked = useVault().status === 'unlocked';
  const key = [...clippingKey, unlocked];
  // Read again on each visit, as clips land meanwhile.
  const { data } = useQuery({
    queryKey: key,
    queryFn: () => desktop.clipping(),
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const change = useMutation({
    mutationFn: (on: boolean) => desktop.setClipping(on),
    onSuccess: (state) => queryClient.setQueryData(key, state),
  });
  return (
    <SettingRow
      name="Browser clipping"
      scope={THIS_DEVICE}
      state={clippingState(data)}
      action={
        <Switch
          aria-label="Browser clipping"
          checked={data?.on ?? false}
          disabled={!data || change.isPending}
          onCheckedChange={(on) => change.mutate(on)}
        />
      }
    >
      {change.error && <FormMessage>{errorMessage(change.error)}</FormMessage>}
      {unlocked && data && data.recent.length > 0 && (
        <div className="grid gap-1">
          <h4 className="text-[13px] font-bold text-muted-foreground">
            Clipped since WikiStow opened
          </h4>
          <ul aria-label="Clipped since WikiStow opened" className="grid gap-0.5 text-sm">
            {data.recent.map((clip) => (
              <li key={`${clip.spaceId}/${clip.pageId}`} className="truncate">
                <Link
                  to="/s/$spaceId/p/$pageId"
                  params={{ spaceId: clip.spaceId, pageId: clip.pageId }}
                  className="quiet-link"
                >
                  {clip.title}
                </Link>{' '}
                <span className="text-muted-foreground">in {clip.path}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </SettingRow>
  );
}
