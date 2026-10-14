import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { adminRoutes } from '@wikistow/contracts';
import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Field } from '@/components/form/field';
import { FormMessage } from '@/components/layout/auth-card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { api } from '../../../api';
import { useReauth } from '../../../auth/reauth';
import { errorMessage } from '../../../errors';

export const Route = createFileRoute('/_app/admin/invitations')({ component: Invitations });

const invitationsQuery = {
  queryKey: ['admin', 'invitations'],
  queryFn: () => api.call(adminRoutes.listInvitations),
};

const Values = z.object({
  email: z.union([
    z.literal(''),
    z.string().trim().email('Enter an email address, or leave it empty'),
  ]),
  role: z.enum(['user', 'admin']),
});

function Invitations() {
  const { data } = useQuery(invitationsQuery);
  const queryClient = useQueryClient();
  const withReauth = useReauth();
  const [link, setLink] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'error' | 'notice'; text: string } | null>(null);
  const form = useForm({
    resolver: zodResolver(Values),
    defaultValues: { email: '', role: 'user' as const },
  });
  const { errors, isSubmitting } = form.formState;

  const refresh = () => queryClient.invalidateQueries({ queryKey: invitationsQuery.queryKey });
  const fail = (caught: unknown) => setMessage({ tone: 'error', text: errorMessage(caught) });

  const submit = form.handleSubmit(async ({ email, role }) => {
    setMessage(null);
    setLink(null);
    try {
      const created = await withReauth(() =>
        api.call(adminRoutes.createInvitation, { body: { email: email || null, role } }),
      );
      setLink(created.link);
      setMessage({
        tone: 'notice',
        text: email ? `Invitation sent to ${email}.` : 'Invitation link created.',
      });
      form.reset();
    } catch (caught) {
      fail(caught);
    }
    await refresh();
  });

  const resend = useMutation({
    mutationFn: (id: string) =>
      withReauth(() => api.call(adminRoutes.resendInvitation, { params: { id } })),
    onSuccess: (result) => {
      setLink(result.link);
      setMessage({ tone: 'notice', text: 'A new link replaced the old one.' });
    },
    onError: fail,
    onSettled: refresh,
  });
  const revoke = useMutation({
    mutationFn: (id: string) =>
      withReauth(() => api.call(adminRoutes.revokeInvitation, { params: { id } })),
    onSuccess: () => setMessage({ tone: 'notice', text: 'Invitation withdrawn.' }),
    onError: fail,
    onSettled: refresh,
  });

  return (
    <div className="grid gap-3.5">
      <Card className="rounded-card shadow-card">
        <CardHeader>
          <CardTitle className="text-lg font-extrabold">Invite someone</CardTitle>
          <CardDescription>
            With an email address, the link is mailed to them. Without one, you get a single-use
            link to pass on.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="grid max-w-sm gap-4" noValidate>
            <Field
              id="invite-email"
              label="Email (optional)"
              type="email"
              error={errors.email?.message}
              {...form.register('email')}
            />
            <fieldset className="grid gap-2">
              <legend className="mb-2 text-sm font-medium">Role</legend>
              {(['user', 'admin'] as const).map((role) => (
                <Label key={role} className="font-normal">
                  <input type="radio" value={role} {...form.register('role')} />
                  {role === 'admin' ? 'Administrator' : 'Member'}
                </Label>
              ))}
            </fieldset>
            <Button type="submit" disabled={isSubmitting} className="justify-self-start">
              Create invitation
            </Button>
          </form>
        </CardContent>
      </Card>
      {message && <FormMessage tone={message.tone}>{message.text}</FormMessage>}
      {link && (
        <div className="grid gap-2 rounded-control bg-muted p-3">
          <p className="text-sm font-bold">Single-use link, shown only now</p>
          <code className="break-all font-mono text-sm" data-testid="invitation-link">
            {link}
          </code>
          <Button
            variant="outline"
            size="sm"
            className="justify-self-start"
            onClick={() => void navigator.clipboard.writeText(link)}
          >
            Copy link
          </Button>
        </div>
      )}
      <Card className="rounded-card shadow-card">
        <CardHeader>
          <CardTitle className="text-lg font-extrabold">Pending invitations</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>For</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data?.invitations.map((invitation) => (
                <TableRow key={invitation.id}>
                  <TableCell>{invitation.email ?? 'Anyone with the link'}</TableCell>
                  <TableCell>
                    {invitation.role === 'admin' ? <Badge>Admin</Badge> : 'Member'}
                  </TableCell>
                  <TableCell>{new Date(invitation.expiresAt).toLocaleDateString()}</TableCell>
                  <TableCell className="flex justify-end gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => resend.mutate(invitation.id)}
                    >
                      {invitation.email ? 'Resend' : 'New link'}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => revoke.mutate(invitation.id)}>
                      Withdraw
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
