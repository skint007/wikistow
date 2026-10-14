import { bootstrapAdmin, createInvitation, inspectInvitation, schema } from '@wikistow/server';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vite-plus/test';
import { signedInPerson } from './support/accounts.ts';
import { createTestApp, type TestApp } from './support/harness.ts';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.drop());

it('reserves an identity ID after deleting its account and keys', async () => {
  const owner = await signedInPerson(t);
  const replacement = await signedInPerson(t);
  const identity = {
    id: 'reserved-person',
    accountId: owner.id,
    kind: 'human' as const,
    keyVersion: 1,
    boxPublicKey: 'box-key',
    signPublicKey: 'sign-key',
  };
  await t.db.insert(schema.identities).values(identity);
  await t.db.delete(schema.users).where(eq(schema.users.id, owner.id));
  expect(await t.db.select().from(schema.identities)).toEqual([]);
  expect(await t.db.select().from(schema.identityReservations)).toEqual([
    { id: identity.id, accountId: owner.id },
  ]);
  await expect(
    t.db
      .insert(schema.identities)
      .values({ ...identity, accountId: replacement.id, keyVersion: 2 }),
  ).rejects.toThrow();
  await expect(t.db.delete(schema.identityReservations)).rejects.toThrow();
});

it("revokes a deleted administrator's links and lets bootstrap run again", async () => {
  const admin = await signedInPerson(t, 'admin');
  const { token, invitation } = await createInvitation(t.db, {
    email: null,
    role: 'admin',
    createdBy: admin.id,
  });
  await t.db.delete(schema.users).where(eq(schema.users.id, admin.id));
  const [link] = await t.db
    .select()
    .from(schema.invitations)
    .where(eq(schema.invitations.id, invitation.id));
  expect(link).toMatchObject({ kind: 'account', createdBy: null, revokedAt: expect.any(Date) });
  expect(await inspectInvitation(t.db, token)).toEqual({ status: 'revoked' });
  expect(await bootstrapAdmin(t.db, 'next-admin@example.test')).toMatchObject({ kind: 'invited' });
});
