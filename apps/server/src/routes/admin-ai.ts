import { adminRoutes } from '@wikistow/contracts';
import {
  readAiSettings,
  saveAiSettings,
  withChanges,
  type AiSettings,
  type Database,
} from '@wikistow/server';
import type { z } from 'zod';
import { listModels } from '../ai/models.ts';
import type { Config } from '../config.ts';
import { ApiError } from '../http/errors.ts';
import type { Log } from '../http/logger.ts';
import type { Routes } from '../http/mount.ts';
import { aiFromEnvironment, aiSetup } from '../settings.ts';
import { toApiError } from './accounts.ts';
import { checkAi } from './ai.ts';

/**
 * The AI assistant card on the admin page: its settings, the provider's
 * models, and a connection check with the form's values. Fields an `AI_*`
 * variable sets are shown empty and ignored in what the form sends.
 */
export function mountAdminAiRoutes(
  routes: Routes,
  { db, config, log }: { db: Database; config: Config; log: Log },
): void {
  const env = config.ai ?? {};
  const environment = aiFromEnvironment(env);
  const shown = (field: (typeof environment)[number]) => !environment.includes(field);
  const view = (saved: AiSettings) => ({
    style: shown('style') ? saved.style : null,
    baseUrl: shown('baseUrl') ? saved.baseUrl : null,
    apiKeySaved: shown('apiKey') && saved.apiKey !== null,
    model: shown('model') ? saved.model : null,
    maxOutputTokens: shown('maxOutputTokens') ? saved.maxOutputTokens : null,
    requestsPerMinute: shown('requestsPerMinute') ? saved.requestsPerMinute : null,
    environment,
    enabled: aiSetup(env, saved) !== null,
  });
  /** The form's values, less the fields the environment sets. */
  const editable = (form: z.output<typeof adminRoutes.AiForm>) => {
    const changes = { ...form };
    for (const field of environment) delete changes[field];
    return changes;
  };
  /** The saved settings with the form's values over them. */
  const formed = async (form: z.output<typeof adminRoutes.AiForm>) =>
    withChanges(await readAiSettings(db, config.authSecret), editable(form));

  routes.admin(adminRoutes.getAiSettings, async () =>
    view(await readAiSettings(db, config.authSecret)),
  );

  routes.admin(adminRoutes.updateAiSettings, async ({ body }, { principal }) => {
    const saved = await saveAiSettings(db, config.authSecret, {
      actor: principal.accountId,
      changes: editable(body),
    }).catch(toApiError);
    return view(saved);
  });

  routes.admin(
    adminRoutes.listAiModels,
    async ({ body }, { c }) => {
      const values = await formed(body);
      const style = env.style ?? values.style;
      const baseUrl = env.baseUrl ?? values.baseUrl;
      if (!style || !baseUrl) {
        throw new ApiError('invalid-request', 'Choose the API style and base URL first.');
      }
      return listModels(
        {
          style,
          baseUrl: baseUrl.replace(/\/+$/, ''),
          apiKey: env.apiKey ?? values.apiKey ?? undefined,
        },
        c.req.raw.signal,
      );
    },
    { rateLimit: { windowSeconds: 60, max: 30 } },
  );

  routes.admin(
    adminRoutes.checkAi,
    async ({ body }, { c }) => {
      const ai = aiSetup(env, await formed(body));
      if (!ai) {
        throw new ApiError('invalid-request', 'Fill in the API style, base URL and model first.');
      }
      return checkAi(ai, c.req.raw.signal, log);
    },
    { rateLimit: { windowSeconds: 60, max: 10 } },
  );
}
