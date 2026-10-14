import { describe, expect, it } from 'vite-plus/test';
import { z } from 'zod';
import { Timestamp } from '../src/index.ts';
import { Email } from '../src/routes/accounts.ts';

const ok = (schema: z.ZodType, value: unknown) => schema.safeParse(value).success;

describe('timestamps', () => {
  it('accept the form toISOString writes, with or without milliseconds', () => {
    expect(ok(Timestamp, '2026-10-04T12:30:00.000Z')).toBe(true);
    expect(ok(Timestamp, '2026-10-04T12:30:00Z')).toBe(true);
    expect(ok(Timestamp, '2024-02-29T23:59:59.999Z')).toBe(true);
  });
});

describe('the email pattern', () => {
  // Section 3.2 pins the pattern itself, not whatever zod version is installed.
  const SPEC =
    // oxlint-disable-next-line no-useless-escape -- copied verbatim from the spec
    /^(?:[A-Za-z0-9_'+\-]+\.)*[A-Za-z0-9_'+\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$/;

  it.each(["o'neil+tag@mail.example.co", 'a.b@x.io', 'Ann@Example.org', 'ann@localhost'])(
    'agrees with the contracts Email for %j',
    (email) => {
      expect(ok(Email, email)).toBe(SPEC.test(email));
    },
  );
});
