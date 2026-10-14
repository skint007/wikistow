import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { adminRoutes } from '@wikistow/contracts';
import { createFileRoute } from '@tanstack/react-router';
import { MoreHorizontal } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { z } from 'zod';
import { FormMessage } from '@/components/layout/auth-card';
import { Name } from '@/components/name';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { api, meQuery } from '../../../api';
import { useReauth } from '../../../auth/reauth';
import { errorMessage } from '../../../errors';

export const Route = createFileRoute('/_app/admin/')({ component: Accounts });

type Account = z.infer<typeof adminRoutes.AdminAccount>;
const accountsQuery = {
  queryKey: ['admin', 'accounts'],
  queryFn: () => api.call(adminRoutes.listAccounts),
};

/** An action on an account, and what to say once it is done. */
type Action = { run: () => Promise<unknown>; done: string };

const date = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : 'Never');

/** What to call an account: its name, or its address until its owner sets it up. */
const called = (account: Account) => account.name || account.email;

function Accounts() {
  const { data } = useQuery(accountsQuery);
  const { data: me } = useQuery(meQuery);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const withReauth = useReauth();

  const act = useMutation({
    mutationFn: ({ run }: Action) => withReauth(run),
    onMutate: () => {
      setError(null);
      setNotice(null);
    },
    onSuccess: (_result, { done }) => setNotice(done),
    onError: (caught) => setError(errorMessage(caught)),
    onSettled: () => queryClient.invalidateQueries({ queryKey: accountsQuery.queryKey }),
  });

  const [confirming, setConfirming] = useState<{
    label: string;
    body: ReactNode;
    action: Action;
  } | null>(null);

  const actions = (account: Account): (Action & { label: string; confirm?: ReactNode })[] => {
    const params = { id: account.id };
    const who = called(account);
    const items = [
      account.role === 'admin'
        ? {
            label: 'Remove administrator',
            run: () => api.call(adminRoutes.setRole, { params, body: { role: 'user' } }),
            done: `${who} is no longer an administrator.`,
          }
        : {
            label: 'Make administrator',
            run: () => api.call(adminRoutes.setRole, { params, body: { role: 'admin' } }),
            done: `${who} is now an administrator.`,
          },
      account.suspended
        ? {
            label: 'Reactivate',
            run: () => api.call(adminRoutes.reactivate, { params }),
            done: `${who} can sign in again.`,
          }
        : {
            label: 'Suspend',
            run: () => api.call(adminRoutes.suspend, { params }),
            done: `${who} is suspended and signed out.`,
          },
      {
        label: 'Revoke sessions and agents',
        run: () => api.call(adminRoutes.revokeSessions, { params }),
        done: `${who} is signed out everywhere, and their agents are cut off.`,
        confirm: (
          <>
            <Name>{who}</Name> is signed out on every device, and every agent they enrolled stops
            working at once, for good. The agents keep any keys they already hold, but can’t fetch
            anything more; to use one again, <Name>{who}</Name> enrolls it anew. Their vault and
            pages don’t change.
          </>
        ),
      },
    ];
    if (!account.emailVerified)
      items.push({
        label: 'Resend verification email',
        run: () => api.call(adminRoutes.resendVerification, { params }),
        done: `Sent a new link to ${account.email}.`,
      });
    return items;
  };

  return (
    <Card className="rounded-card shadow-card">
      <CardHeader>
        <CardTitle className="text-lg font-extrabold">Accounts</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        {error && <FormMessage>{error}</FormMessage>}
        {notice && <FormMessage tone="notice">{notice}</FormMessage>}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Sessions</TableHead>
              <TableHead>Last seen</TableHead>
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data?.accounts.map((account) => (
              <TableRow key={account.id}>
                <TableCell className="font-bold">
                  {account.name || (
                    <span className="font-normal text-muted-foreground">Not set up yet</span>
                  )}
                </TableCell>
                <TableCell>{account.email}</TableCell>
                <TableCell className="flex flex-wrap gap-1">
                  {account.role === 'admin' && <Badge>Admin</Badge>}
                  {account.suspended && <Badge variant="destructive">Suspended</Badge>}
                  {!account.emailVerified && <Badge variant="outline">Unverified</Badge>}
                  {account.twoFactorEnabled && <Badge variant="secondary">2FA</Badge>}
                </TableCell>
                <TableCell>{account.sessionCount}</TableCell>
                <TableCell>{date(account.lastSeenAt)}</TableCell>
                <TableCell className="text-right">
                  {account.id !== me?.account.id && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Actions for ${called(account)}`}
                        >
                          <MoreHorizontal strokeWidth={1.75} />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {actions(account).map(({ label, run, done, confirm }) => (
                          <DropdownMenuItem
                            key={label}
                            onSelect={() =>
                              confirm
                                ? setConfirming({ label, body: confirm, action: { run, done } })
                                : act.mutate({ run, done })
                            }
                          >
                            {label}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
      <Dialog open={confirming !== null} onOpenChange={(open) => !open && setConfirming(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{confirming?.label}?</DialogTitle>
            <DialogDescription>{confirming?.body}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirming(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (confirming) act.mutate(confirming.action);
                setConfirming(null);
              }}
            >
              {confirming?.label}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
