import {
  normalizeEmail,
  PASSWORD_GUESS_WINDOW_MS,
  refundPasswordGuess,
  schema,
  spendPasswordGuess,
  type Database,
  type PasswordBudget,
} from '@wikistow/server';
import { APIError } from 'better-auth/api';
import { hashPassword, verifyPassword } from 'better-auth/crypto';
import { and, eq, type SQL } from 'drizzle-orm';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Config } from '../config.ts';

const DEVICE_COOKIE_SECONDS = 180 * 24 * 60 * 60;

export const GUESSES_REFUSED_MESSAGE =
  'Too many attempts for this account. Wait a few minutes and try again.';

/** Thrown instead of checking a password once its allowance is spent. */
export class GuessesRefused extends APIError {
  constructor() {
    super('TOO_MANY_REQUESTS', {
      code: 'account-rate-limited',
      message: GUESSES_REFUSED_MESSAGE,
    });
  }
}

/** One request's password checks: the address they are for and the cookies sent. */
type Attempt = {
  /** Normalized: what sign-in submitted, or the signed-in account's own. */
  email: string | null;
  signIn: boolean;
  cookie: string | undefined;
  /**
   * The device a correct password in this request earned a cookie for, and
   * the account's standing that password was checked against.
   */
  earned?: Device & { standing: Standing };
  /** Hashes this request made, e.g. of a new password it is setting. */
  hashed: Set<string>;
};

type Device = { accountId: string; deviceId: string };

/**
 * What a device cookie is signed with besides itself: the account's password
 * hash and when its credentials were last revoked. Neither is ever sent.
 */
type Standing = { passwordHash: string; revokedAt: Date | null };

const sameStanding = (a: Standing, b: Standing) =>
  a.passwordHash === b.passwordHash && a.revokedAt?.getTime() === b.revokedAt?.getTime();

/**
 * Every password check shares one allowance per address, across routes,
 * servers and client addresses: Better Auth's routes and our
 * reauthentication all check passwords through `password.verify` here.
 * Sign-in spends the submitted address's allowance whether or not it has an
 * account or a password, so a refusal shows nothing about the address. Past
 * the allowance a check is refused at once, before any hashing. Nothing waits
 * or holds a lock, so attackers can't queue up work or starve other accounts.
 *
 * So that strangers spending an address's allowance can't lock its owner out,
 * a correct password earns a signed device cookie (OWASP's "device cookies").
 * Checks sent with it spend that device's own allowance instead. A cookie
 * counts only while the account's password and `credentialsRevokedAt` are
 * what they were when it was issued: a new password (each hash has its own
 * salt), a reset, revoking sessions, a suspension or a role change makes every
 * earlier cookie worthless. The per-client limits on each route still apply.
 */
export function createPasswordGuesses({ db, config }: { db: Database; config: Config }) {
  const budget: PasswordBudget | null = config.rateLimit
    ? { capacity: config.passwordGuessesPerHour ?? 20, windowMs: PASSWORD_GUESS_WINDOW_MS }
    : null;
  const attempts = new AsyncLocalStorage<Attempt>();
  const secure = config.publicOrigin.startsWith('https:');
  const cookiePrefix = `${secure ? '__Host-' : ''}wikistow-device-`;
  const key = createHmac('sha256', config.authSecret).update('wikistow device cookie').digest();
  const mac = (payload: string, { passwordHash, revokedAt }: Standing) =>
    createHmac('sha256', key)
      .update(`${payload}\0${revokedAt?.getTime() ?? ''}\0${passwordHash}`)
      .digest();

  function deviceCookie({ accountId, deviceId }: Device, standing: Standing): string {
    const payload = `${accountId}.${deviceId}.${Date.now()}`;
    const value = `${payload}.${mac(payload, standing).toString('base64url')}`;
    return (
      `${cookiePrefix}${accountId}=${value}; Path=/; Max-Age=${DEVICE_COOKIE_SECONDS}; ` +
      `HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`
    );
  }

  /** This request's well-formed, unexpired device cookies, not yet checked. */
  function deviceCookies(cookie: string | undefined) {
    const found: (Device & { payload: string; signature: Buffer })[] = [];
    for (const pair of cookie?.split(';') ?? []) {
      const [name = '', value = ''] = pair.trim().split('=', 2);
      if (!name.startsWith(cookiePrefix)) continue;
      const [accountId, deviceId, issuedAt, signature] = value.split('.');
      if (!accountId || !deviceId || !issuedAt || !signature) continue;
      if (name !== `${cookiePrefix}${accountId}`) continue;
      if (Date.now() - Number(issuedAt) > DEVICE_COOKIE_SECONDS * 1000) continue;
      const payload = `${accountId}.${deviceId}.${issuedAt}`;
      found.push({ accountId, deviceId, payload, signature: Buffer.from(signature, 'base64url') });
    }
    return found;
  }

  const accountFor = async (email: string) =>
    (
      await db
        .select({ id: schema.users.id, revokedAt: schema.users.credentialsRevokedAt })
        .from(schema.users)
        .where(eq(schema.users.email, email))
    )[0];

  /** The standing of the account `where` picks, as stored now. */
  const stored = async (where: SQL): Promise<{ id: string; standing: Standing } | undefined> => {
    const [row] = await db
      .select({
        id: schema.users.id,
        passwordHash: schema.accounts.password,
        revokedAt: schema.users.credentialsRevokedAt,
      })
      .from(schema.users)
      .innerJoin(
        schema.accounts,
        and(
          eq(schema.accounts.userId, schema.users.id),
          eq(schema.accounts.providerId, 'credential'),
        ),
      )
      .where(where);
    return row?.passwordHash
      ? { id: row.id, standing: { passwordHash: row.passwordHash, revokedAt: row.revokedAt } }
      : undefined;
  };

  /**
   * Take one guess from this device's or this address's allowance, or refuse.
   * `passwordHash` is the stored one being checked against; with none, no
   * device counts. Also reads the address's account as it stands before the
   * check, for sign-in's stand-in hashes too, so every guess reads the same.
   */
  async function spend(attempt: Attempt, limits: PasswordBudget, passwordHash: string | null) {
    const { email } = attempt;
    if (email === null) throw new Error('A password was checked without an address');
    const sent = deviceCookies(attempt.cookie);
    // Looked up whenever a device cookie is sent, password or not, so the
    // lookup shows nothing about the address.
    const account = sent.length > 0 ? await accountFor(email) : undefined;
    const device =
      account && passwordHash !== null
        ? sent.find((d) => {
            if (d.accountId !== account.id) return false;
            const expected = mac(d.payload, { passwordHash, revokedAt: account.revokedAt });
            return d.signature.length === expected.length && timingSafeEqual(d.signature, expected);
          })
        : undefined;
    const budgetKey = device ? `device:${device.accountId}:${device.deviceId}` : `address:${email}`;
    if (!(await spendPasswordGuess(db, budgetKey, limits))) throw new GuessesRefused();
    return { budgetKey, device, account: await stored(eq(schema.users.email, email)) };
  }

  function current(): Attempt {
    const attempt = attempts.getStore();
    if (!attempt) throw new Error('A password was checked outside a request');
    return attempt;
  }

  return {
    /** Better Auth's password functions. */
    password: {
      // Sign-in hashes instead of verifying when the address has no account
      // or no password. That counts as a wrong guess, like a real one.
      hash: async (password: string) => {
        const attempt = attempts.getStore();
        if (budget && attempt?.signIn) await spend(attempt, budget, null);
        const hash = await hashPassword(password);
        attempt?.hashed.add(hash);
        return hash;
      },
      verify: async (input: { hash: string; password: string }) => {
        if (!budget) return verifyPassword(input);
        const attempt = current();
        // The standing the hash was read with, as near as we can: read before
        // the check and kept only if it still holds that hash, so a revocation
        // committing while scrypt runs isn't part of what a cookie is earned for.
        const { account, ...spent } = await spend(attempt, budget, input.hash);
        const matches = await verifyPassword(input);
        if (matches) {
          // Success gives back only its own guess: no fresh allowance.
          await refundPasswordGuess(db, spent.budgetKey, budget);
          if (account?.standing.passwordHash === input.hash) {
            const deviceId = spent.device?.deviceId ?? randomBytes(16).toString('base64url');
            attempt.earned = { accountId: account.id, deviceId, standing: account.standing };
          }
        }
        return matches;
      },
    },

    /**
     * This request is a sign-in for `email`, as Better Auth's router matched
     * it, so its checks spend that address's allowance.
     */
    signingIn(email: string) {
      const attempt = current();
      attempt.signIn = true;
      attempt.email = normalizeEmail(email);
    },

    /**
     * Run one request's work, whose password checks are for `email`. Returns
     * the device cookies to send with the answer.
     */
    async scope<T>(
      input: { email: string | null; cookie: string | undefined },
      task: () => Promise<T>,
    ): Promise<{ result: T; setCookies: string[] }> {
      const attempt: Attempt = { ...input, signIn: false, hashed: new Set() };
      const result = await attempts.run(attempt, task);
      const { earned } = attempt;
      const now = earned && (await stored(eq(schema.users.id, earned.accountId)))?.standing;
      // Only while the account still stands as it did when the password was
      // checked, or holds a password this request set: a reset or sign-out
      // elsewhere meanwhile must not mint a cookie for the new standing.
      const setCookies =
        earned &&
        now &&
        (sameStanding(now, earned.standing) || attempt.hashed.has(now.passwordHash))
          ? [deviceCookie(earned, now)]
          : [];
      return { result, setCookies };
    },
  };
}

export type PasswordGuesses = ReturnType<typeof createPasswordGuesses>;
