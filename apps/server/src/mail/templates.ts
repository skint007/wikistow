import { SETUP_LINK_TTL_HOURS } from '@wikistow/server';
import type { Mail } from './mailer.ts';

// Plain text only: nothing to sanitize, and every client renders it.

export const verifyEmailMail = (to: string, url: string): Mail => ({
  to,
  subject: 'Confirm your email for WikiStow',
  text: `Confirm this address to finish setting up your WikiStow account:\n\n${url}\n\nIf you didn't create an account, ignore this message.\n`,
});

export const accountExistsMail = (to: string, signInUrl: string): Mail => ({
  to,
  subject: 'Your WikiStow account',
  text:
    `Someone tried to create a WikiStow account with this address, which already has one.\n\n` +
    `If that was you, sign in here, or use "Forgot password" on that page:\n\n${signInUrl}\n\n` +
    `If it wasn't you, ignore this message. Nothing has changed.\n`,
});

export const invitationMail = (to: string, url: string, inviter: string): Mail => ({
  to,
  subject: `${inviter} invited you to WikiStow`,
  text:
    `${inviter} invited you to their WikiStow, a private wiki for family and friends.\n\n` +
    `Create your account with this link. It works once and expires in 7 days.\n\n${url}\n`,
});

export const resetPasswordMail = (to: string, url: string): Mail => ({
  to,
  subject: 'Reset your WikiStow password',
  text:
    `Use this link to choose a new password. It expires in 30 minutes.\n\n${url}\n\n` +
    `Resetting your password signs out your other sessions. It does not change your vault ` +
    `passphrase, and it can't unlock your encrypted pages.\n\n` +
    `If you didn't ask for this, ignore this message.\n`,
});

export const setPasswordMail = (to: string, url: string): Mail => ({
  to,
  subject: 'Finish setting up your WikiStow account',
  text:
    `Use this link to choose your name and password. That also confirms this email address. ` +
    `It works once and expires in ${SETUP_LINK_TTL_HOURS} hours.\n\n${url}\n\n` +
    `Then sign in with this address and your new password.\n\n` +
    `If you didn't ask for an account, ignore this message. Nobody can sign in to it until ` +
    `this link is used.\n`,
});
