import { defineConfig } from 'drizzle-kit';

// Only `drizzle-kit generate` uses this, and it never connects to a database.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './drizzle',
  casing: 'snake_case',
});
