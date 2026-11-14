// The public key the tests' build carries, which gives an unpacked
// extension a fixed ID in Chromium. The desktop tests' stand-in extension
// (apps/desktop/e2e/clip-extension) has the same, so both reach the app
// under one origin, which the tests pass it with `--clip-extension`.
// Only a key: nothing is signed with it. The store builds carry none.
export const TEST_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAsPjYyZ7sXVmNpwZ0t44kiGXIWT+oioQhAZg5wsPcEEm5GXOjHfgbUCg5hF7OlIocteqP7WS3u8aOOhEY43jOYxA/cqMYFJ2PsE75pKvPJVMKOAfaD4jYGrVy+KOl1vCc4+4tg07XusGdUJNDSJBbLafoBBIB11OMruJ+xXdoO1ZDjeqYpld6MSpGF0BHLUDjDmaOPsVBLOdm9yTbZeC9HbrFEa+rR1yrqfV80ZeV3A0bjYRsYwu6ncOcQisMrdy+WRNCWyEoKgGQdheamx6Lm2F+totwoP8WVklLYIz5luUJbV4UfveNlnX9hLbFF+vCDGeLg9oSvYUHMjGxC+UjVQIDAQAB';
/** The ID that key gives. */
export const TEST_ID = 'mnoeboefdgcplmejicllacedgejajmdo';
