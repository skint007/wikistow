import { createAiSession, type AiSession, type AiSessionOptions } from '@wikistow/client';
import { aiRoutes } from '@wikistow/contracts';
import { queryOptions } from '@tanstack/react-query';
import { api } from '../api';
import { vaultStore } from '../vault/store';

/** Whether this server has AI set up, and with which provider and model. */
export const aiStatusQuery = queryOptions({
  queryKey: ['ai-status'],
  queryFn: () => api.call(aiRoutes.status),
  staleTime: 5 * 60_000,
});

const open = new Set<AiSession>();
let watching = false;

/**
 * Start an AI conversation while the vault is open (`createAiSession`).
 * Locking the vault, which signing out and a lost session do too, closes
 * every open conversation: its reply stops, anything arriving later is
 * dropped without running a tool, and the conversation is forgotten.
 */
export function openAiSession(options: AiSessionOptions = {}): AiSession {
  if (vaultStore.get().status !== 'unlocked') throw new Error('The vault is locked');
  if (!watching) {
    watching = true;
    vaultStore.subscribe(() => {
      if (vaultStore.get().status !== 'locked') return;
      for (const session of [...open]) session.close();
    });
  }
  const session = createAiSession(options);
  open.add(session);
  const unsubscribe = session.subscribe(() => {
    if (session.state().status !== 'closed') return;
    open.delete(session);
    unsubscribe();
  });
  return session;
}
