import { eq } from 'drizzle-orm';
import type { Database } from '../db/client.ts';
import { settings } from '../db/schema/index.ts';
import {
  aiSettingsOf,
  changedFields,
  mailSettingsOf,
  settingsSecrets,
  type AiSettings,
  type MailSettings,
  type SettingsChanges,
} from '../settings.ts';
import { asAdmin } from './accounts.ts';
import { audit } from './audit.ts';

/** The settings row, locked until the transaction ends, so saves don't interleave. */
async function lockedSettings(tx: Database) {
  const [row] = await tx.select().from(settings).where(eq(settings.id, 1)).for('update');
  if (!row) throw new Error('settings row missing; were migrations applied?');
  return row;
}

/**
 * Save the mail settings an administrator changed. A field left out keeps
 * its value; a null clears it. The audit event names the fields that
 * changed, never their values. Returns the settings as saved.
 */
export function saveMailSettings(
  db: Database,
  authSecret: string,
  { actor, changes }: { actor: string; changes: SettingsChanges<MailSettings> },
): Promise<MailSettings> {
  return asAdmin(db, actor, async (tx) => {
    const row = await lockedSettings(tx);
    const current = mailSettingsOf(row, authSecret);
    const changed = changedFields(current, changes);
    if (changed.length === 0) return current;
    const { password } = changes;
    const [saved] = await tx
      .update(settings)
      .set({
        smtpHost: changes.host,
        smtpPort: changes.port,
        smtpSecurity: changes.security,
        smtpUsername: changes.username,
        smtpPassword:
          password == null
            ? password
            : settingsSecrets(authSecret, row).seal('smtpPassword', password),
        smtpFrom: changes.from,
      })
      .returning();
    await audit(tx, {
      actor,
      action: 'settings.mail-updated',
      target: { kind: 'settings', id: '1' },
      details: { changed },
    });
    return saved ? mailSettingsOf(saved, authSecret) : current;
  });
}

/** Save the AI provider settings an administrator changed, as `saveMailSettings` does. */
export function saveAiSettings(
  db: Database,
  authSecret: string,
  { actor, changes }: { actor: string; changes: SettingsChanges<AiSettings> },
): Promise<AiSettings> {
  return asAdmin(db, actor, async (tx) => {
    const row = await lockedSettings(tx);
    const current = aiSettingsOf(row, authSecret);
    const changed = changedFields(current, changes);
    if (changed.length === 0) return current;
    const { apiKey } = changes;
    const [saved] = await tx
      .update(settings)
      .set({
        aiStyle: changes.style,
        aiBaseUrl: changes.baseUrl,
        aiApiKey:
          apiKey == null ? apiKey : settingsSecrets(authSecret, row).seal('aiApiKey', apiKey),
        aiModel: changes.model,
        aiMaxOutputTokens: changes.maxOutputTokens,
        aiRequestsPerMinute: changes.requestsPerMinute,
      })
      .returning();
    await audit(tx, {
      actor,
      action: 'settings.ai-updated',
      target: { kind: 'settings', id: '1' },
      details: { changed },
    });
    return saved ? aiSettingsOf(saved, authSecret) : current;
  });
}
