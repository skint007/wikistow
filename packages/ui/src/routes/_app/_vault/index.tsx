import { spaceOperations } from '@wikistow/client';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { spacesQuery } from '../../../data/queries';
import { vaultStore } from '../../../vault/store';

/** Home opens the first space, creating "Personal" if there is none yet. */
export const Route = createFileRoute('/_app/_vault/')({
  beforeLoad: async ({ context }) => {
    const vault = vaultStore.get();
    if (vault.status !== 'unlocked') return;
    let spaces = await context.queryClient.fetchQuery(spacesQuery(vault.ctx));
    if (spaces.length === 0) {
      await spaceOperations.createSpace(vault.ctx, { name: 'Personal', emoji: '🏠' });
      spaces = await context.queryClient.fetchQuery({ ...spacesQuery(vault.ctx), staleTime: 0 });
    }
    const [first] = spaces;
    if (first) throw redirect({ to: '/s/$spaceId', params: { spaceId: first.id } });
  },
});
