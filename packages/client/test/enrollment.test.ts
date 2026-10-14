import { describe, expect, it } from 'vite-plus/test';
import {
  agentCredentialHash,
  agentTokenMatches,
  canonical,
  hashBytes,
  lookupCodeHash,
  newAgentToken,
  normalizeLookupCode,
  parseAgentToken,
} from '../src/index.ts';

describe('enrollment secrets', () => {
  it('hash the lookup code in its normalized form, however it was typed', () => {
    expect(normalizeLookupCode(' 7k2m-9qxz ')).toBe('7K2M9QXZ');
    expect(normalizeLookupCode('IlO0-oLi1')).toBe('11000111');
    expect(lookupCodeHash('7K2M-9QXZ')).toBe(lookupCodeHash('7k2m9qxz'));
  });
});

describe('agent bearer tokens (section 12.4)', () => {
  it('round-trip and match only their own stored hash', () => {
    const issued = newAgentToken();
    expect(issued.token).toMatch(/^wsa_[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
    const parsed = parseAgentToken(issued.token);
    expect(parsed.credentialId).toBe(issued.credentialId);
    expect(agentCredentialHash(parsed)).toEqual(
      hashBytes(canonical('agent-credential/v1', [issued.credentialId, parsed.secret])),
    );
    expect(agentTokenMatches(parsed, issued.storedHash)).toBe(true);
    expect(agentTokenMatches(parseAgentToken(newAgentToken().token), issued.storedHash)).toBe(
      false,
    );
  });
});
