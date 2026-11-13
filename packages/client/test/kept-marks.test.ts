// The No going back marks a device keeps, across a browser's tabs (protocol
// section 6.8, accepted with ADR 0015): pending changes of a share, recorded
// before they are sent and told to every tab; clears that never come undone;
// and tabs reading the file again when told.
import { describe, expect, it } from 'vite-plus/test';
import {
  generateIdentity,
  IdentityId,
  InstallationId,
  KeptMarks,
  ShareId,
  SpaceId,
  type KeptFile,
  type MarksChannel,
} from '../src/index.ts';
import { z } from 'zod';
import { openOnDevice } from '../src/device-seal.ts';
import { canonical } from '../src/encoding.ts';
import { changePending } from '../src/key-versions.ts';

const identity = generateIdentity({ id: IdentityId.parse('alice'), kind: 'human' });
const installationId = InstallationId.parse('test-installation');
const spaceId = SpaceId.parse('space');
const shareId = ShareId.parse('share');
const other = ShareId.parse('other');
const who = { identity, installationId };

// One browser: a file its tabs share, written in turn under a lock, and a
// channel that delivers each tab's post to the others.
function browser() {
  let kept: Uint8Array | null = null;
  let turn = Promise.resolve();
  const listeners = new Set<{ from: number; listener: () => void }>();
  let tabs = 0;
  const tab = (): KeptFile => {
    const me = ++tabs;
    const channel: MarksChannel = {
      post: () => {
        for (const { from, listener } of listeners) if (from !== me) listener();
      },
      listen: (listener) => {
        const entry = { from: me, listener };
        listeners.add(entry);
        return () => listeners.delete(entry);
      },
    };
    return {
      read: async () => kept,
      write: async (sealed) => {
        kept = sealed;
      },
      exclusive: <T>(work: () => Promise<T>) => {
        const run = turn.then(work);
        turn = run.then(
          () => {},
          () => {},
        );
        return run;
      },
      channel,
    };
  };
  return { tab };
}

// The same file, without hearing the other tabs.
const withoutChannel = (file: KeptFile): KeptFile => {
  const copy = { ...file };
  delete copy.channel;
  return copy;
};

// The file as an app from before pending changes reads it: strictly.
const OldContents = z.strictObject({
  contactsMark: z.strictObject({ version: z.number().int(), contactsHash: z.string() }).nullable(),
  contactsRecord: z.string().nullable().default(null),
  marks: z.record(z.string(), z.number().int().positive()),
  restoredAt: z.iso.datetime().nullable(),
});
const readAsBefore = async (file: KeptFile) => {
  const plain = openOnDevice(
    identity,
    'trust-marks-key/v1',
    canonical('trust-marks/v1', [installationId, identity.public.id]),
    (await file.read()) ?? new Uint8Array(),
  );
  return plain && OldContents.parse(JSON.parse(new TextDecoder().decode(plain)));
};

const change = (shareId_ = shareId) => ({
  spaceId,
  shareId: shareId_,
  change: 'rotation' as const,
  fromKeyVersion: 1,
});

describe('pending changes across tabs', () => {
  it('records a change in the file before it resolves, and tells the other tabs', async () => {
    const b = browser();
    const one = await KeptMarks.open(b.tab(), who);
    const two = await KeptMarks.open(b.tab(), who);
    let told = 0;
    two.onChange(() => (told += 1));
    const [begun] = await one.begin([change()]);
    expect(begun).toMatchObject({ shareId, lost: false });
    // The other tab read the file again when told.
    await expect.poll(() => changePending(two, spaceId, shareId)).toBe(true);
    expect(told).toBeGreaterThan(0);
    // So does a later launch.
    const later = await KeptMarks.open(b.tab(), who);
    expect(changePending(later, spaceId, shareId)).toBe(true);
    expect(changePending(later, spaceId, other)).toBe(false);
  });

  it('raises the mark and clears the change on a definite answer', async () => {
    const b = browser();
    const one = await KeptMarks.open(b.tab(), who);
    const two = await KeptMarks.open(b.tab(), who);
    const [begun] = await one.begin([change()]);
    await one.settle([begun?.id ?? ''], [{ spaceId, shareId, keyVersion: 2 }]);
    expect(one.get(spaceId, shareId)).toBe(2);
    expect(changePending(one, spaceId, shareId)).toBe(false);
    await expect.poll(() => two.get(spaceId, shareId)).toBe(2);
    await expect.poll(() => changePending(two, spaceId, shareId)).toBe(false);
  });

  it('never brings back a cleared change, whatever a tab that missed the clear writes', async () => {
    const b = browser();
    const one = await KeptMarks.open(b.tab(), who);
    // A tab that never hears the others.
    const deaf = await KeptMarks.open(withoutChannel(b.tab()), who);
    const [begun] = await one.begin([change()]);
    await deaf.refresh();
    expect(changePending(deaf, spaceId, shareId)).toBe(true);
    await one.settle([begun?.id ?? ''], []);
    // The deaf tab still holds the change, and writes something else.
    deaf.raise(spaceId, other, 5);
    await expect.poll(async () => (await KeptMarks.open(b.tab(), who)).get(spaceId, other)).toBe(5);
    const later = await KeptMarks.open(b.tab(), who);
    expect(changePending(later, spaceId, shareId)).toBe(false);
    expect(changePending(deaf, spaceId, shareId)).toBe(false);
  });

  it('never drops a change another tab began meanwhile', async () => {
    const b = browser();
    const one = await KeptMarks.open(b.tab(), who);
    const two = await KeptMarks.open(withoutChannel(b.tab()), who);
    await Promise.all([one.begin([change()]), two.begin([change(other)])]);
    const later = await KeptMarks.open(b.tab(), who);
    expect(changePending(later, spaceId, shareId)).toBe(true);
    expect(changePending(later, spaceId, other)).toBe(true);
  });

  it('holds a share for a kind of change a newer app recorded', async () => {
    const b = browser();
    const newer = await KeptMarks.open(b.tab(), who);
    // A newer app's kind, kept among the marks as this app keeps its own.
    newer.raise(
      '~change newer-id' as SpaceId,
      `${spaceId} ${shareId} renaming 1` as ShareId,
      Date.now(),
    );
    await expect
      .poll(async () => changePending(await KeptMarks.open(b.tab(), who), spaceId, shareId))
      .toBe(true);
    const later = await KeptMarks.open(b.tab(), who);
    expect(later.pending().map((c) => c.change)).toEqual(['renaming']);
  });

  it('tells this tab’s own listeners of its own changes', async () => {
    const b = browser();
    const one = await KeptMarks.open(b.tab(), who);
    let told = 0;
    one.onChange(() => (told += 1));
    await one.begin([change()]);
    expect(told).toBeGreaterThan(0);
    one.close();
    expect(one.pending()).toEqual([]);
  });

  it('keeps a change whose answer was lost, marked so', async () => {
    const b = browser();
    const one = await KeptMarks.open(b.tab(), who);
    const [begun] = await one.begin([change()]);
    await one.lose([begun?.id ?? '']);
    const later = await KeptMarks.open(b.tab(), who);
    expect(later.pending()).toMatchObject([{ id: begun?.id, lost: true }]);
  });

  it('takes in other tabs’ higher marks when told, though it raised none itself', async () => {
    const b = browser();
    const one = await KeptMarks.open(b.tab(), who);
    const two = await KeptMarks.open(b.tab(), who);
    one.raise(spaceId, shareId, 4);
    await expect.poll(() => two.get(spaceId, shareId)).toBe(4);
  });

  it('writes a file an app from before pending changes still opens, keeping them', async () => {
    const b = browser();
    const file = b.tab();
    const one = await KeptMarks.open(file, who);
    one.raise(spaceId, shareId, 3);
    const [begun] = await one.begin([{ ...change(), fromKeyVersion: 3 }]);
    const old = await readAsBefore(file);
    expect(old?.marks[`${spaceId} ${shareId}`]).toBe(3);
    // It keeps every mark it finds, so the change survives its writes.
    expect(Object.keys(old?.marks ?? {}).some((key) => key.includes(begun?.id ?? '?'))).toBe(true);
  });

  it('refuses to begin a change it can’t record, so it is never sent', async () => {
    const failing: KeptFile = {
      read: () => Promise.resolve(null),
      write: () => Promise.reject(new Error('Quota exceeded')),
    };
    const marks = await KeptMarks.open(failing, who);
    const heard: boolean[] = [];
    marks.onChange(() => heard.push(changePending(marks, spaceId, shareId)));
    await expect(marks.begin([change()])).rejects.toThrow('Quota exceeded');
    // Listeners last heard it isn't pending.
    expect(heard.at(-1) ?? false).toBe(false);
    // Never sent, so it holds nothing here either.
    expect(changePending(marks, spaceId, shareId)).toBe(false);
    marks.close();
    await expect(marks.begin([change()])).rejects.toThrow();
  });

  it('never lets a write queued before it carry a change it couldn’t record', async () => {
    let kept: Uint8Array | null = null;
    let writes = 0;
    const file: KeptFile = {
      read: () => Promise.resolve(kept),
      // The first write lands; the second, the change's own, fails.
      write: (sealed) => {
        writes += 1;
        if (writes === 2) return Promise.reject(new Error('Quota exceeded'));
        kept = sealed;
        return Promise.resolve();
      },
    };
    const marks = await KeptMarks.open(file, who);
    marks.raise(spaceId, other, 2);
    await expect(marks.begin([change()])).rejects.toThrow('Quota exceeded');
    const later = await KeptMarks.open(file, who);
    expect(later.get(spaceId, other)).toBe(2);
    expect(changePending(later, spaceId, shareId)).toBe(false);
  });

  it('keeps changes still being sent through a restore it hadn’t seen', async () => {
    const b = browser();
    const one = await KeptMarks.open(b.tab(), who);
    const two = await KeptMarks.open(withoutChannel(b.tab()), who);
    one.raise(spaceId, other, 4);
    await one.begin([change()]);
    await two.refresh();
    two.startOver('2026-11-13T00:00:00.000Z');
    await expect.poll(async () => (await KeptMarks.open(b.tab(), who)).restoredAt).not.toBeNull();
    const later = await KeptMarks.open(b.tab(), who);
    expect(later.get(spaceId, other)).toBe(0);
    expect(changePending(later, spaceId, shareId)).toBe(true);
    // And the tab that sent it, writing after, keeps it too.
    one.raise(spaceId, other, 1);
    await expect
      .poll(async () => changePending(await KeptMarks.open(b.tab(), who), spaceId, shareId))
      .toBe(true);
  });

  it('refuses a change once its marks close while it waits for the lock', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const file: KeptFile = {
      read: () => Promise.resolve(null),
      write: () => Promise.resolve(),
      exclusive: async (work) => {
        await gate;
        return work();
      },
    };
    const marks = await KeptMarks.open(file, who);
    const begun = marks.begin([change()]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    marks.close();
    release();
    await expect(begun).rejects.toThrow();
  });

  it('refuses, under the lock, a change from a version behind a mark another tab raised', async () => {
    const b = browser();
    const one = await KeptMarks.open(withoutChannel(b.tab()), who);
    const two = await KeptMarks.open(b.tab(), who);
    two.raise(spaceId, shareId, 5);
    await expect
      .poll(async () => (await KeptMarks.open(b.tab(), who)).get(spaceId, shareId))
      .toBe(5);
    // Tab one hasn't heard; its change from version 1 is refused as it records it.
    expect(one.get(spaceId, shareId)).toBe(0);
    let told = 0;
    one.onChange(() => (told += 1));
    await expect(one.begin([change()])).rejects.toMatchObject({ code: 'stale-head' });
    expect(changePending(one, spaceId, shareId)).toBe(false);
    // What it took in reached its own listeners, though its write was refused.
    expect(one.get(spaceId, shareId)).toBe(5);
    expect(told).toBeGreaterThan(0);
    const later = await KeptMarks.open(b.tab(), who);
    expect(changePending(later, spaceId, shareId)).toBe(false);
  });

  it('writes nothing for no changes', async () => {
    const marks = await KeptMarks.open(
      { read: () => Promise.resolve(null), write: () => Promise.reject(new Error('No storage')) },
      who,
    );
    await expect(marks.begin([])).resolves.toEqual([]);
  });

  it('lands an answer that comes after the app locked, but never after a sign-out', async () => {
    const b = browser();
    const file = b.tab();
    const one = await KeptMarks.open(file, who);
    const [begun] = await one.begin([change()]);
    one.close();
    await one.settle([begun?.id ?? ''], [{ spaceId, shareId, keyVersion: 2 }]);
    const later = await KeptMarks.open(b.tab(), who);
    expect(later.get(spaceId, shareId)).toBe(2);
    expect(changePending(later, spaceId, shareId)).toBe(false);
    // Signed out: the file is gone, and nothing writes it back.
    let kept: Uint8Array | null = null;
    const gone: KeptFile = {
      read: () => Promise.resolve(kept),
      write: (sealed) => {
        kept = sealed;
        return Promise.resolve();
      },
    };
    const two = await KeptMarks.open(gone, who);
    const [other] = await two.begin([change()]);
    two.close();
    kept = null;
    await two.settle([other?.id ?? ''], [{ spaceId, shareId, keyVersion: 2 }]);
    expect(kept).toBeNull();
  });

  it('stops listening once closed', async () => {
    const b = browser();
    const one = await KeptMarks.open(b.tab(), who);
    const two = await KeptMarks.open(b.tab(), who);
    two.close();
    await one.begin([change()]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(changePending(two, spaceId, shareId)).toBe(false);
  });
});
