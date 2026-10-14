import { ApiError, CryptoError } from '@wikistow/client';
import { describe, expect, it } from 'vite-plus/test';
import { classify, CliError, EXIT } from '../src/exit.ts';

describe('exit statuses', () => {
  it.each([
    [new ApiError(409, 'stale-head', 'x', { draftHead: 'd', publishedHead: null }), EXIT.conflict],
    [new ApiError(404, 'not-found', 'x'), EXIT.notFound],
    [new ApiError(401, 'unauthenticated', 'x'), EXIT.revoked],
    [new ApiError(409, 'key-version', 'x', { keyVersion: 2 }), EXIT.missingKeys],
    [new CryptoError('untrusted-sealer', 'x'), EXIT.trust],
    [new CliError('wrong-passphrase', 'x'), EXIT.locked],
    [new CliError('usage', 'x'), EXIT.usage],
    [new CliError('journal-mismatch', 'x'), EXIT.conflict],
    // A network error around the CLI's own refusal: a refused retry, not a maybe-made change.
    [
      new ApiError(0, 'network', 'No answer', {}, { cause: new CliError('journal-mismatch', 'x') }),
      EXIT.conflict,
    ],
    [new Error('x'), EXIT.failed],
  ])('%s exits %i', (error, exit) => {
    expect(classify(error).exit).toBe(exit);
  });
});
