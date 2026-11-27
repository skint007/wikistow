import {
  closeSession,
  CryptoError,
  inlineVaultCrypto,
  keepWrapper,
  keptUnlock,
  openKeptSession,
  openSession,
  replaceKeysOperations,
  sameKeys,
  vaultWrapper,
  unlocks,
  type ClientContext,
  type KeptFile,
  type UnlockedVault,
  type VaultSecret,
} from '@wikistow/client';
import { noAnswer } from '@wikistow/client/api';
import { vaultRoutes } from '@wikistow/contracts';
import { api } from '../api';
import { browserTrustMarks, keptStore } from '../data/kept-store';
import { desktop } from '../desktop';
import { forgetKeptUnlock, vaultStore } from './store';
import { forgetInBrowser, rememberedInTab, rememberInBrowser } from './tab-unlock';
import { workerVaultCrypto } from './worker-crypto';

/**
 * Where this device keeps its contacts record and No going back marks
 * between sessions (`KeptMarks`): the desktop app with a trusted secret
 * store, and the browser in its kept database; or null, as on a desktop
 * without one, which keeps them for one session.
 */
async function keptMarks(): Promise<KeptFile | null> {
  if (!desktop) return browserTrustMarks;
  const device = (await desktop.secureStorage().catch(() => false)) ? desktop : null;
  return device && { read: () => device.trustMarks(), write: (s) => device.keepTrustMarks(s) };
}

/** This device's store for offline use, or null if it can't keep anything. */
const keptContent = async () => (await keptStore().catch(() => null))?.store ?? null;

/**
 * Start the session for an unlocked vault. It keeps its marks and pages
 * for offline use where the device can (`keptMarks`, `keptStore`). With no
 * answer from the server, it opens from what the device kept (ADR 0009,
 * decision 5), to be confirmed once the server answers (`confirmSession`):
 * `vaultVersion` is the vault version it unlocked against.
 */
export async function startSession(
  vault: UnlockedVault,
  { vaultVersion }: { vaultVersion?: number } = {},
): Promise<ClientContext> {
  const [kept, content] = await Promise.all([keptMarks(), keptContent()]);
  try {
    return await openSession(api, vault, {
      ...(kept && { kept }),
      ...(content && { content }),
    });
  } catch (error) {
    const offline =
      noAnswer(error) && kept && content && vaultVersion !== undefined
        ? await openKeptSession(api, vault, { kept, content, vaultVersion })
        : null;
    if (!offline) throw error;
    return offline;
  }
}

/**
 * A passphrase that didn't open the vault wrapper this device kept, with no
 * answer from the server: it may be from after a passphrase change made
 * elsewhere since `keptAt`.
 */
export class KeptWrapperRefused extends Error {
  readonly code = 'decrypt-failed';
  readonly keptAt: Date;
  constructor(keptAt: Date) {
    super('That didn’t unlock the vault this device kept');
    this.keptAt = keptAt;
    this.name = 'KeptWrapperRefused';
  }
}

/**
 * Open the vault with `secret` and start the session. Staged until the
 * session opens, so a failure there doesn't leave the keys about. A vault key
 * needs no Argon2id, so it unlocks right here rather than in a worker. With
 * no answer from the server, it opens against the wrapper this device kept,
 * and the session opens offline. `version` is the vault version a
 * remembered unlock was taken at, checked once the server answers.
 */
export async function unlockWith(
  secret: VaultSecret,
  started: number,
  { version }: { version?: number } = {},
) {
  const crypto = secret.kind === 'vault-key' ? inlineVaultCrypto : workerVaultCrypto;
  // Locked since `started` (say, signed out while this ran): nothing opens,
  // and the keys it opened are overwritten with the staged ones.
  const lockedSince = () => vaultStore.epoch() !== started;
  const refused = () => {
    vaultStore.dropStaged();
    return new Error('The vault was locked while it opened');
  };
  const content = await keptContent();
  // Kept only once it opened to keys this device takes (section 4.6).
  const opened = await vaultWrapper(api, content, { keep: false });
  const unlocked = await crypto
    .unlock({ wrapper: opened.wrapper, secret })
    .catch((error: unknown) => {
      // From the worker, the error keeps its code but not its class.
      const code = error instanceof Error && 'code' in error ? error.code : null;
      if (opened.keptAt && code === 'decrypt-failed') {
        throw new KeptWrapperRefused(new Date(opened.keptAt));
      }
      throw error;
    });
  const vault = vaultStore.stage(unlocked);
  if (lockedSince()) throw refused();
  // Never down from the keys this device last unlocked with, nor below keys
  // the directory showed replaced them (section 4.6).
  const judged = await judgeOpened(vault, { online: !opened.keptAt });
  if (judged !== 'ok') {
    vaultStore.dropStaged();
    throw new KeysRefused(judged);
  }
  if (content && !opened.keptAt) await keepWrapper(content, opened);
  const vaultVersion = version ?? opened.version;
  const ctx = await startSession(vault, { vaultVersion });
  // The server answered the session but not the wrapper: what that skipped is checked now.
  if (opened.keptAt && !ctx.unconfirmed) ctx.unconfirmed = { vaultVersion };
  if (lockedSince()) {
    closeSession(ctx);
    throw refused();
  }
  vaultStore.unlock(ctx, vault);
  await keepAnchor(vault.identity.public).catch(() => {});
  return vault;
}

/**
 * After the vault was made, or its passphrase changed (recovery), on this
 * device: keep its wrapper, so an offline unlock takes that passphrase.
 */
export async function keepChangedWrapper(changed: Parameters<typeof keepWrapper>[1]) {
  const content = await keptContent();
  if (content) await keepWrapper(content, changed);
}

/**
 * A vault that unlocked to keys this device won't open (section 4.6, **When
 * someone else rotated**): older than keys the directory showed replaced
 * them (`replaced-elsewhere`), so unlock with the new passphrase; or keys
 * that don't follow from the ones it last unlocked with (`rollback`), which
 * may be an attack.
 */
export class KeysRefused extends Error {
  readonly code: 'keys-replaced-elsewhere' | 'keys-rollback';
  constructor(kind: 'replaced-elsewhere' | 'rollback') {
    super(
      kind === 'rollback' ? 'These keys are older than this device’s' : 'Your keys were replaced',
    );
    this.code = kind === 'rollback' ? 'keys-rollback' : 'keys-replaced-elsewhere';
    this.name = 'KeysRefused';
  }
}

/**
 * `judgeUnlock` against what this device kept, and for keys newer than its
 * anchor, opened online, the directory's chain too: the anchor moves only
 * to keys a valid chain from it reaches (section 4.6). Offline, the wrapper
 * is the one this device kept, which never moved past keys it took.
 */
export async function judgeOpened(
  vault: UnlockedVault,
  { online }: { online: boolean },
): Promise<'ok' | 'replaced-elsewhere' | 'rollback'> {
  const kept = await keptAnchor();
  const judged = replaceKeysOperations.judgeUnlock(kept, vault);
  const at = vault.identity.public;
  if (judged !== 'ok' || !kept || !online || at.keyVersion <= kept.anchor.keyVersion) {
    return judged;
  }
  const check = await replaceKeysOperations.checkKeys(api, kept.anchor);
  return check.kind === 'replaced' && sameKeys(check.current, at) ? 'ok' : 'rollback';
}

/** The anchor this device kept, or null where it keeps nothing, which takes the server's word (A15). */
export async function keptAnchor() {
  const content = await keptContent();
  return content ? keptUnlock(content).anchor() : null;
}

/** Move the anchor to keys this device unlocked with or replaced its keys with. */
export async function keepAnchor(identity: UnlockedVault['identity']['public']) {
  const content = await keptContent();
  if (content) await keptUnlock(content).keepAnchor({ anchor: identity, successor: null });
}

/**
 * Before anything kept is replaced or forgotten because the vault changed,
 * or a passphrase is asked for: what the directory says of the key this
 * device last unlocked with (`checkKeys`). A valid chain to keys it doesn't
 * hold is recorded beside the anchor, so the device opens nothing older
 * until it unlocks at those keys. With no answer, a successor recorded
 * before; null where nothing is kept or recorded.
 */
export async function checkKeptKeys(): Promise<replaceKeysOperations.KeysCheck | null> {
  const content = await keptContent();
  const kept = content && (await keptUnlock(content).anchor());
  if (!content || !kept) return null;
  try {
    const check = await replaceKeysOperations.checkKeys(api, kept.anchor);
    if (check.kind === 'replaced') {
      await keptUnlock(content).keepAnchor({ ...kept, successor: check.current });
    }
    return check;
  } catch (error) {
    // With no answer, what the device recorded before stands.
    if (!noAnswer(error)) throw error;
    return kept.successor ? { kind: 'replaced', current: kept.successor } : null;
  }
}

let restoring: Promise<void> | null = null;

/**
 * Remember the open vault's key in this browser for later visits, until a
 * lock, sign-out or passphrase change. Nothing if the vault locked meanwhile.
 */
export async function rememberOpenVault(vault: UnlockedVault) {
  const started = vaultStore.epoch();
  // Offline, the version of the wrapper kept (ADR 0009, decision 5).
  const { version } = await api.call(vaultRoutes.getVault).catch(async (error: unknown) => {
    const content = noAnswer(error) ? await keptContent() : null;
    const kept = content && (await keptUnlock(content).vault());
    if (!kept) throw error;
    return kept;
  });
  if (vaultStore.epoch() === started) {
    await rememberInBrowser(vault.accountId, vault.vaultKey, version);
  }
}

/**
 * Open the vault this browser tab kept through a refresh, or the one this
 * browser remembers, if there is one for `accountId`. Otherwise the vault
 * stays locked, and opening a page asks.
 * Navigations while one runs share it: a second would stage over its keys.
 */
export function restoreInTab(accountId: string): Promise<void> {
  restoring ??= restore(accountId).finally(() => {
    restoring = null;
  });
  return restoring;
}

async function restore(accountId: string) {
  const started = vaultStore.epoch();
  const kept = await rememberedInTab(accountId).catch(() => null);
  if (!kept) return;
  const { vaultKey, version } = kept;
  try {
    // The passphrase changed since it was remembered: ask for the new one.
    // With no answer, that is checked once the server answers (ADR 0009,
    // decision 5). A vault this version can't unlock stays locked, and
    // unlocking asks to update; the key remembered says nothing about it.
    const served = version === undefined ? null : await servedVault();
    if (served && !unlocks(served.wrapper)) return;
    if (served !== null && served.version !== version) {
      // Keys replaced elsewhere keep what's remembered: the unlock page asks
      // whether the person did it (section 4.6).
      const check = await checkKeptKeys().catch(() => null);
      if (check && check.kind !== 'same') return;
      await forgetInBrowser();
      return;
    }
    await unlockWith({ kind: 'vault-key', vaultKey }, started, {
      ...(version !== undefined && { version }),
    });
  } catch (caught) {
    // A key that no longer opens this vault is no use to keep. Anything
    // else, such as the server being away, leaves it for the next load.
    if (noLongerOpens(caught)) await forgetKeptUnlock();
  } finally {
    vaultKey.fill(0);
  }
}

/**
 * Whether a remembered unlock failed because its key no longer opens the
 * vault, so it is no use to keep. A vault in a format this version doesn't
 * unlock says nothing about the key: the app asks to update, and keeps it.
 */
export const noLongerOpens = (error: unknown): boolean =>
  error instanceof CryptoError && error.code !== 'unsupported-format';

// The vault on the server, or null with no answer.
async function servedVault() {
  try {
    return await api.call(vaultRoutes.getVault);
  } catch (error) {
    if (noAnswer(error)) return null;
    throw error;
  }
}
