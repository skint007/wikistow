import { relations } from 'drizzle-orm';
import { accounts } from './accounts.ts';
import { sessions } from './sessions.ts';
import { users } from './users.ts';

// The joins Better Auth asks for (`advanced.database.joins` in auth.ts), so
// each lookup is one query whatever it finds. A sign-in for a known address
// reads its accounts in the same query as for an unknown one, not a second.
// Relations are TypeScript only; they change no tables or migrations.

export const usersRelations = relations(users, ({ many }) => ({
  accounts: many(accounts),
}));

export const accountsRelations = relations(accounts, ({ one }) => ({
  user: one(users, { fields: [accounts.userId], references: [users.id] }),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
}));
