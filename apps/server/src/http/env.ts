/** Hono context variables. Routes get the signed-in account from their mount helper instead. */
export type AppEnv = { Variables: Record<string, never> };
