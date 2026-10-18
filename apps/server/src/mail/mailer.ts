import nodemailer from 'nodemailer';
import { ApiError } from '../http/errors.ts';
import type { Log } from '../http/logger.ts';

export type Mail = { to: string; subject: string; text: string };

/** Sends one message. */
export type Deliver = (mail: Mail) => Promise<void>;

/**
 * Where mail goes out and who it's from: `SMTP_URL` as the environment
 * gives it, or the fields an administrator saved.
 */
export type MailSetup = {
  from: string;
  connection:
    | { url: string }
    | {
        host: string;
        port: number;
        security: 'none' | 'starttls' | 'tls';
        username: string | null;
        password: string | null;
      };
};

/** Builds the sender for a setup. Tests pass one that records instead. */
export type Transport = (setup: MailSetup) => Deliver;

const TIMEOUTS = { connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 15_000 };

export const smtpDeliver: Transport = ({ from, connection }) => {
  const transport = nodemailer.createTransport(
    'url' in connection
      ? { url: connection.url, ...TIMEOUTS }
      : {
          host: connection.host,
          port: connection.port,
          secure: connection.security === 'tls',
          requireTLS: connection.security === 'starttls',
          ignoreTLS: connection.security === 'none',
          ...(connection.username !== null && {
            auth: { user: connection.username, pass: connection.password ?? '' },
          }),
          ...TIMEOUTS,
        },
  );
  return async (mail) => {
    await transport.sendMail({ from, ...mail });
  };
};

export const mailOff = () => new ApiError('mail-off', 'Mail isn’t set up on this server');

/**
 * The server's outgoing mail, with whatever settings apply now. They are
 * read once and kept until `reload`, which the admin page's save calls, so
 * a change applies without a restart.
 */
export function createMailer({
  setup,
  transport,
}: {
  /** The settings that apply now, or null when mail isn't set up. */
  setup: () => Promise<MailSetup | null>;
  transport: Transport;
}) {
  let current: Promise<Deliver | null> | null = null;
  const sender = () => {
    if (current) return current;
    const reading = setup().then((found) => (found ? transport(found) : null));
    // A failed read (the database was away) is tried again next time.
    reading.catch(() => {
      if (current === reading) current = null;
    });
    current = reading;
    return reading;
  };
  return {
    /** Sends with the current settings; fails with `mail-off` when there are none. */
    deliver: (async (mail) => {
      const deliver = await sender();
      if (!deliver) throw mailOff();
      await deliver(mail);
    }) satisfies Deliver,
    /** Refuses with `mail-off` unless mail is set up, before anything that would mail. */
    async require(): Promise<void> {
      if (!(await sender())) throw mailOff();
    },
    async ready(): Promise<boolean> {
      return (await sender()) !== null;
    },
    reload(): void {
      current = null;
    },
  };
}

export type Mailer = ReturnType<typeof createMailer>;

/**
 * Send without making the request wait. Response timing then can't reveal
 * whether an address exists, and a slow relay can't hold a request open.
 * Failures are logged by name only, since messages may carry links with
 * tokens; with mail not set up, the message is dropped and logged as such.
 */
export function sendInBackground(deliver: Deliver, log: Log, mail: Mail): void {
  deliver(mail).catch((error: unknown) => {
    if (error instanceof ApiError && error.code === 'mail-off') {
      log({ level: 'warn', event: 'mail-off' });
      return;
    }
    log({
      level: 'error',
      event: 'mail-failed',
      name: error instanceof Error ? error.name : 'unknown',
    });
  });
}
