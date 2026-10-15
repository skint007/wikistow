import { ApiError } from '@wikistow/client/api';
import { accountRoutes } from '@wikistow/contracts';
import { createContext, use, useCallback, useRef, useState, type ReactNode } from 'react';
import { submitData } from '@/components/form/submit';
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
import { api } from '../api';
import { errorMessage } from '../errors';

type Pending = { resolve: (ok: boolean) => void };
type Reauth = <T>(action: () => Promise<T>) => Promise<T>;
const Context = createContext<Reauth | null>(null);

/** From our API client, or from Better Auth's, which keeps our error body as `error`. */
function needsReauth(error: unknown): boolean {
  if (error instanceof ApiError) return error.code === 'reauth-required';
  if (typeof error !== 'object' || error === null || !('error' in error)) return false;
  const body = error.error;
  return (
    typeof body === 'object' && body !== null && 'code' in body && body.code === 'reauth-required'
  );
}

/**
 * Sensitive changes need a sign-in from the last few minutes. `withReauth`
 * runs an action; if the server asks for a fresh sign-in, it shows a dialog
 * for the password (and a code when two-factor is on), then retries once.
 * The server marks the current session as recent rather than starting a new
 * one, so the tab stays signed in at every step, cancelling included.
 */
export function ReauthProvider({ children }: { children: ReactNode }) {
  const pending = useRef<Pending | null>(null);
  // Held between the steps: the code is checked together with the password.
  const password = useRef('');
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<'password' | 'code'>('password');
  const [backup, setBackup] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const ask = useCallback(
    () =>
      new Promise<boolean>((resolve) => {
        pending.current = { resolve };
        setStep('password');
        setBackup(false);
        setError(null);
        setOpen(true);
      }),
    [],
  );

  const finish = (ok: boolean) => {
    pending.current?.resolve(ok);
    pending.current = null;
    password.current = '';
    setOpen(false);
  };

  const withReauth = useCallback<Reauth>(
    async (action) => {
      try {
        return await action();
      } catch (error) {
        if (!needsReauth(error) || !(await ask())) throw error;
        return action();
      }
    },
    [ask],
  );

  async function submit(form: FormData) {
    setBusy(true);
    setError(null);
    try {
      if (step === 'password') {
        const entered = form.get('password');
        if (typeof entered !== 'string') return;
        const body = { password: entered };
        const { status } = await api.call(accountRoutes.reauthenticate, { body });
        if (status === 'confirmed') return finish(true);
        password.current = entered;
        setStep('code');
      } else {
        const value = form.get('code');
        if (typeof value !== 'string') return;
        await api.call(accountRoutes.reauthenticate, {
          body: { password: password.current, code: { kind: backup ? 'backup' : 'totp', value } },
        });
        finish(true);
      }
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Context value={withReauth}>
      {children}
      <Dialog open={open} onOpenChange={(next) => !next && finish(false)}>
        <DialogContent>
          <form onSubmit={submitData(submit)} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Confirm it’s you</DialogTitle>
              <DialogDescription>
                {step === 'password'
                  ? 'This change needs a recent sign-in. Enter your password to continue.'
                  : backup
                    ? 'Enter one of your backup codes.'
                    : 'Enter the code from your authenticator app.'}
              </DialogDescription>
            </DialogHeader>
            {/* Each step, and each kind of code, gets a field of its own (`key`):
                the password never carries into the code field, which starts
                empty, and nothing clears a field once typed in. */}
            {step === 'password' ? (
              <div className="grid gap-2">
                <Label htmlFor="reauth-password">Password</Label>
                <Input
                  key="password"
                  id="reauth-password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  autoFocus
                />
              </div>
            ) : (
              <div className="grid gap-2">
                <Label htmlFor="reauth-code">{backup ? 'Backup code' : 'Code'}</Label>
                <Input
                  key={backup ? 'backup' : 'totp'}
                  id="reauth-code"
                  name="code"
                  inputMode={backup ? 'text' : 'numeric'}
                  autoComplete="one-time-code"
                  required
                  autoFocus
                />
                <button
                  type="button"
                  className="justify-self-start text-sm text-muted-foreground underline decoration-current/40 underline-offset-4 hover:text-foreground hover:decoration-current"
                  onClick={() => setBackup(!backup)}
                >
                  {backup ? 'Use your authenticator app' : 'Use a backup code instead'}
                </button>
              </div>
            )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => finish(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                Continue
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Context>
  );
}

export function useReauth(): Reauth {
  const context = use(Context);
  if (!context) throw new Error('useReauth outside ReauthProvider');
  return context;
}
