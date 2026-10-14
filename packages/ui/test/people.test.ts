import {
  generateIdentity,
  IdentityId,
  InstallationId,
  keyHash,
  newContactsPayloads,
  TrustStore,
  type PublicIdentity,
} from '@wikistow/client';
import { describe, expect, it } from 'vite-plus/test';
import { describePerson } from '../src/sharing/people';

const self = generateIdentity({ id: IdentityId.parse('self'), kind: 'human' });
const fern = generateIdentity({ id: IdentityId.parse('fern'), kind: 'human' });
const entry = (identity: PublicIdentity, name: string) => ({
  identity,
  name,
  email: `${identity.id}@example.org`,
});

// A session that has pinned Fern, with `label` as her label if given.
function viewer(label?: string) {
  const trust = new TrustStore(InstallationId.parse('test'), () => new Date());
  trust.pinSelf(self);
  const payloads = newContactsPayloads();
  if (label !== undefined) {
    trust.use({ ...entry(fern.public, 'Fern'), foundBy: null });
    payloads.shared.contacts.push({
      identity: { ...fern.public, kind: 'human' },
      verifiedAt: '2026-10-01T09:00:00.000Z',
      method: 'first-seen',
    });
    if (label) {
      payloads.private.labels.push({
        id: fern.public.id,
        keyHash: keyHash(fern.public),
        name: label,
        email: 'fern@example.org',
      });
    }
  }
  return { identity: self, contacts: { book: { payloads } }, trust };
}

describe('naming someone in a sharing dialog', () => {
  it('names a pinned person by their label, never the directory', () => {
    const fernAsServed = entry(fern.public, 'Someone Else');
    const person = describePerson(viewer('Fern'), fern.public.id, fernAsServed);
    expect(person).toMatchObject({ name: 'Fern', email: 'fern@example.org', nameless: false });
  });
});
