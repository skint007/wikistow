import nodemailer from 'nodemailer';
import type { Log } from '../http/logger.ts';

export type Mail = { to: string; subject: string; text: string };

/** Sends one message. Tests inject a function that records instead. */
export type Deliver = (mail: Mail) => Promise<void>;

export function smtpDeliver({ url, from }: { url: string; from: string }): Deliver {
  const transport = nodemailer.createTransport({
    url,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
  return async (mail) => {
    await transport.sendMail({ from, ...mail });
  };
}

/**
 * Send without making the request wait. Response timing then can't reveal
 * whether an address exists, and a slow relay can't hold a request open.
 * Failures are logged by name only, since messages may carry links with tokens.
 */
export function sendInBackground(deliver: Deliver, log: Log, mail: Mail): void {
  deliver(mail).catch((error: unknown) => {
    log({
      level: 'error',
      event: 'mail-failed',
      name: error instanceof Error ? error.name : 'unknown',
    });
  });
}
