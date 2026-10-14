import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { adminRoutes } from '@wikistow/contracts';
import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { FormMessage } from '@/components/layout/auth-card';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { api } from '../../../api';
import { useReauth } from '../../../auth/reauth';
import { errorMessage } from '../../../errors';

export const Route = createFileRoute('/_app/admin/settings')({ component: Registration });

const settingsQuery = {
  queryKey: ['admin', 'settings'],
  queryFn: () => api.call(adminRoutes.getSettings),
};

function Registration() {
  const { data } = useQuery(settingsQuery);
  const queryClient = useQueryClient();
  const withReauth = useReauth();
  const [error, setError] = useState<string | null>(null);
  const update = useMutation({
    mutationFn: (open: boolean) =>
      withReauth(() =>
        api.call(adminRoutes.updateSettings, { body: { publicRegistration: open } }),
      ),
    onMutate: () => setError(null),
    onError: (caught) => setError(errorMessage(caught)),
    onSettled: () => queryClient.invalidateQueries({ queryKey: settingsQuery.queryKey }),
  });

  return (
    <Card className="rounded-card shadow-card">
      <CardHeader>
        <CardTitle className="text-lg font-extrabold">Registration</CardTitle>
        <CardDescription>
          Closed by default: people join only with an invitation. Open it to let anyone with the
          address create an account.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="flex items-center gap-3">
          <Switch
            id="public-registration"
            checked={data?.publicRegistration ?? false}
            disabled={!data || update.isPending}
            onCheckedChange={(open) => update.mutate(open)}
          />
          <Label htmlFor="public-registration">Anyone can create an account</Label>
        </div>
        {error && <FormMessage>{error}</FormMessage>}
      </CardContent>
    </Card>
  );
}
