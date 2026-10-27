# WikiStow protocol

This is the wire and cryptographic protocol shared by the browser, desktop app, CLI and server. It covers what Milestones 0 and 1 built, what Milestone 2 adds for sharing and agents, and Milestone 5's groups. It is written so that two independent implementations produce identical bytes.

The product rules it implements are in [`wikistow.md`](../wikistow.md). Terms are defined in [`CONTEXT.md`](CONTEXT.md). Review findings are logged in [`protocol-review.md`](protocol-review.md).

Words in **MUST**, **MUST NOT** and **SHOULD** are requirements. "Refuse" means: stop the operation and surface the named error. Never fall back to a weaker check.

## Contents

1. [Scope, versioning and status](#1-scope-versioning-and-status)
2. [Threat model](#2-threat-model)
3. [Primitives and encodings](#3-primitives-and-encodings)
4. [Identities](#4-identities)
5. [Content objects](#5-content-objects)
6. [Shares and folder keys](#6-shares-and-folder-keys)
7. [Sharing](#7-sharing)
8. [Pinned keys and the key-change warning](#8-pinned-keys-and-the-key-change-warning)
9. [Agents](#9-agents)
10. [Moves](#10-moves)
11. [Unpublish and republish](#11-unpublish-and-republish)
12. [Attachment reuse](#12-attachment-reuse)
13. [Cross-space publication](#13-cross-space-publication)
14. [Milestone 1 data](#14-milestone-1-data)
15. [Changes to what PR #29 merged](#15-changes-to-what-pr-29-merged)
16. [Implementation notes for PR 2 and PR 3](#16-implementation-notes-for-pr-2-and-pr-3)
17. [Open questions and limitations](#17-open-questions-and-limitations)
18. [Security review](#18-security-review)

---

## 1. Scope, versioning and status

**Status: reviewed, and frozen for Milestone 2.** On 2026-10-05 the project owner replaced the earlier Milestone 2 design, a signed, hash-chained access log per space, with the folder-key design in this document ([`protocol-review.md`](protocol-review.md), **Change of design**). The earlier text had been frozen after 16 review rounds. This design was reviewed in three rounds on 2026-10-05 (rounds 17 to 19, section 18). Round 19 found nothing high or critical, and its findings are fixed here, so the domain strings and version identifiers in section 3.5, and the byte layouts and rules here, are fixed for Milestone 2.

### What is frozen already

Everything Milestones 0 and 1 shipped is **version 1 and frozen**. Stored data uses it, and clients must keep reading it:

- revision records, revision payloads, key envelopes v1 and attachments (`packages/client/src/revision.ts`);
- metadata records, metadata payloads and metadata envelopes v1 (`metadata.ts`);
- vault wrappers (`vault.ts`);
- identities, fingerprints, agent IDs and agent enrollments (`identity.ts`, `trust.ts`);
- the page payload format 1.0 and the metadata format 1.0 (`payload.ts`, `metadata.ts`).

### What Milestone 2 adds

- **shares**: a folder or space with its own folder keys, a draft key and a published key per key version (section 6);
- key wraps (`content-key-wrap/v1`), folder key envelopes (`folder-key-envelope/v1`) and owner statements (`space-owner/v1`);
- revision and metadata records v2, which commit to their content key (`content-key-commit/v1`), and key and metadata envelopes v2 for content outside shares (section 5.7 and 5.8);
- the contacts record (`contacts/v1`, `contacts-payload/v1`, `contacts-private-payload/v1`), which holds pinned keys for the key-change warning (section 8);
- identity key hashes (`identity-key-hash/v1`);
- attachment plaintext hashes (`attachment-plain-hash/v1`), which bump the page payload format to 1.1;
- agent enrollment with an enrollment fingerprint (`agent-enrollment-check/v1`), and bearer credentials;
- the `wikistow.publication` payload extension, which names a published copy's source inside its encrypted payload (section 13).

Identity key rotation, and its statement format, are left to a later milestone (section 4.6).

### What Milestone 5 adds

- **groups** of people in a space, and their agents, which shares go to as one (sections 7.8, 7.9 and 9.4). Nothing new is signed but a group's name, which is a metadata record v2 with `subjectKind: "group"` in the owner region. There are no new domain strings. A client from before Milestone 5 parses such a record strictly and refuses it, so it can't scan an owner region that holds one (adding a co-owner) until it updates;
- the agents' `groups` list in the contacts record (section 8.2), and the person's routes to confirm a group for their agent or take it out (section 9.4).

Section 15 lists what PR #29 merged that this design keeps, changes or retires.

### Versioning rules

- Every signed, hashed or authenticated byte string starts with a **domain string** that names its purpose and version (section 3.5). A changed layout gets a new domain version. A frozen domain is never edited.
- Records carry a `protocol` number. It is `1` for every v1 record type and for the contacts record, and `2` for `revision-record/v2` and `metadata-record/v2`.
- Payloads carry `format {major, minor}`. Minor versions only add fields. A client that meets a newer major version can display the fact but MUST refuse to save over it.
- A client that meets an unknown envelope version, record protocol or major format MUST fail closed. It refuses the operation and asks the person to update. It never skips the unknown item. Signed and hashed objects are parsed strictly, so an unknown version value is never read as an older version (section 3.3, rule 8).

---

## 2. Threat model

### 2.1 Assets

1. **Content plaintext:** page titles and Markdown, attachment names and bytes, and folder and space names.
2. **Keys that open content:** the per-version content keys, and the folder keys that wrap them.
3. **Identity secret keys:** each human's and agent's X25519 and Ed25519 secret keys, and each human's vault key.
4. **Who holds which folder keys.** A wrong answer here leaks everything later saved in that share.
5. **Attribution:** who wrote or published something.

### 2.2 Adversaries

**A malicious or breached server.** It has the whole database and blob store, and it controls every API response. It can serve stale or changed lists, substitute keys in the directory, invent accounts, identities and shares, add or delete rows (owners, members, roles, agent grants), and accept or refuse any write. It can't forge signatures from keys it doesn't hold, and it can't open sealed boxes or AEAD ciphertext without the key. It also serves the web app's JavaScript (section 2.4, A9).

**A malicious or removed member.** This is a reader, editor, publisher or owner acting against the others. It includes someone just removed, who still holds every key they obtained. The member can collude with the server.

**A compromised agent host.** An attacker holds an agent's key file, unlock secret and bearer credential. The attacker gets exactly the agent's keys, and may also collude with the server.

**A network attacker.** It sees and changes traffic. TLS is assumed for transport. The protocol's guarantees about content don't depend on TLS, but credential secrecy does.

### 2.3 What the protocol guarantees

- **Confidentiality of content at rest.** Without a folder key or a recipient's secret key, stored ciphertext, wraps and envelopes reveal no plaintext. A page someone gives a public link is outside this: its published version is stored readable on purpose while the link is on ([ADR 0005](../docs/adr/0005-public-links.md)), and nothing in this protocol protects it.
- **The server can't add a reader by itself.** Folder keys are sealed only by an owner's app, during an owner action, to the people shown in its dialog, or by a person's app to that person's own agents (section 7.2). Keys come from the directory and are checked against the app's pins (section 8). A save never chooses recipients: inside a share it wraps the content key under the share's current key version (section 6.8), and outside shares it seals only to the space's accepted owners, never to a list the server gives (section 6.6).
- **Members take keys only from owners they accept.** A key version opens only through a folder key envelope signed by an accepted owner of the space, or for an agent by its own person (section 6.4). A server-invented owner has no statement from an accepted owner, so it can't hand a member a key the server knows (section 6.5).
- **Readers never get draft keys.** An owner's app seals draft keys only to editors and owners, and the server checks each envelope's class against the recipient's role (section 6.4). A reader can't read a draft unless an editor or owner hands it over.
- **Nothing saved after a removal reaches the removed person.** A removal rotates the share's keys, and the new version is sealed only to people who held the previous one and the owners the app accepts, minus the removed person (section 7.5). Honest clients wrap only under the newest version they hold, and the server refuses saves under an older one (section 6.8). The exception is an owner who removes themself, or transfers the space: they made the post-removal version, so they know it until a remaining owner rotates again (section 7.6). A public link is outside this too: a removed person who saw a link someone else turned on can still read what is published through it (A12).
- **Authenticated authorship.** Every record and envelope is signed, and clients check each signature against a pinned key (section 8).
- **One plaintext per ciphertext.** v2 records commit to their content key, and readers check it before decrypting (section 5.7).
- **Ancestor names stay away from members.** A share's members get only that share's keys. The names of the folders above it are under other keys (sections 6.1 and 7.7).

### 2.4 Accepted risks

the project owner accepted these on 2026-10-05, for a design that is "secure, but not overly complicated, like Joplin". A malicious or breached server **can**:

- **A1. Ignore role rules.** It can let an editor without publish rights publish, let an agent act beyond its person's access within the keys it holds, serve ciphertext to anyone, and misreport the tree. Roles are enforced only by the server. It can't give anyone a key they don't already hold.
- **A2. Hide or roll back changes undetected.** It can serve an old draft or published head, hide versions, reorder history, and hide a member, a removal, a key rotation or an unpublish from anyone. In particular, a writer whom the server keeps from seeing a new key version keeps saving under the old one, and a removed person who colludes with the server can read those saves. The same goes for a write the server refuses as `key-version`: the client retries with the same content key (section 6.8), so a server that hands the refused wrap to a removed person leaks what the retry then saves, which it could have done by accepting the write. A server that rolls back a move can likewise make new content in the moved folder land in its old region. And it can hide one owner's rotation from another owner in a later browser session, which keeps no **No going back** mark (section 6.8), so that owner's next rotation reaches the person the hidden rotation removed.
- **A3. Keep serving a removed person data they could already decrypt.** Nothing can be recalled: not keys, not plaintext, not downloads.

It **cannot** read content, add a reader by itself, or decrypt anything saved after a removal. One exception is a page someone gives a public link: its published version is stored readable while the link is on (A12).

These further risks are accepted too:

- **A4. First sight.** Pins are made the first time an app sees a person's key (section 8.3). The key-change warning catches every later swap. A server that substitutes its own key before an app has ever seen the real one, the first time someone shares with a new person or a member first meets an owner, goes undetected. The server also chooses which people, names and emails the list of people shows (section 7.3), so it can offer its own key under a name and email the owner expects; that is the same first sight as a typed email, whose lookup it answers too. In the same way, a server can present a share it made up, sealed by an identity it controls. The member sees it in Shared with me as shared by that identity, and the server can read what they write in it. A substitution when a new co-owner's app first meets the space is worse: that app then accepts the server's identity as an owner (section 6.5, step 2), and seals its owner-region saves and its rotations to it, so the server reads the owner region as that co-owner writes it, and the shares that co-owner rotates. It doesn't stay in that app: the co-owner signs a statement naming its adder (section 6.5), so through that statement every other app in the space accepts the server's identity too (step 3). The co-owner dialog names the adder by label, which is the one place this can be noticed. In the browser, which keeps no contacts mark across sessions (section 8.5, Q2), a server that serves an older contacts record makes every pin and accepted owner recorded after it first-sight again, for that session; A9 already gives an active server the same.
- **A5. A removed owner colluding with the server.** Owner statements (section 6.5) can't be revoked. The remover's app doesn't accept the removed owner again unless its person adds them back, but other apps learn of a removal only from the server, and write under a key version sealed by any owner they accepted and didn't remove themselves (section 6.5). So the server can serve those apps a key version the removed owner sealed, and they write under it. If the server hides the removal from them, or lists the removed owner again later, they also keep sealing to the removed owner. An owner who removes themself, or transfers the space, made the post-removal versions and so knows them, in every app, until a remaining owner rotates again; once the new owner's rotations after a transfer have all succeeded, its app puts the old owner on its removed-owners list (section 7.6). In apps that didn't remove the owner, their statements still count, so the removed owner and the server can introduce new owners, server identities included, to those apps. A co-owner the remover adds later doesn't inherit the remover's removed-owners list. In the browser, an older contacts record (A4) also drops the person's removed-owners entries for that session.
- **A6. A revoked agent's keys.** Revoking an agent ends its credential at once, but doesn't change the folder keys it held. Whoever holds the agent's key file, colluding with the server, can read what is saved under those key versions until an owner rotates the keys (section 9.7). In the browser, which keeps no contacts mark across sessions (section 8.5, Q2), a server that serves a contacts record from before the revocation makes the person's next unlock seal new key versions to the revoked agent again (section 9.4), which undoes that rotation for the agent's shares.
- **A7. Visible metadata.** The server sees account emails, names and avatar images, identity IDs and public keys; space, folder, page, revision, attachment and share IDs; the tree; shares, members, roles, owners and agent grants; which key version each record is under; sizes, times and who did what; and the source-to-publication link.
- **A8. A compromised unlocked client.** Whoever controls a client while it is unlocked gets everything that client can decrypt, and can sign anything as that person.
- **A9. Served JavaScript.** In the browser, the server delivers the client code. A malicious operator can ship code that steals keys at the next unlock (`wikistow.md` L135). The desktop app and the CLI bundle their code, which narrows this risk without removing it.
- **A10. Confirmed move previews.** Once an owner confirms a move (or at once, on a device where they turned confirming moves off), the client uploads wraps under the destination's keys (section 10). A gainer colluding with the server can open them even if the move then fails.
- **A11. Milestone 1 records aren't key-committing.** Clients accept a v1 record only from an accepted owner (section 5.7), who could have sealed one ciphertext that opens differently for different keys.
- **A12. Public links** (accepted 2026-10-21). A page someone gives a public link has its published version stored readable on the server while the link is on ([ADR 0005](../docs/adr/0005-public-links.md)). The server can read that copy, keep it after the link is turned off, and keep serving it. It can also claim a page has a link when it doesn't. Then a public page's upload tells it which of that page's wikilinks name the page, and so a typed title for it. The app sends a target only for a link that names a page by its published title alone, and the server deletes the targets naming a page when that page's link ends. So an honest server learns from targets only which links of a public page lead to another page whose link is on, by the text the public page shows. The app uploads a copy only after saying so on screen, in the public link dialog or a Publish that asks first, so a person sees it before a copy of a private page goes up. Nothing in this protocol protects a copy once it is uploaded, or checks that it matches the published version: the server takes the text the app sends. The app uploads the version the server names as published, except right after a publish, when it uploads the one it just published. So a server that serves an old published head (A2) can get that older version uploaded, which may hold something a later publish took out. The page's readers could already read it. The copy also holds the page's cover, with the images it shows, and, as text, the property values its body shows and its query tables, from other pages' published versions too ([ADR 0006](../docs/adr/0006-page-properties.md)), so a public page can make another page's values readable to anyone with the link; the app says so before it uploads such a copy, and never puts a draft's values in it. Removing someone from a share doesn't change a link someone else turned on that they could see. Only a new link does, and not if a public page updated since links to it, since that page leads to the new link.

### 2.5 What the server can and cannot do

| Action | Server alone | Section |
|---|---|---|
| Read titles, Markdown, attachments, folder or space names | **No**, except a page with a public link | 2.3, A12 |
| See IDs, the tree, sizes, times, emails, public keys, shares, members and roles | Yes | A7 |
| Refuse any request, or serve stale or partial data | Yes | A2 |
| Let someone do what their role forbids, with keys they already hold | Yes | A1 |
| Give a reader a draft key, or anyone a key they don't hold | **No** | 6.4 |
| Make an owner's app seal to someone not shown in its dialog | **No** | 7.2 |
| Make a key rotation include someone who didn't hold the previous version | **No** | 7.5 |
| Make a member accept a key version from an owner it doesn't accept | **No** | 6.5 |
| Substitute a key an app has pinned, without a key-change warning | **No**, except in a browser served an older contacts record (A4) | 8.4 |
| Substitute a person's key before any app has seen the real one | Yes | A4 |
| Hide a key rotation from a writer, who then keeps saving under the old version | Yes | A2 |
| Open a key wrap, an envelope, a payload or an attachment | **No** | 6.3, 6.4 |
| Keep serving a removed person old ciphertext | Yes | A3 |
| End an agent's credential | Yes (and so can the person and an administrator) | 9.7 |
| Take back folder keys an agent or a removed person already holds | **No** (nobody can) | A3, A6 |
| Swap the published key and the draft key in an envelope | **No** | 6.4 |

---

## 3. Primitives and encodings

### 3.1 Library and algorithms

libsodium is normative, as built by `libsodium-wrappers-sumo` (`packages/client/src/sodium.ts`). Another implementation MUST produce and accept exactly what these calls produce and accept.

| Purpose | Algorithm | libsodium call |
|---|---|---|
| Payload, attachment, metadata, key-wrap and vault encryption | XChaCha20-Poly1305 (IETF), 32-byte key, 24-byte nonce, 16-byte tag | `crypto_aead_xchacha20poly1305_ietf_encrypt` / `_decrypt`, with no secret nonce |
| Content key and folder key generation | 32 random bytes | `crypto_aead_xchacha20poly1305_ietf_keygen` |
| Key envelopes, folder key envelopes and contacts key wrapping | Sealed box: ephemeral X25519, then XSalsa20-Poly1305. 48 bytes of overhead | `crypto_box_seal` / `crypto_box_seal_open` |
| Signatures | Ed25519, 64-byte detached signatures | `crypto_sign_detached` / `crypto_sign_verify_detached` |
| Hashing | BLAKE2b, unkeyed | `crypto_generichash(outlen, input, null)` |
| Passphrase KDF | Argon2id v1.3 | `crypto_pwhash(..., crypto_pwhash_ALG_ARGON2ID13)` |
| Recovery-key KDF | BLAKE2b-based KDF | `crypto_kdf_derive_from_key(32, 1, 'wsrecov1', key)` |
| Randomness | OS CSPRNG | `randombytes_buf` |

**Sealed boxes don't authenticate the sender.** Anyone can seal a key to anyone. That is why every key envelope and folder key envelope is signed by whoever sealed it, and every record by its author.

**The AEADs don't commit to the key.** Poly1305 lets one ciphertext, with one nonce and AD, verify under two different keys and decrypt to two different plaintexts. The round 1 review built such a ciphertext with the repo's libsodium. That is why v2 records (section 5.7) and the contacts record (section 8.1) sign a hash of the content key (`keyCommitment`), and why readers check it before decrypting. It is also why key wraps (section 6.3) need no signature: a wrap that opens to any other key fails the commitment.

**Seal failures.** `crypto_box_seal` throws a raw libsodium error for a low-order X25519 key. Implementations MUST surface any seal failure as a `CryptoError` (`bad-key`). Section 4.1 refuses such keys earlier, so this only happens on a bug.

**Signature verification.** Ed25519 verification MUST reject everything `crypto_sign_verify_detached` rejects. That includes a non-canonical `S`, small-order points, and an `R` of mixed order (a prime-order point plus a small-order component). libsodium refuses such an `R`; cofactored verifiers in the ZIP-215 style accept it, so a malicious signer could otherwise make a signature that one implementation accepts and another refuses. The test vectors include each of these cases, plus a mixed-order public key `A` for section 4.1. A signature that fails to decode counts as invalid (`verifySignature` returns false).

### 3.2 Byte and text encodings

**Regular expressions are ASCII-only.** Every pattern in this document is written with explicit ASCII classes. `\w` is never used, because Python, Rust, .NET and JavaScript with the `u` or `i` flags let it match non-ASCII letters. Patterns take no flags, and **every pattern must match the whole string**. Written here as JavaScript `^…$` without the `m` flag, that means `\A…\z` in PCRE or Ruby, `fullmatch` in Python, and `matches()` in Java. In Python, PCRE and Java, a bare `$` also matches before a final `\n`, so `abc\n` would pass an ID check there and put a newline into signed bytes.

**Base64.** Bytes inside JSON are unpadded base64url: libsodium's `URLSAFE_NO_PADDING` (`encoding.ts`: `toBase64`, `fromBase64`). The contracts shape check is `Base64 = /^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$/`. A 32-byte public key must match `PublicKey = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/`, so its two unused trailing bits are zero. Decoders MUST reject padding. They MUST also reject strings whose unused trailing bits are not zero, so each byte string has exactly one text form. The repo's decoder (libsodium 1.0.22) was checked against this on 2026-10-04: `AA` and `AAA` decode; `AB` and `AAB` are rejected; `AA==` and `A` are rejected.

**IDs.** IDs of encrypted objects and shares are made by clients. The shape is `^[A-Za-z0-9_-]{1,64}$` (`contracts/src/records/ids.ts`). `newId` returns 16 random bytes in base64url, which is 22 characters. This covers human identity, space, folder, page, share, revision, metadata-revision and attachment IDs. Agent IDs are 49 characters (section 4.2).

**Hashes in records** are BLAKE2b-256 outputs written as base64url strings (`encoding.ts`: `hash`). A streamed upload uses `streamingHash`, which gives the same result. Every hash field, in every record, envelope, statement and payload, MUST match

```
Hash32 = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/
```

which is the one canonical text form of 32 bytes. Anything else is `malformed` at parse time. Hash fields are signed, hashed, stored and compared as this exact text. This covers `payloadHash`, `keyCommitment`, `keyHash`, `blobHash`, `plainHash`, `prevHash`, `contactsHash`, `privatePayloadHash`, `privateKeyCommitment` and `sourceRecordHash`.

**Timestamps.** Every timestamp field this document defines (`verifiedAt`, `removedAt`, `revokedAt`, an agent label's `enrolledAt`, and the enrollment response's `expiresAt`) is UTC, written as

```
Timestamp = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{3})?Z$/
```

which is the form `Date.prototype.toISOString()` writes, with the milliseconds optional. It MUST also be a real instant from 2000-01-01 to 9999-12-31, with no `24:00` and no leap second. Implementations check by re-serializing: `new Date(s).toISOString()` equals `s`, with `.000` added if `s` has no milliseconds. A timestamp that fails either check is `malformed`. Writers take it from their own clock.

**Emails.** An email (a label's, or one typed for a people lookup, section 7.3) is **normalized** by removing leading and trailing U+0020, U+0009, U+000A and U+000D only, then mapping `A`–`Z` to `a`–`z`. The normalized form MUST match

```
Email = /^(?:[A-Za-z0-9_'+\-]+\.)*[A-Za-z0-9_'+\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$/
```

and be at most 254 characters. That is zod 4.6.5's `z.email()` pattern, which the contracts `Email` uses. A directory or typed email is normalized the same way before any comparison. Any other character, U+FEFF and U+00A0 included, stays in and so causes a mismatch.

**Sealed values** are `Sealed = {nonce, ciphertext}`, both in base64url. `nonce` is exactly 24 bytes (32 characters, `^[A-Za-z0-9_-]{32}$`), and `ciphertext` is at least 16 bytes (the tag). Anything else is `malformed`. `sealedBytes(sealed)` is `nonce ‖ ciphertext`. That is what a record's `payloadHash` covers, and it is also the layout of an attachment blob.

**Payload JSON.** Payloads are encrypted as `UTF-8(JSON.stringify(object))`. They need no canonical JSON: the ciphertext is what gets hashed and signed, and the plaintext is authenticated by the AEAD. They still mustn't have duplicate member names (section 3.3, rule 7).

**Decoding payloads.** Decrypted plaintext (page payloads, node metadata, contacts payloads, vault keyrings) MUST be well-formed UTF-8 with no byte-order mark. Decoders are fatal: in JavaScript, `new TextDecoder('utf-8', {fatal: true, ignoreBOM: true})`, then refuse a result starting with U+FEFF. Invalid UTF-8 or a leading BOM is `malformed`. **Decoders take bytes, decode them as strict UTF-8 themselves, and only then parse the string as JSON.** They never hand bytes to a JSON parser that guesses the encoding. Python decodes with `json.loads(b.decode('utf-8'), parse_constant=…)`, with a `parse_constant` that raises, and never calls `json.loads(bytes)`.

**The JSON grammar is RFC 8259**, for decrypted payloads as for every signed or hashed object. `NaN`, `Infinity` and `-Infinity` are refused.

**After parsing**, a decrypted payload is `malformed` if:
- any string in it, member names included, isn't well-formed Unicode;
- any number token anywhere in it isn't finite when read as an IEEE 754 double;
- a field this document types as an integer breaks section 3.3, rule 6. That includes `format.major` and `format.minor`, an `AttachmentRef`'s `size`, the vault keyring's `public.keyVersion`, `wikistow.publication.format` (section 13), `wikistow.cover`'s `format` and `banner.focal` (section 5.5), and the contacts payloads' integers.

Payloads of v1 records may hold strings that aren't well-formed, as Milestone 1 clients wrote them (`parseJson`, `illFormedStrings`). Unknown fields of a loose payload are carried forward as they are.

### 3.3 Canonical encoding

Everything that is signed, hashed for binding, or used as AEAD associated data is built with `canonical(domain, fields)` from `packages/client/src/encoding.ts`.

```
canonical(domain, fields) = encodeField("wikistow/" + domain) ‖ encodeField(fields[0]) ‖ … ‖ encodeField(fields[n-1])

encodeField(f) = tag (1 byte) ‖ length (4 bytes, unsigned, big-endian) ‖ body

  f is null        → tag 0x00, body empty
  f is a string    → tag 0x01, body = UTF-8 of f (TextEncoder)
  f is a number    → tag 0x02, body = ASCII decimal of String(f); f MUST be a safe integer
  f is bytes       → tag 0x03, body = the bytes
```

- The domain is itself a string field (tag `0x01`), prefixed with `wikistow/`.
- There is no outer length or field count. Every domain has a fixed field list, so the domain fixes the field count and each field's meaning.
- Numbers are integers in `[-(2^53-1), 2^53-1]`. Anything else throws `malformed`. No field is negative.
- **Conventions:** IDs, enums and hashes are string fields (a hash is its base64url text). Public keys and sealed keys are bytes fields, decoded from base64url first.

Worked example: `canonical('x/v1', ['a', 1, null, Uint8Array[0x00]])`:

```
01 0000000d 77696b6973746f772f782f7631   "wikistow/x/v1"
01 00000001 61                           "a"
02 00000001 31                           1
00 00000000                              null
03 00000001 00                           bytes [00]
```

**Encoding rules for implementers:**

1. **Lone surrogates.** `TextEncoder` turns an unpaired UTF-16 surrogate into U+FFFD, so two different strings could produce the same signed bytes. **Well-formedness is a parse-time property** of every signed or hashed JSON object: records, envelopes, key wraps, folder key envelopes, owner statements and contacts records. A string in one, member names included, that isn't well-formed after JSON parsing makes the object `malformed`, before any hash or signature check.
2. **Length limit.** A field body MUST be shorter than 2^32 bytes. `encodeField` refuses a longer one rather than wrap the length.
3. **Byte fields come from strict base64 (section 3.2).** That way one JSON object has one set of signed bytes and one stored form.
4. **Field order is the order listed in this document.** It is never the order of JSON keys.
5. **Characters.** Wherever this document limits a name to a number of "characters", it means Unicode scalar values. Names are stored as given, with **no normalization**. Writers MUST refuse a name that isn't well-formed or that contains a C0 or C1 control character (U+0000–U+001F, U+007F–U+009F), U+2028, U+2029, or a bidi control (U+061C, U+200E, U+200F, U+202A–U+202E, U+2066–U+2069). This applies to node-metadata names (section 5.5), labels and agent labels (section 8.2). Readers of node metadata accept what the as-built schema accepts: a name holding these code points is shown, never `malformed`. So every interface renders a name in bidi isolation with those code points escaped or replaced, and the CLI escapes it (section 9.3).
6. **Integers in JSON.** Every integer field of a signed or hashed object MUST appear in the raw JSON text as a token matching `^(?:0|-?[1-9][0-9]*)$`, and MUST be a safe integer. So `1.0`, `1e0`, `+1`, `01` and `-0` are `malformed`, even though `JSON.parse` turns them into valid numbers. Implementations check the raw token (in JavaScript, the `JSON.parse` reviver's `context.source`).
7. **Duplicate member names.** A JSON object with two members of the same name is `malformed`. This applies to every signed or hashed object, and to every decrypted payload. A parser that detects duplicates creates own data properties only, never `obj[key] = value`, so a member named `__proto__` can't set an object's prototype. In a payload, `__proto__` is kept as an own property (section 5.5). In a signed or hashed object it is an unknown property, so `malformed` under rule 8.
8. **Strict objects.** Records, envelopes, key wraps, folder key envelopes, owner statements and contacts records have exactly the properties listed for their version. Any other property is `malformed`; parsers never strip unknown properties. Key and metadata envelope versions are selected like this:
   - no `version` property: v1;
   - `version: 2`: v2;
   - any other `version` value, including `1`: an unknown envelope version, which fails closed (section 1).

   Records are selected by `protocol` the same way: `1` is v1, `2` is v2, and any other value fails closed. Key wraps, folder key envelopes and owner statements have no `version` property; a later format adds one, so an object that has one fails closed. Payloads stay loose (section 5.5), because they carry newer minor versions forward.

### 3.4 Nonces and keys

- Every AEAD encryption uses a fresh random 24-byte nonce (`aeadEncrypt`). With 192-bit nonces, random choice is safe at any realistic volume, including the many wraps one folder key makes.
- Every revision, metadata version, attachment copy and contacts version gets a **fresh random 32-byte key**, used for that one encryption.
- Every key version of a share gets two fresh random 32-byte keys, its draft key and its published key (section 6.2). They encrypt only key wraps: 32-byte content keys.
- The vault key encrypts the keyring once per vault creation. Each passphrase or recovery KEK encrypts the vault key once per wrapper.
- Content keys are wiped (`sodium.memzero`) after sealing, wrapping or opening. Folder keys stay in memory while the app is unlocked, and are wiped when it locks.

### 3.5 Domain registry

Every domain string in the protocol. **Status** is *frozen* (v1, shipped), *kept* (added by PR #29 and unchanged), *changed* (added by PR #29 and changed here, section 15), or *new*.

| Domain | Status | Use | Fields, in order | Defined in |
|---|---|---|---|---|
| `revision-record/v1` | frozen | signed by author | protocol, installationId, spaceId, pageId, revisionId, audience, basedOn, authorId, authorKeyVersion, payloadHash | §5.1 |
| `revision-record/v2` | changed | signed by author | protocol, installationId, spaceId, pageId, revisionId, audience, basedOn, authorId, authorKeyVersion, payloadHash, keyCommitment | §5.7 |
| `content-key-commit/v1` | kept | hash input for `keyCommitment` | contentKey (bytes) | §5.7, §8.1 |
| `revision-payload/v1` | frozen | AEAD AD | installationId, spaceId, pageId, revisionId, audience, authorId, authorKeyVersion | §5.1 |
| `key-envelope/v1` | frozen | signed by granter | installationId, payloadHash, revisionId, recipientId, recipientKeyVersion, sealedKey (bytes), granterId, granterKeyVersion | §5.2 |
| `key-envelope/v2` | changed | signed by granter | installationId, spaceId, payloadHash, revisionId, recipientId, recipientKeyVersion, sealedKey (bytes), granterId, granterKeyVersion | §5.8 |
| `attachment/v1` | frozen | AEAD AD | installationId, spaceId, pageId, audience, attachmentId | §5.3 |
| `metadata-record/v1` | frozen | signed by author | protocol, installationId, spaceId, subjectKind, subjectId, metadataRevisionId, basedOn, authorId, authorKeyVersion, payloadHash | §5.4 |
| `metadata-record/v2` | changed | signed by author | protocol, installationId, spaceId, subjectKind, subjectId, metadataRevisionId, basedOn, authorId, authorKeyVersion, payloadHash, keyCommitment | §5.7 |
| `metadata-payload/v1` | frozen | AEAD AD | installationId, spaceId, subjectKind, subjectId, metadataRevisionId, authorId, authorKeyVersion | §5.4 |
| `metadata-envelope/v1` | frozen | signed by granter | installationId, payloadHash, metadataRevisionId, recipientId, recipientKeyVersion, sealedKey (bytes), granterId, granterKeyVersion | §5.4 |
| `metadata-envelope/v2` | changed | signed by granter | installationId, spaceId, payloadHash, metadataRevisionId, recipientId, recipientKeyVersion, sealedKey (bytes), granterId, granterKeyVersion | §5.8 |
| `content-key-wrap/v1` | new | AEAD AD of a key wrap | installationId, spaceId, shareId, keyVersion, audienceClass, subjectKind, subjectId, versionId | §6.3 |
| `folder-key-envelope/v1` | new | signed by sealer | installationId, spaceId, shareId, keyVersion, recipientId, recipientKeyVersion, draftKey (bytes or null), publishedKey (bytes), sealerId, sealerKeyVersion | §6.4 |
| `space-owner/v1` | new | signed by an accepted owner | installationId, spaceId, ownerId, ownerKeyVersion, ownerKeyHash, signerId, signerKeyVersion | §6.5 |
| `vault-keyring/v1` | frozen | AEAD AD | accountId | §5.6 |
| `vault-passphrase-wrap/v1` | frozen | AEAD AD | accountId, salt (base64url **string**), opsLimit, memLimit | §5.6 |
| `vault-recovery-wrap/v1` | frozen | AEAD AD | accountId | §5.6 |
| `agent-identity-id/v1` | frozen | hash input | installationId, ownerId, boxPublicKey (bytes), signPublicKey (bytes) | §4.2 |
| `identity-fingerprint/v1` | frozen | hash input | id, kind, keyVersion, boxPublicKey (bytes), signPublicKey (bytes) | §4.3 |
| `agent-enrollment/v1` | frozen | signed by human | installationId, agent.id, agent.kind, agent.keyVersion, agent.boxPublicKey (bytes), agent.signPublicKey (bytes), ownerId, ownerKeyVersion | §4.5 |
| `agent-enrollment-check/v1` | new | hash input for the enrollment fingerprint | installationId, ownerId, ownerKeyVersion, ownerBoxPublicKey (bytes), ownerSignPublicKey (bytes), agentId, agentBoxPublicKey (bytes), agentSignPublicKey (bytes) | §9.2 |
| `identity-key-hash/v1` | kept | hash input | id, kind, keyVersion, boxPublicKey (bytes), signPublicKey (bytes) | §4.4 |
| `contacts/v1` | kept | signed by the record's owner; hashed for `contactsHash` | protocol, installationId, ownerId, ownerKeyVersion, version, prevHash, payloadHash, keyCommitment, privatePayloadHash, privateKeyCommitment | §8.1 |
| `contacts-payload/v1` | kept | AEAD AD | installationId, ownerId, ownerKeyVersion, version | §8.1 |
| `contacts-private-payload/v1` | kept | AEAD AD | installationId, ownerId, ownerKeyVersion, version | §8.1 |
| `attachment-plain-hash/v1` | kept | hash input | installationId, spaceId, pageId, plaintext (bytes) | §12.1 |
| `agent-lookup-code/v1` | kept | hash input (server) | normalized lookup code | §9.2 |
| `agent-poll-secret/v1` | kept | hash input (server) | pollSecret (bytes) | §9.2 |
| `agent-credential/v1` | kept | hash input (server) | credentialId, secret (bytes) | §9.6 |

Every domain is distinct, and the `wikistow/` prefix sets them apart from any other protocol. `contacts/v1` is both signed and hashed; the hash only names the bytes the signature covers. No domain's bytes are ever accepted as the message of a different domain, because every verifier rebuilds the bytes from its own domain string. Section 15 lists the domains PR #29 added that this design retires.

---

## 4. Identities

### 4.1 Public identity

`PublicIdentity` (`contracts/src/records/identity.ts`):

| Field | Type | Meaning |
|---|---|---|
| `id` | ID | Stable across key versions |
| `kind` | `"human"` \| `"agent"` | |
| `keyVersion` | integer ≥ 1 | Starts at 1 and increases on identity key rotation |
| `boxPublicKey` | PublicKey | X25519, receives sealed keys |
| `signPublicKey` | PublicKey | Ed25519, signs |

Keys are generated on the client (`generateIdentity`). The server stores only the public half, one row per `(id, keyVersion)`, and never changes a row's keys. It keeps `revokedAt`, and a human has at most one live row per account. **A human's ID** is `newId`, and its first key version is 1.

**Key acceptance.** A client checks both public keys whenever it pins an identity, uses a key from the directory, or accepts an agent enrollment:

- **X25519 (`boxPublicKey`).** Refuse a non-canonical encoding: a key whose top bit (bit 7 of byte 31) is set, or whose value as a little-endian integer is at least 2^255 − 19. Then refuse a key of low order: `crypto_scalarmult(s, boxPublicKey)` with a fixed clamped scalar `s` gives 32 zero bytes, or the call fails. Without the first rule one key would have several `keyHash`es, fingerprints and agent IDs.
- **Ed25519 (`signPublicKey`).** Refuse a key for which `crypto_core_ed25519_is_valid_point` returns false.

A refused key is `bad-key`. The server applies the same checks and refuses to register such keys. Keys libsodium generates always pass.

### 4.2 Agent IDs (as built)

An agent's ID is derived, so it can't be claimed under someone else's name:

```
agentId = "agent-" ‖ base64url(BLAKE2b-256(canonical('agent-identity-id/v1',
            [installationId, ownerId, boxPublicKey (bytes), signPublicKey (bytes)])))
```

That is 6 + 43 = 49 characters, and every agent ID matches

```
AgentId = /^agent-[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/
```

Every field this document types as an agent ID uses it: `revokedAgents`, the agent IDs in `agents` enrollments, and `agentId` in the enrollment check (section 9.2). Anything else there is `malformed`. **Anyone holding an agent's public keys can check whose agent it is**, by recomputing the ID from the person's ID; attribution relies on this (section 9.5). Agents always have `keyVersion` 1. Rotating an agent's keys means enrolling a new agent. Human IDs never start with `agent-`: the server refuses a human row with that prefix, and pinning refuses one.

**`HumanId`** is an ID (section 3.2) that doesn't start with `agent-`. A value that starts with `agent-` but isn't an `AgentId` is invalid in every ID field.

### 4.3 Fingerprints (as built)

```
fingerprintBytes = BLAKE2b-160(canonical('identity-fingerprint/v1',
                     [id, kind, keyVersion, boxPublicKey (bytes), signPublicKey (bytes)]))
fingerprint      = lowercase hex of fingerprintBytes, in groups of 4 separated by single spaces
                   (10 groups, for example "3f9a 0c1e …")
```

The key-change warning shows the old and new fingerprints (section 8.4), and contact details show a pinned key's fingerprint. Agent enrollment uses the enrollment fingerprint, which has the same form and covers both parties' keys (section 9.2).

### 4.4 Key hashes

A 32-byte hash names a person's exact key in labels, `removed` entries and owner statements:

```
keyHash = base64url(BLAKE2b-256(canonical('identity-key-hash/v1',
            [id, kind, keyVersion, boxPublicKey (bytes), signPublicKey (bytes)])))
```

An **identity reference** is the triple `{id, keyVersion, keyHash}`. A client resolves it to a `PublicIdentity` with keys from the directory row for exactly that `id` and `keyVersion`, and accepts the result only if it recomputes to `keyHash` and its keys pass section 4.1.

### 4.5 Agent enrollment record (as built)

`AgentEnrollment` (`trust.ts`) = `{installationId, agent: PublicIdentity, ownerId, ownerKeyVersion, signature}`, signed by the human over:

```
canonical('agent-enrollment/v1', [installationId, agent.id, agent.kind, agent.keyVersion,
          agent.boxPublicKey (bytes), agent.signPublicKey (bytes), ownerId, ownerKeyVersion])
```

To accept an enrollment (`verifyEnrollment`):
- the installation matches;
- the owner is pinned and is a human;
- `agent.kind` is `agent`, and `agent.keyVersion` is 1;
- `agent.id` equals `agentIdentityId(installationId, ownerId, agent keys)`;
- the agent's keys pass section 4.1, and the signature verifies.

`enrollAgent` takes the compared enrollment fingerprint (section 9.2), and refuses if it doesn't match the keys. The record format doesn't change.

### 4.6 Identity key rotation

Identity key rotation, and the statement that would announce it, are left to a later milestone (Q4). In Milestone 2 a person's key version still increases when they replace lost keys during recovery. Every other app treats that as a key change (section 8.4): owners share with the person again after confirming it (section 7.3), and an owner is re-added as a co-owner (section 7.6).

---

## 5. Content objects

Sections 5.1 to 5.6 record what Milestones 0 and 1 built. Those v1 formats stay readable exactly as built. Milestone 2 adds v2 records (section 5.7) and v2 envelopes (section 5.8). Inside a share, content keys are wrapped with folder keys instead of sealed to people (section 6.3).

### 5.1 Revisions

**Revision record** (`contracts/src/records/revision.ts`, `RevisionRecord`): `protocol` (1), `installationId`, `spaceId`, `pageId`, `revisionId`, `audience` (`"draft"` \| `"published"`), `basedOn` (revision ID or null), `authorId`, `authorKeyVersion`, `payloadHash`.

`basedOn` names the previous draft for a draft, or the exact draft that was published for a published revision.

**Sealing** (`sealRevision`):

```
contentKey  = crypto_aead_xchacha20poly1305_ietf_keygen()
ad          = canonical('revision-payload/v1', [installationId, spaceId, pageId, revisionId,
                                                audience, authorId, authorKeyVersion])
sealed      = XChaCha20-Poly1305(contentKey, random 24-byte nonce, UTF-8(JSON.stringify(payload)), ad)
payloadHash = base64url(BLAKE2b-256(nonce ‖ ciphertext))
signature   = Ed25519(author, canonical('revision-record/v1', [protocol, installationId, spaceId,
              pageId, revisionId, audience, basedOn, authorId, authorKeyVersion, payloadHash]))
```

The author is bound into the AD, so nobody can re-sign another person's ciphertext as their own and still have it decrypt. **The AD doesn't bind the payload format version.** The format is inside the authenticated plaintext, and `protocol` is in the signed record. This is recorded as built.

**SealedRevision** wire form: `{record, signature, payload: Sealed}`.

**Opening** (`openRevision`). These checks run in order, and any failure throws a `CryptoError`:

1. The record and envelope match their schemas (`malformed`).
2. The record names exactly the installation, space, page, revision and (if given) audience the caller asked for (`binding-mismatch`).
3. The author's key at `authorKeyVersion` passes section 8.4, and the record signature verifies (`identity-key-changed`, `bad-signature`).
4. The hash of `nonce ‖ ciphertext` equals `payloadHash` (`hash-mismatch`).
5. The envelope names this revision and this reader at the reader's current key version (`wrong-recipient`). The granter is trusted and its signature verifies (`bad-signature`).
6. The sealed key opens, and the payload decrypts under the AD (`decrypt-failed`).
7. The payload parses (section 5.5).

`verifyRevisionRecord` runs steps 1–3 for lists such as history, which show records without content.

**Server checks before storing** (`verifyRevisionCommit`, `checkEnvelopes`): the record binds this installation, space, page and audience; the author is the caller's current identity; `basedOn` equals the current head (`stale-head`); the signature is valid; `payloadHash` matches the ciphertext; and the key material is the one section 6.8 requires for the page's region. The writer also sends the current permission version (section 6.8).

### 5.2 Key envelopes v1

**KeyEnvelope** = `{revisionId, recipientId, recipientKeyVersion, sealedKey, granterId, granterKeyVersion, signature}`.

```
sealedKey = base64url(crypto_box_seal(contentKey, recipient.boxPublicKey))     // 80 bytes for a 32-byte key
signature = Ed25519(granter, canonical('key-envelope/v1', [installationId, payloadHash, revisionId,
            recipientId, recipientKeyVersion, sealedKey (bytes), granterId, granterKeyVersion]))
```

`keyEnvelopeBytes` lives in `revision.ts`. `envelope.ts` holds the shared parts: `sealKeyTo`, `openSealedKey` and `openEnvelope`. The v1 bytes bind the space, page and audience through `payloadHash`, which the signed record covers.

In Milestone 1, every v1 envelope's granter is the author, and the server enforces that. **Clients accept a v1 envelope only on a v1 record, and only if `granterId` and `granterKeyVersion` equal the record's author.** New envelopes are v2 (section 5.8).

### 5.3 Attachments

An attachment is encrypted under its own fresh key (`sealAttachment` → `encryptAttachment`):

```
ad       = canonical('attachment/v1', [installationId, spaceId, pageId, audience, attachmentId])
blob     = nonce ‖ ciphertext                        // sealedBytes
blobHash = base64url(BLAKE2b-256(blob))
```

The AD doesn't bind a revision, so one copy can be listed by several revisions of the same page and audience. It does bind the audience, so a draft copy never opens as a published one. It doesn't bind the share, so moving a page (section 10) doesn't touch its attachments.

The **AttachmentRef** lives inside the encrypted payload (`payload.ts`): `{id, name, mediaType, size, key, blobHash, plainHash?}`. It is a loose object, so unknown fields survive. **Attachment keys are never wrapped or sealed on their own.** They travel inside the payload, so they are under whatever protects the revision's content key: a folder key inside a share, or the owners' envelopes outside one.

**Decrypting an attachment** checks `blobHash` against the downloaded blob, then decrypts under the AD. When the ref has a `plainHash`, the client also recomputes it over the plaintext (section 12.1) and refuses a mismatch (`hash-mismatch`).

**Publishing re-encrypts every attachment** for the published audience under a fresh key, keeping its ID (`resealAttachment`). Restoring a published version to a draft does the same in reverse. A key from one audience never opens the other audience's blobs. Reuse of an earlier copy follows section 12.

On the server, a blob is labelled with its page and audience when it is uploaded. It stays staged until a revision that lists it commits, and those labels never change (`uploadBlob`, `attachBlobs`).

### 5.4 Metadata (space and folder names)

**MetadataRecord** (`contracts/src/records/metadata.ts`): `protocol` (1), `installationId`, `spaceId`, `subjectKind` (`"space"` \| `"folder"` \| `"group"`), `subjectId` (the space ID, folder ID or group ID), `metadataRevisionId`, `basedOn`, `authorId`, `authorKeyVersion`, `payloadHash`. A group's name is only ever a v2 record (section 7.8).

Sealing works the same way as for revisions (`sealMetadata`):

```
ad        = canonical('metadata-payload/v1', [installationId, spaceId, subjectKind, subjectId,
                                              metadataRevisionId, authorId, authorKeyVersion])
signature = Ed25519(author, canonical('metadata-record/v1', [protocol, installationId, spaceId,
            subjectKind, subjectId, metadataRevisionId, basedOn, authorId, authorKeyVersion, payloadHash]))
```

**MetadataEnvelope** v1 is signed over `canonical('metadata-envelope/v1', [installationId, payloadHash, metadataRevisionId, recipientId, recipientKeyVersion, sealedKey (bytes), granterId, granterKeyVersion])`. `metadataEnvelopeBytes` lives in `metadata.ts`.

Opening (`openMetadata`) runs the same checks as revisions, with every expected field required. The server's checks are in `verifyMetadataCommit`.

**Authority.** Renaming a space or a group needs an owner. Renaming a folder needs edit rights at the folder: an owner, or an editor of the share the folder is in. Only the server checks this (A1).

### 5.5 Payload and metadata formats

**Page payload** (format 1.0; 1.1 adds `plainHash`):

```
{ format: {major: 1, minor}, title: string, markdown: string,
  attachments: AttachmentRef[], extensions: { [namespace]: JSON } }
```

**Node metadata** (format 1.0): `{format: {major: 1, minor}, name: 1–200 characters, emoji?: ≤32, tint?: ≤32, extensions}`. Writers refuse names that aren't well-formed or contain control characters (section 3.3, rule 5).

Rules (`payload.ts`, `metadata.ts`):
- Objects are loose, so fields from a newer minor version survive a save by an older client.
- `extensions` namespaces a client doesn't know are copied unchanged into the next version.
- A newer **major** version opens as `newer-format`, and the client refuses to save over it (`unsupported-format`).
- **Key material lives only in `attachments[].key`.** Publishing re-encrypts listed attachments and copies everything else, so a key stored anywhere else would reach readers.
- Clients validate against the schema but keep the original object, so a data key named `__proto__` survives.

**Page cover** (`cover.ts`), the extension `wikistow.cover`:

```
{ format: 1, emoji?: string,
  banner?: {kind: "theme"} | {kind: "preset", name: "sunrise" | "ocean" | "meadow" | "lavender" | "dusk" | "stone"}
         | {kind: "image", attachmentId, focal: integer 0–100},
  icon?: {attachmentId},
  symbol?: {name} }
```

- `emoji` is one RGI emoji (Unicode UTS #51): a pictograph, a flag, a keycap, or a modifier, tag or ZWJ sequence, with nothing stacked after it. A reader whose Unicode data predates an emoji leaves it out. `focal` is the image's vertical focal point, 0 at the top. `format` and `banner.focal` are integers (section 3.3, rule 6).
- An image banner names one of the version's own attachments by ID; its key stays in `attachments[]`, so publishing re-encrypts it with the rest.
- `icon` is the page's own image, shown in place of its emoji. It names one of the version's attachments the same way: an image the writer resized to fit 144 by 144 pixels and encoded afresh as WebP, JPEG or PNG, as for a folder icon below. The emoji stays beside it: choosing an image keeps the emoji, which older clients and failed loads show; choosing an emoji removes `icon`, and replacing or removing the image drops its attachment from `attachments[]` unless the text links to it.
- `symbol` is an icon from the app's icon set, shown in place of the emoji: `name` is a Lucide icon's name, such as `square-terminal` (lowercase letters and digits in words joined by `-`, at most 64 characters). It needs no attachment. The emoji stays beside it as beside an image. Choosing an icon removes `icon`; choosing an emoji or an image removes `symbol`. Where both are present, as when an older client added an image, the image shows.
- Readers fall back part by part: an emoji they don't accept is left out, a banner of an unknown kind, or an image the version doesn't list, shows the theme gradient, and an icon the version doesn't list, or whose image doesn't load, shows the emoji, as does a `symbol` that isn't a name or that the reader's icon set doesn't have (Lucide keeps renamed icons' old names, which still show). A writer changing one part keeps the others, and unknown fields, as they were.
- Publishing into another space (section 13) without the banner's attachment writes `banner: {kind: "theme"}` in the copy, and without the icon's attachment leaves `icon` out.

**Folder and space icon** (`metadata.ts`), the node metadata extension `wikistow.icon`:

```
{ format: 1, mediaType: "image/webp" | "image/jpeg" | "image/png", data: base64url }
```

- A folder's or space's own image, shown in place of its emoji. The writer resizes it to fit 144 by 144 pixels and encodes it afresh (an SVG is drawn as pixels; SVG is never stored). `data` is the encoded image, at most 16 KB (16,384 bytes), since every tree load carries each folder's current metadata, and the spaces list each space's.
- It has no key of its own: it is encrypted with the rest of the metadata, so it reaches exactly the people who can read the folder's or space's name, and moves, shares and rotations need nothing more. The key-material rule above is unchanged.
- Readers show it only when `format` is 1, `mediaType` is one of the three, and `data` decodes to 1 to 16,384 bytes. Anything else, or an image that fails to decode, counts as no image, and the folder or space shows its emoji (a space without one, the initials of its name); it never makes the metadata `malformed`. Writers refuse what readers would not show.
- Extensions are merged into the next version, so removing the image writes `wikistow.icon: null`. Choosing an emoji removes the image; choosing an image keeps the emoji, which older clients and failed loads show. A space's emoji can be removed too, which leaves `emoji` out of the next version.

**Folder and space icon from the icon set** (`metadata.ts`), the node metadata extension `wikistow.symbol`:

```
{ format: 1, name }
```

- An icon from the app's icon set, Lucide, shown in place of the emoji, named as in a page cover's `symbol`. It is encrypted with the rest of the metadata, like `wikistow.icon`.
- Readers show it only when `format` is 1 and `name` is a name their icon set has. Anything else counts as none and shows the emoji (a space without one, its initials); it never makes the metadata `malformed`. Where `wikistow.icon` is present too, as when an older client added an image, the image shows.
- Removing it writes `wikistow.symbol: null`. Choosing an icon removes the image (`wikistow.icon: null`); choosing an emoji or an image removes the icon. The emoji stays beside it, for older clients and the CLI.

**Link table** (`wikistow.links`, format 1, `link-table.ts`; added after the freeze, see `protocol-review.md`). It maps each wikilink to the page it names, so the link follows that page through a rename (`wikistow.md`, Wikilinks):

```
{ format: 1, links: [{ key: string, pageId: PageId }] }
```

- **Keyed by text, not position.** `key` is the link's target as written, before any `#` or `|`, with a `Folder/` prefix included, lower-cased as titles match (`toLocaleLowerCase('en')`). Every link with that target uses the entry. Embeds and `[[#Heading]]` have none. A table may also hold the key a link had before its save renamed it (see **Renames**).
- **Who it names pages to.** A writer keeps an entry only when everyone who can open the version can open its page. "Can open" means holds the keys. An agent holds the keys of its whole share, though the server limits it to its picks (section 9.4, A1), so a version it can open may name a page of that share outside its picks; it could decrypt that page if it were served. Keys are share-wide, so the rule compares regions (section 6.1):
  - The version's region is the write's (`writeRegion`).
  - The page's region is the region of the version the writer's app opened for its title (its draft, or its publication for a reader), taken from that version's key material, never from the tree. The tree only places pages. If the tree puts a page in another region than its key material does, the page gets no entry and no rename. A page whose version the app didn't open counts as one the writer doesn't see. One opened in a newer format, whose title the app can't read, still counts as seen by a writer: its entry is checked by these rules, not carried. Readers follow an entry only to a page opened for its title (see **Readers**). A version remembered from before a share or move is opened again when the tree places its page elsewhere.

  An entry is kept when:
  - the page is the one written;
  - or the version is in the owner region: only sealing owners open it, and they hold every share's keys;
  - or the page is in the same share, and, for a published version, the writer's app opened the page's current publication, in that share.

  Every other link has no entry. That covers a page in another share, in the owner region, or only in a draft, a missing link, and an ambiguous one with no earlier choice. Each viewer then resolves the link by title in their own tree.
- **Which page.** In a draft, or a publication in the owner region, an entry from the payload's table is followed when the writer sees its page. Otherwise the link resolves by title among the pages the writer sees, and only a single match counts. A choice between pages of one title is therefore kept for as long as the link's text is unchanged. The title wins over the entry when a page this version could name (one that would get an entry itself, by the rules above) has the link's text as its title and the entry names another page, whether or not the writer sees the entry's page: the text may be newly typed for the page titled so. Without this, a link typed with a renamed page's old title would name the renamed page. A page titled so that this version can't name, such as one in another share or the owner region, or one the tree misplaces, doesn't take the link: the entry and its rename hold, since no reader of this version could open that page.
- **A publication into a share** goes only by the text it publishes and what that share's readers can already read: neither another page's draft title nor the entries in the draft being published count. The pages it matches are those it could name (by the rules above), each under the title of its current publication there, as the publisher's app opened it, and the page written under the title it publishes. A `Folder/` prefix matches only folders from the share's root down, the ones its readers see. Each link then:
  - names the page it resolves to by those titles, when that is a single page. The title wins, as in **Which page**;
  - otherwise keeps the entry the page's own current publication has for that key, when the publisher's app opened that publication in the same share, and the entry's page is one of the pages it matches (so published there now), and one of those the link matches by title, or the link matches none. An entry for a page since unpublished, or moved out of the share, goes. So a link still follows a page renamed and published since, and a choice between pages of one title holds once readers have read it. A link without its own text that matches none doesn't keep it when another link in the text names that page by title. This is a heuristic that takes the link as newly typed, perhaps for a page not made yet, so a renamed page's old text typed again doesn't name that page for readers. A save renames such a link when it can, but not always, so the heuristic also drops entries readers were following (see **Renames** for what it misses and what it drops);
  - otherwise has no entry, and readers resolve it by title.

  So a share publication's table depends only on publication titles in that share, folder names from its root down, the page's own current publication there, its links' text, which of those pages the publisher sees, and the rules above, never on draft state. Readers learn nothing of any draft from it, nor from what it drops. A draft's entry may have been picked by a draft title, so it never counts here. A link to a page renamed before the linking page's first publication in the share therefore gets no entry there until a draft save renames its text (see **Renames**); until then readers resolve it by title. Drafts, which only editors open, and publications in the owner region, which only owners open, match titles as the writer's tree shows them.
- **Carried forward.** A draft keeps an entry whose page the writer doesn't see, for as long as the link's text is unchanged. An agent sees only its picks, and an editor may see less than an earlier writer. It is kept only when the table came from a version in the write's region: the region the writer's app opened that version in (`tableRegion`). Otherwise every entry the writer can't check is dropped, and the table is worked out again. So an editor holding a page while someone moves it saves no entry from before the move. A share or move rewraps the whole history (sections 6.7 and 10), so a version opened after it opens in the new region and its entries are carried. That is the exposure the accepted risk below already covers: everyone who can open the new draft can open that version too. A publication carries nothing it can't check: an entry for a page the publisher doesn't see is left out. A draft saved when the writer's app can't load the tree is still saved: its entries are carried by the same rule, and nothing is renamed other than a link to the page itself.
- **Recomputed on publish.** Publishing works the table out again for readers, from the publisher's tree loaded at that moment, since the publisher may see less than the draft's writer. Restoring a publication as the draft works the table out again as for a draft, carrying entries only if the publication opens in the draft's region. Restoring a publication makes it the draft; links to pages renamed since are written with their current published titles.
- **Renames.** When a draft is saved, a link without its own text (no `|`) whose entry is kept gets its page's published title in the source, when both that title and the title the writer's tree shows for the page (its draft title, for an editor) differ from the link's text. A page whose shown title is still the link's text keeps the link as written, whatever its publication is called. The title comes only from the page's current publication, as the writer's app opened it, and only when that publication is in the same region as the version written. In the owner region, only a page in the owner region lends its title. A title from a draft is never written into a link: publishing the linking page would show it to readers who can't open that draft. A page with no publication, or in another region, keeps the link as written; a viewer who can open the page still sees its current title through the entry. A `#heading` and the whitespace around the target stay as written, and so does a `Folder/` prefix that still names folders above the page. A link to the page itself takes its title as written in the same version. The entry's key changes with the link, and its old key stays in the table for that version, so a copy of the text from before the rename (an agent's, say) still names the page when saved on top. The old key is kept only while no other page this version could name has the old text as its title; otherwise that title would win anyway (see **Which page**). Like every entry, it is dropped at the next save unless a link still uses that text. The editor that made the rename shows the new text, so it builds its next save without the old keys (`linksInUse`): a link it then types with the old text, say to create a page by that title, isn't taken for the renamed page. Any other writer saving on top of the renaming version (an agent, another tab) can't tell its copy of the old text from a link newly typed with it, so until a save drops the old key, a link newly written with the old text for a page that doesn't exist yet names the renamed page, and is renamed with it. A share publication has a like limit, which lasts longer: it keeps the entry the page's current publication there has for the old text (see **A publication into a share**). So a link newly written with the old text, when it or another link with that text has its own text (`[[Plan|…]]`), or no other link names the renamed page by title (say the renamed link was deleted, then typed again), names the renamed page for readers, and each later publication keeps it, until a page is published in the share under that text. The same rule also drops an entry readers were following, when another link names the renamed page by title and a draft save kept the old-text link's entry without renaming it, for any reason; among them, the writer doesn't see the page (an agent, say), the save had no tree, the page's draft is still titled as the link, the page wasn't yet published under its new title or its publication couldn't be opened when the save ran, or a case below blocked the rename. Each share publication then leaves the entry out, and readers resolve the link by title, usually as a missing link, until a save renames it and the page is published again. It names no wrong page and shows nothing of drafts. A draft save may pick a link's page by a draft title (see **Which page**), and a later save then renames the link to that page's published title, which publishing shows to readers. Readers who saw the old text as a missing link may take that as a hint that the page once had a draft by that title, though the editor could as well have retyped the link. The source isn't changed when:
  - the title can't be written into a link (it holds `[`, `]`, `|`, `#`, a backtick, `<`, `\`, or a line break, or starts or ends with a space);
  - the new text wouldn't resolve by title to that page alone among the pages the writer sees, since anyone without the entry resolves it that way. The check takes the page under its published title, and every other page under the title the writer's tree shows (its draft title, for an editor);
  - another link already uses the new text for something else;
  - or the result wouldn't read back as the same links.
- **Readers** follow an entry only when its page is in their own tree and their app opened that page's version for its title, and then show that page's current title for a link without its own text. An entry for any other page counts for nothing: the link resolves by title, or is the same plain text as a missing one. Readers don't apply the title-wins rule: they follow the entry even when another page in their tree now has the link's text as its title, until a writer's next save switches it, so a writer and readers may disagree until then.
- **Not copied across spaces.** A publication into another space (section 13) leaves `wikistow.links` out, since its entries name pages of the source's space. Detaching leaves it out too, in case a copy made before this rule holds one.
- A table in a format other than 1 is a newer client's. A draft in the region its table came from keeps it unchanged. Anywhere else it can't be checked, so it is dropped and the table worked out again in format 1. Markdown whose links can't be read (nested past the parser's stack) gets no table.
- **The tree is the server's.** It decides which pages a writer sees, and which publication is current (A2). It can't get a page from another region named or its title written: a page's region comes from its key material. The one exception is a page that has since left the region, when the server keeps serving the old wraps it had there, or the app still remembers a version of it from there and the server puts the page back in that region: that page can be named, and the title of its old publication written, from a version the region could open. A page it misplaces never takes a link from its entry by title. A server that hides a page, or misplaces it, costs that link its entry, or makes a draft carry an entry the writer can't check, which an earlier version already held. Where pages share the link's text as their title, hiding all but one gets the link that one, and in a share each later publication keeps it through the page's current publication, even once the server serves the others again. That page is still one titled as the link, which every reader can open. A tree that places a folder of the owner region inside a share, or puts the share's root on a folder above it, gets those folders' names matched by that share's publications. One that leaves the root out, or puts it on a page, cuts no folders, so names above the share count. Either way a link tells readers one bit: whether the owner's folders have the names its text gives. A server that serves an old publication as current can get that version's title written or matched, or, for the page being published, its entries kept, all of which the version's readers could already read. A page unpublished after the publisher's tree loads and before the publication is written stays named in it: readers learn only the ID of a page they could open moments before, whose title the link's text already holds.
- **Accepted risk: re-wrapping exposes old link entries.** When a folder is later shared or a page moved (sections 6.7 and 10), retained old versions are wrapped for the new region, link tables included, and later drafts carry those entries for pages their writers can't see. New members can then read an entry naming a page they can't open, and so learn that a page by that link's text existed when the version was written. The link's text already names the title, and renderers never show an entry for a page outside the viewer's tree, or one whose version the viewer's app didn't open. This is the same exposure the old text already has.

  The risk also covers titles a rename wrote into the text. In the owner region, a save renames a link to an owner-region page with that page's published title, which only owners can read (section 6.6). The client writes it on the person's behalf, as if they had typed the new title themselves. When the linking page's folder is later shared, or the page moved into a share, the new members read that title in its text, though the page it names stays closed to them. A page moved from one share to another likewise shows the new members titles of the first share's pages. The share and move previews (sections 6.7 and 10) name the pages, not the titles in their links.
- **Accepted risk: older clients copy the table.** A client from before this rule (Milestone 2, such as an agent's CLI that wasn't updated) copies a draft's table into the publication when it publishes, and into a copy when it publishes into another space. Readers can then learn the IDs of pages they can't open, such as unpublished pages of their share, keyed by the link's text, and a destination space the IDs of pages in the source space. The server doesn't refuse older clients. Nothing is deployed yet, so the rule is that every client (web, desktop and CLI) must be at least this version before real use, at the Milestone 4 rollout.

### 5.6 Vault

**VaultWrapper** (`contracts/src/records/vault.ts`), format 1:

```
{ format: 1, accountId,
  keyring:    Sealed,                                         // under vaultKey
  passphrase: Sealed & { salt, kdf: {opsLimit, memLimit} },   // vaultKey under the passphrase KEK
  recovery:   Sealed }                                        // vaultKey under the recovery KEK
```

- **Keyring plaintext:** `UTF-8(JSON.stringify({public: PublicIdentity, boxSecretKey, signSecretKey}))`, with the secret keys in base64url. AD = `canonical('vault-keyring/v1', [accountId])`.
- **Passphrase KEK:** `crypto_pwhash(32, passphrase, salt (16 random bytes), opsLimit, memLimit, ARGON2ID13)`. AD = `canonical('vault-passphrase-wrap/v1', [accountId, salt (base64url string), opsLimit, memLimit])`. The cost settings are bound into the AD, so a server can't lower them unnoticed. The passphrase bytes are the UTF-8 of the string as entered, with **no Unicode normalization**. New passphrases MUST be well-formed Unicode.
- **KDF settings:** the default is `OPSLIMIT_INTERACTIVE` (2) with `MEMLIMIT_INTERACTIVE` (64 MiB). Accepted settings range from libsodium's `OPSLIMIT_MIN` and `MEMLIMIT_MIN` up to the `…_SENSITIVE` values. **That minimum is a guard against hangs, not a strength floor** (Q3). A memory failure surfaces as `kdf-failed` and never retries with weaker settings.
- **Recovery key:** 32 random bytes, shown as 64 lowercase hex digits in groups of 4 joined by `-`. The KEK is `crypto_kdf_derive_from_key(32, 1, 'wsrecov1', recoveryKey)`. AD = `canonical('vault-recovery-wrap/v1', [accountId])`.

The account password plays no part. A password reset can't unlock the vault.

### 5.7 Records v2

v1 records don't sign the content key, so an author can make one ciphertext open to different content for different readers (section 3.1). v2 records close that by adding one signed field.

```
RevisionRecordV2 = { protocol: 2, installationId, spaceId, pageId, revisionId,
                     audience: "draft" | "published", basedOn: RevisionId | null,
                     authorId, authorKeyVersion, payloadHash, keyCommitment: Hash32 }

signed bytes = canonical('revision-record/v2', [protocol, installationId, spaceId, pageId, revisionId,
               audience, basedOn, authorId, authorKeyVersion, payloadHash, keyCommitment])

MetadataRecordV2 = { protocol: 2, installationId, spaceId, subjectKind: "space" | "folder", subjectId,
                     metadataRevisionId, basedOn: MetadataRevisionId | null,
                     authorId, authorKeyVersion, payloadHash, keyCommitment: Hash32 }

signed bytes = canonical('metadata-record/v2', [protocol, installationId, spaceId, subjectKind, subjectId,
               metadataRevisionId, basedOn, authorId, authorKeyVersion, payloadHash, keyCommitment])

keyCommitment = base64url(BLAKE2b-256(canonical('content-key-commit/v1', [contentKey (bytes)])))
```

- The fields before `keyCommitment` have the same names, types and meaning as in v1 (sections 5.1 and 5.4). `protocol` is the number `2`. The wire form is `{record, signature, payload}`, plus the key material of section 6.8.
- `contentKey` is the 32-byte key that encrypts the payload. The canonical input is 72 bytes: the domain field (`01 0000001e` then the 30 bytes of `wikistow/content-key-commit/v1`) and the key field (`03 00000020` then the 32 key bytes).
- **The payload ADs don't change.** v2 records still use `revision-payload/v1` and `metadata-payload/v1`.
- **No key version in the record.** Which share and key version wrap the content key is in the key wrap (section 6.3), not in the signed record, so an owner can rewrap content after a move without its author (section 10).

**Sealing** is the v1 procedure, plus: compute `keyCommitment` from the content key before wiping it, and sign the v2 bytes.

**Opening** a v2 record runs the v1 checks of section 5.1, with one addition: after the content key is unsealed or unwrapped, and before the payload is decrypted, the client recomputes `keyCommitment` and compares it with the record's. A mismatch is **`key-commitment`**, and the client doesn't decrypt. Step 5 accepts a v2 envelope (section 5.8) or a key wrap (section 6.3), never a v1 envelope.

**Which version.** From Milestone 2, every new record is v2, in every space, and the server refuses a new v1 record. A client accepts a v1 record only if its author is an accepted owner of the space (section 6.5, A11), and otherwise refuses it (`untrusted-sealer`). Milestone 1 content has only its owner as author, so this holds for all of it.

### 5.8 Key and metadata envelopes v2

Outside shares, content keys are still sealed to people, as Milestone 1 sealed them to the one owner (section 6.6). v2 envelopes name the space, and let the granter differ from the author, so an owner can seal existing content to a new co-owner (section 7.6).

```
KeyEnvelopeV2 = { version: 2, revisionId, recipientId, recipientKeyVersion, sealedKey,
                  granterId, granterKeyVersion, signature }

signature = Ed25519(granter, canonical('key-envelope/v2', [installationId, spaceId, payloadHash,
            revisionId, recipientId, recipientKeyVersion, sealedKey (bytes), granterId, granterKeyVersion]))

MetadataEnvelopeV2 = the same, with metadataRevisionId in place of revisionId, signed over
            canonical('metadata-envelope/v2', [installationId, spaceId, payloadHash, metadataRevisionId,
            recipientId, recipientKeyVersion, sealedKey (bytes), granterId, granterKeyVersion])
```

`spaceId` and `payloadHash` come from the record the envelope unlocks; they aren't JSON properties of the envelope. `sealedKey` is 80 bytes.

**Opening** (`openEnvelope`, v2):
1. It names this record version, and this reader at its current key version (`wrong-recipient`).
2. The granter is an accepted owner of the space (section 6.5), at a key that passes section 8.4, and the signature verifies. Otherwise `untrusted-sealer` or `bad-signature`.
3. The sealed key opens (`decrypt-failed`), and matches the record's `keyCommitment` (`key-commitment`).

**Server checks** (`checkEnvelopes`): the envelopes go to **exactly** the space's current owners at their current key versions, each envelope names this record, and each is signed by the caller. A v2 record is refused with any v1 envelope. Envelopes a granter adds later for existing records (section 7.6) need the granter to be an owner, and the recipient to be one.

---

## 6. Shares and folder keys

### 6.1 Shares and regions

A **share** is a folder, or a whole space, that has its own folder keys. It is made when an owner first shares the folder with a person (section 7.3), or when a person first grants their agent a folder in a space they own (section 9.4). Sharing a space means sharing its top: the share's root is the space itself, and it covers every folder and page in the space and the space's name.

```
Share = { shareId: ID, spaceId, rootId: FolderId | null, currentKeyVersion: integer ≥ 1 }
```

`shareId` is made by the owner's client with `newId`. The server keeps share IDs unique across the installation, and refuses a new share whose ID is already used in any space. `rootId = null` means the whole space. The server stores the row, the share's members and their roles (section 7.1). None of this is signed: which people hold keys is fixed by the signed folder key envelopes (section 6.4), and everything else is the server's to enforce (A1).

**Regions.** Every page, every folder's name and the space's name has exactly one **region**, which decides what protects its content keys:
- a node's region is the share whose root is the node itself or its nearest ancestor that is a share root, and every node is in the space share if there is one;
- the space's name is in the space share if there is one;
- anything else is in the space's **owner region** (section 6.6). A group's name (section 7.8) is always there, in a shared space too.

So a share root's own name is in that share, and the names of the folders above it are not.

**A record's region, as a client sees it,** comes from the key material through which that client opened it, never from the tree:
- opened through a key wrap, whether the record is v1 or v2: the share named by the wrap's `shareId`, in the record's space;
- opened through a v1 or v2 envelope: the owner region.

The server serves a record with either its wrap or the caller's own envelopes, never both. A client served both refuses (`region-mismatch`).

**A new node's region** is the region of its parent's own name record: the current metadata version of the parent folder, or of the space for a top-level node. A parent whose name record is in the owner region puts the child in the owner region; a parent whose name record is wrapped under share `S` puts the child in `S`. Any other write is in the region of its `basedOn` record. A write with `basedOn: null` on an existing page, such as a publication into an existing destination page or the first draft written when detaching (section 13), is in the region of that page's current draft if this app opened it, otherwise of its current published record. If the app opened both in different regions, or opened neither, it refuses (`region-mismatch`). A new destination page of a publication is a new node, and takes its parent's region.

**No nesting.** A share root is never inside another share. The server refuses, as `share-nesting`:
- making a share on folder `F` when an ancestor of `F` is a share root, or the space is shared, or `F`'s subtree holds a share root. A space share needs a space with no shares;
- a move (section 10) that would put a share root, or a subtree that holds one, inside a share.

Shares made for agents count as shares here. Milestone 2 has no way to stop a share, so a folder that holds a share can't be shared; a later milestone may add one.

### 6.2 Key versions

Each share has key versions `1, 2, …`. A key version holds two fresh 32-byte keys: the **draft key** and the **published key**. An owner's client makes version 1 when it makes the share (section 6.7), and a new version at every key rotation (section 7.5). The server keeps `currentKeyVersion`. It moves up by exactly one, only through a rotation it accepts under a compare-and-swap on the current version. Versions are never deleted. Members keep every version they were given.

A folder key is named by `(spaceId, shareId, keyVersion, class)`, where `class` is `draft` or `published`. There is no separate key ID. Clients store, look up and compare folder keys and key versions only under the full `(spaceId, shareId, …)`, never by `shareId` alone. Key wraps and folder key envelopes name the version by `shareId` and `keyVersion` (sections 6.3 and 6.4), and the class follows from what is wrapped:

| What is wrapped | Audience class | Folder key |
|---|---|---|
| a revision with `audience = "draft"` | `draft` | draft key |
| a revision with `audience = "published"` | `published` | published key |
| a metadata version (a folder's or the space's name) | `metadata` | published key |

Readers hold only published keys, so they read published versions and folder names. Drafts, and every title inside a draft, need the draft key.

### 6.3 Key wraps

Inside a share, a record's content key is wrapped with a folder key instead of sealed to each reader. Every record in a share has exactly one current wrap.

```
KeyWrap = { shareId: ID, keyVersion: integer ≥ 1, wrappedKey: Sealed }

ad         = canonical('content-key-wrap/v1', [installationId, spaceId, shareId, keyVersion,
                                               audienceClass, subjectKind, subjectId, versionId])
wrappedKey = XChaCha20-Poly1305(folderKey, random 24-byte nonce, contentKey (32 bytes), ad)
```

- `audienceClass` is the record's `audience` for a revision, and `"metadata"` for a metadata version (section 6.2).
- `subjectKind` is `"page"` for a revision, and the record's `subjectKind` (`"space"` or `"folder"`) for a metadata version.
- `subjectId` is the record's `pageId` or `subjectId`. `versionId` is its `revisionId` or `metadataRevisionId`.
- `folderKey` is the key of that class at `(spaceId, shareId, keyVersion)`.
- `wrappedKey.ciphertext` is exactly 48 bytes. Anything else is `malformed`.

The AD binds the wrap to one record version in one share, key version and class, so it can't be moved to another record, share or audience. **A wrap isn't signed.** Nobody without the folder key can make one that opens. A member with the key who makes a wrap that opens to some other key only causes `key-commitment` (section 5.7). Leaving wraps out of the signed record is what lets an owner rewrap content after a move (section 10) or when a share is made (section 6.7).

**Opening.** The client takes the record and its wrap, runs steps 1 to 4 of section 5.1, and then:
1. It holds the folder key of the record's class at the record's `spaceId` and the wrap's `shareId` and `keyVersion`, from a verified folder key envelope (section 6.4). Otherwise `missing-key`.
2. The wrap opens under that key and the AD (`decrypt-failed`).
3. The key matches the record's `keyCommitment` (`key-commitment`). A v1 record has none; it is accepted only from an accepted owner (section 5.7).
4. The payload decrypts and parses.

### 6.4 Folder key envelopes

A folder key envelope gives one person or agent one key version of one share.

```
FolderKeyEnvelope = { spaceId, shareId, keyVersion, recipientId, recipientKeyVersion,
                      draftKey: base64url | null, publishedKey: base64url,
                      sealerId, sealerKeyVersion, signature }

draftKey     = base64url(crypto_box_seal(draft key, recipient.boxPublicKey))       // 80 bytes, or null
publishedKey = base64url(crypto_box_seal(published key, recipient.boxPublicKey))   // 80 bytes
signature    = Ed25519(sealer, canonical('folder-key-envelope/v1', [installationId, spaceId, shareId,
               keyVersion, recipientId, recipientKeyVersion, draftKey (bytes) | null,
               publishedKey (bytes), sealerId, sealerKeyVersion]))
```

- There is at most one envelope per `(spaceId, shareId, keyVersion, recipientId, recipientKeyVersion)`. A later one replaces it, as when a reader becomes an editor (section 7.4).
- **The role class is signed.** The `draftKey` property is always present: `null` for a reader, and a sealed key for an editor, a publisher or an owner. An envelope without it is `malformed`. Sealed boxes can't carry AD, so the signature over the sealed bytes is what binds each key to its share, version, class and recipient.
- **Sealer.** For a human recipient, the sealer is an owner of the space. For an agent recipient, it is the agent's own person (section 9.4).

**Opening** (the recipient's client):
1. The envelope parses strictly, names the space and share asked for (`binding-mismatch`), and names this identity at its current key version (`wrong-recipient`).
2. **The sealer is trusted.** For a human, the sealer is an accepted owner of the space (section 6.5). For an agent, it is the person pinned at enrollment (section 9.3). The sealer's key passes section 8.4. Otherwise the client refuses (`untrusted-sealer`) and reports a possible attack.
3. The signature verifies (`bad-signature`).
4. Both sealed keys open (`decrypt-failed`).

**Server checks when an envelope is uploaded:** the sealer is the caller, at its current key version, and is an owner of the space, or, for an agent recipient, that agent's person; the signature verifies; the recipient is the share's member at its current key version, an owner, or an agent with a grant in the share; and `draftKey` is `null` exactly when the recipient's role there is reader.

**Serving.** The server serves each member and agent only the envelopes addressed to them, and serves a person the envelopes they sealed to their own agents. An owner of the space can also fetch **every** envelope of one version of one of its shares, to people and agents, at every recipient key version. A rotation (section 7.5) and a move preview (section 10) need that.

### 6.5 Accepted owners

Owners hold every key of every share in their space, and are the readers of the owner region (section 6.6). The server keeps the owner list, but an app never accepts an owner because the server lists them. Each person's app keeps, per space, the owners it has **accepted** and the owners it has **removed**, in its contacts record (`spaceOwners`, section 8.2).

**The rule.** The app of identity `I` works out the accepted owners of space `s` like this:

1. **Itself.** It accepts `I` if it authored the space's first name record: a metadata record of `s` with `subjectKind: "space"`, `basedOn: null` and `authorId = I`, whose signature verifies under `I`'s current key. This covers the creator of a new space and the owner of every Milestone 1 space.
2. **First sight.** Otherwise, if it has accepted no owner of `s` yet, it accepts the human signer of the first item that verifies and names `I` at its current key version, taking the space's owner statements first, in the order the server serves them, and then the folder key envelopes addressed to `I` in the space, ordered by `shareId` (compared as bytes) and then `keyVersion`. This is decided once per space, not per share, and is trust on first sight (A4). Shared with me names this owner as the person who shared (section 7.7). **If the server lists `I` as an owner of `s`,** as for a new co-owner, or a Milestone 1 owner whose name record the server withholds, the app doesn't accept anyone automatically: it takes only owner statements, and accepts their signer only once the person confirms the co-owner dialog naming that signer (below). If the person declines, it accepts nobody and refuses owner actions in the space (`unaccepted-owner`).
3. **Statements.** It accepts every owner named in an owner statement signed by an owner it already accepts, and repeats until nothing more is accepted.
4. **Removed owners.** It never accepts an owner on its removed-owners list for `s`, in step 2 or 3, and statements they signed don't count in step 3. An owner leaves the list only when this person adds them as a co-owner again (section 7.6).
5. It records each newly accepted owner, as `{id, keyHash}`, in its contacts record (section 8.6).

**Using the result.**
- **Opening** (folder key envelopes, v2 envelopes, v1 records): the app accepts any owner it has ever accepted for `s`, at the key it accepted, whether or not the server still lists them and whether or not it removed them. So history stays readable after an owner is removed or the space is transferred.
- **Writing** (choosing the key version to write under, section 6.8): a key version counts when its envelope was sealed by an owner the app has accepted for `s`, at a key it accepted for them, who isn't on its removed-owners list. Whether the server still lists that owner doesn't matter, so the versions an owner made before leaving stay usable (section 7.6). **The writing set covers every use of a key version other than reading through it:** writing or rewrapping under it (sections 6.8, 10 and 13), rotating from it, including verifying its envelopes and taking people from them (sections 7.5 and 10), sealing it to an agent (section 9.4), and the **No going back** mark (section 6.8). A version that doesn't count for writing is only read through.
- **Sealing** (owner-region envelopes, version 1 of a new share, a rotation) uses only the **sealing owners**: accepted owners whose ID the server currently lists as an owner of `s`, and who aren't on the removed-owners list. The app seals to each at the key the server lists, which must be one it accepted for them. If the server lists an owner who isn't a sealing owner, or lists one at a key the app hasn't accepted, the app refuses to seal (`unaccepted-owner`) and names them. Adding a co-owner also seals to the co-owner being added, who isn't listed until the upload succeeds, at the key the person chose (section 7.6).

**Owner statements:**

```
OwnerStatement = { installationId, spaceId, owner: { id, keyVersion, keyHash },
                   signerId, signerKeyVersion, signature }

signature = Ed25519(signer, canonical('space-owner/v1', [installationId, spaceId, owner.id,
            owner.keyVersion, owner.keyHash, signerId, signerKeyVersion]))
```

- **Statements are signed only when adding a co-owner** (section 7.6), which a transfer starts with. The adder's app signs one naming the new owner. The new owner's app, the first time it opens the space as an owner, names the adder by label in a dialog ("<label> added you as an owner of <space>"), and once the person confirms, signs one naming the adder, before any other owner action there, even if the adder has left since. **The adder** is the signer of the first statement naming this identity at its current key version, in the order of step 2, that the app can accept: by first sight (step 2), or through an owner it already accepts (step 3). If the person declines, the app signs nothing, accepts no owner through that statement, and takes no owner action in the space. So every owner but the creator names, and is named by, the owner who added them, and an app that accepts any one owner reaches the others. Nothing is signed at unlock.
- The named owner MUST be a human (`kind: "human"`). A statement naming an agent is `malformed`.
- A statement counts in step 3 when the reference resolves (section 4.4) and passes section 8.4, and the signature verifies under the signer's accepted key.
- A statement binds a key version. An owner whose key version changes is accepted again only when an owner re-adds them (section 7.6).
- The server stores the statements and serves all of a space's statements to its owners and members.
- **Removal isn't signed.** A removed owner's statements stay valid. Removing another owner adds them to the remover's removed-owners list (section 7.6), so the remover's app neither seals to them nor uses a version they sealed for anything but reading, unless its person adds them again. Other apps stop sealing to them once the server stops listing them, and still write under versions they sealed; a server can use that to keep the removed owner in use there (A5).

### 6.6 The owner region

Content in the owner region is sealed to each owner, as Milestone 1 sealed it to its one owner:
- Every new record is v2 (section 5.7), with one v2 envelope (section 5.8) per owner, at the owner's current key version. **The author's app takes the recipients from its sealing owners (section 6.5), never from the server's list.** If the server lists an owner who isn't a sealing owner, the app refuses to save (`unaccepted-owner`) and names them. The server refuses a write whose envelopes don't go to exactly its current owners.
- Agents never hold keys in the owner region. Granting an agent a folder there first makes it a share (section 9.4).
- When an owner is removed, later saves leave them out. What they could read before stays readable to them (A3).

### 6.7 Making a share

When an owner first shares a folder `F`, or the space, or a person first grants their agent a folder in a space they own, the owner's client moves the subtree's content from the owner region into the new share:

1. **Preview.** It lists the folders and pages under `F` by decrypted name, and who will hold the keys. The tree is the server's, so this is where the owner can notice a page that shouldn't be there. Nothing is wrapped or sealed before the owner confirms.
2. **Keys.** It makes `shareId` and key version 1.
3. **Wrap.** For every retained revision and metadata version in the subtree (and the space's name, for a space share, but never a group's name), it opens the content key through its own v1 or v2 envelope, checks it against the record, and writes a key wrap under version 1, with the record's class. That means every retained draft, not only the head: new members receive the share's retained history (section 7.3).
4. **Seal.** It seals version 1 to every sealing owner (section 6.5), and to the people or agent being added (sections 7.3 and 9.4).
5. **Upload.** It sends the share, the wraps and the envelopes together, with any groups it is shared with (section 7.8). Under a lock on the space, the server checks the nesting rule (section 6.1), that every record in the subtree has exactly one wrap under version 1 and that the envelopes cover every current owner, every new member and each agent in `agentGrants`, and go to no one else but the groups' members, by their effective role. It then makes `F` a share root, deletes the owner-region envelopes of the subtree's records, adds the members, and bumps the space's permission version. A write prepared against the old region fails. If anything fails, nothing changes.

### 6.8 Saves and the key version check

**What a save carries.** A write of a record (a draft save, a publish, a restore, a rename, a new page or folder, and every rewrap) carries the key material of its region:
- in a share: exactly one key wrap, and no envelopes;
- in the owner region: v2 envelopes to the owners (section 6.6), and no wrap.

**The key version check.** For a write in share `S`, the server takes a lock on `S`'s row, and refuses the write (`key-version`) unless the wrap's `shareId` is `S` and its `keyVersion` is `S.currentKeyVersion`. A rotation takes the same lock, so no write lands under a version older than the one current when it is stored. On `key-version`, the client fetches its new envelopes, wraps the same content key under the new version, and sends the write again. Nothing is re-encrypted.

**Clients.** A person's client wraps every new record under the highest key version it holds for the share whose envelope was sealed by an accepted owner it hasn't removed (section 6.5, **Writing**). An agent uses the highest version its person sealed to it. A server that hides a newer version can keep a writer on an older one (A2).

**No going back.** A client never writes under, rotates from, or moves content into a key version below the highest version it has opened for that share that counts for writing (section 6.5, **Writing**). If the server's `currentKeyVersion` is lower than that, the client refuses (`key-version`) and reports a possible attack. The mark is kept per `(spaceId, shareId)`: the CLI, and the desktop app with a trusted keyring, keep it in their local file, next to the contacts mark (section 8.5); the browser, and the desktop app without a keyring, keep it in memory, for one session. So on a CLI device, or a desktop with a trusted keyring, a server can't hide one owner's rotation from another owner whose next rotation would undo a removal; in a later browser session, or desktop launch without a keyring, it can (A2).

**The region doesn't change on its own.** The client takes every write's region from section 6.1: a new node's from its parent's name record, a `basedOn: null` write on an existing page from that page's current record, and any other write's from its `basedOn` record. If the server's tree and shares put the node in another region, the client refuses (`region-mismatch`) and reports it. Content changes region only through a move or a new share, which rewrap the whole history (sections 6.7 and 10). So a server that relabels the tree can't make an owner's next edit, or a new page or folder, land in a share. The interface shows a page's region from the same data the client wraps under.

**Permission versions** stay as built. Every write names the permission version it was prepared at, and the server refuses a mismatch (`permission-version`). Making a share, a member or role change, a rotation, a move and an owner change bump it.

---

## 7. Sharing

### 7.1 Roles

Owners are owners of the whole space. Everyone else is a member of one or more shares, with one role in each.

| Role | Keys it holds | What the server lets it do |
|---|---|---|
| reader | the published key of every version of the share | read published versions, published history and folder names in the share |
| editor | the draft and published keys of every version | also read drafts and draft history, save drafts, create pages and folders, rename folders in the share, attach, and restore |
| editor with publish | the same as an editor | also publish and unpublish |
| owner | every key of every share in the space, and the owner region | everything, and share, remove, change roles, rotate keys, move across shares, add and remove owners, and rename the space |

The server enforces roles on every request, counting a member's current role in the share whose subtree holds the node (their effective role, section 7.8), and an agent's cap (section 9.5). Clients don't check roles; only keys bind them (A1). The server's state: shares, members and roles, owners, agent grants, owner statements, folder key envelopes and key wraps.

### 7.2 Who seals, and when

Folder keys are sealed only in these cases. **A save never seals a folder key.**

| Action | Who | What is sealed | To whom |
|---|---|---|---|
| Share: make a share, or add a member (7.3) | an owner | every key version of the share; draft keys only to editors and owners | the people shown in the dialog, and for a new share every sealing owner |
| Change a reader to an editor (7.4) | an owner | the draft key of every version | that member |
| Remove someone, or rotate keys (7.5) | an owner | a new key version | the remaining people of section 7.5, as shown in the dialog |
| Add a co-owner (7.6) | an owner | every version of every share in the space, and the owner region's content keys | the new owner |
| Share with a group, or raise its access (7.8) | an owner | every key version of the share, by role | the group's members whose keys fall short, as shown |
| Add someone to a group (7.8) | an owner | every key version of each of the group's shares where they lack keys | the person being added |
| Give access (7.9) | an owner | every key version of the shares they wait in, at their current key | a waiting person the owner confirms |
| Grant an agent folders (9.4) | the agent's person | the versions that person holds of the chosen shares | their own agent |
| Unlock (9.4) | a person's app | newer versions of shares the agent was granted | their own agents, from their own contacts record |

**People shown.** Every dialog names each person by the label pinned for them (section 8.2), with the key-change warning where it applies (section 8.4). The app seals only to the people the owner confirms, using keys that pass section 8.4. A person whose key change is unconfirmed is left out, and the dialog says why. Owners are always included and never shown as a choice.

### 7.3 Sharing with a person

1. **Find the person.** The owner picks them from the server's list of people, or types an email. The list holds every account with a vault but the caller's, each at its identity with its name and email, and, by name and email only, the accounts that have confirmed their email but have no vault yet, which can't be picked. The people lookup takes an exact, normalized email (section 3.2) and returns the identity of the account with that email, if it has a vault, and nothing for partial matches. Both are for people with a vault only, and rate-limited. A person picked from the list counts as found by the email the list shows for them. The app checks the result against its pins (section 8.4), and pins a person seen for the first time with that email (section 8.3).
2. **Choose a role:** reader, editor, or editor with publish.
3. **Preview.** The dialog shows the person, the role, and what they will receive: for a reader, every published version the share has kept; for an editor, also every retained draft. If the folder isn't a share yet, it also lists the subtree (section 6.7, step 1).
4. **Seal.** The owner's app seals every key version, `1` to current, to the person: both keys for an editor, the published key only for a reader.
5. **Upload.** The envelopes and the member go in one request. The server adds the member only if their envelopes cover every version, with the class their role needs, so nobody is ever a direct member without their keys. Someone a group brings in may wait (section 7.9).

**Who sees whom.** Everyone with a vault sees the name and email of everyone else on the server. The lookup alone, by exact email, kept anyone from listing the accounts, but picking from a list is much easier on a server where people know each other, so the list is a deliberate choice. People who aren't signed in learn no more than before: invitations, open registration and email change still don't show whether an address has an account.

The request sets the member's **direct grant** (section 7.8). Envelopes are needed only where the keys the member holds fall short of their effective access, and then with the class it needs. A grant lowered below the keys they hold is a rotation (section 7.4), refused here; one lowered while a group keeps their access changes no keys. A request at a new key for someone there only through groups that repeats the role and publish right their member row shows, as an app from before groups sends to share again after a key change, leaves them without a direct grant.

**A member whose key changed** holds no envelopes for their new key version, and waits (section 7.9). Once an owner confirms the change (section 8.4), **Give access** seals everything they reach, directly and through groups, at the new key in one request. It replaces the key version of their member rows, and the server deletes their envelopes for the old key version. Sharing again by the steps above still does the same for one share.

Adding an agent to a share is the person's own action, never an owner's (section 9.4).

### 7.4 Changing a role

- **Reader to editor.** The owner's app seals each version again, now with its draft key, and these envelopes replace the reader's ones.
- **Editor to reader.** This is a rotation (section 7.5) in which the dialog sets that person's role to reader. Their envelope for `v + 1` has the published key only, the request names them in `demoted`, and the server sets their role to reader in the same step. Everyone else's role comes from their own envelope, as in every rotation. They keep the draft keys they had (A3).
- **Publish rights** on or off change no keys. Only the server enforces them (A1).

### 7.5 Removal and key rotation

**Removing person `P` from share `S`:**

1. The owner's app fetches `S`'s current version `v`, its members, and **every** envelope of version `v` (section 6.4). It refuses if `v` doesn't count for writing, or is below the highest version it has opened for `S` that does (`key-version`, section 6.8). The only exception is a rotation that removes an owner (section 7.6, step 2). It verifies each envelope to a human: sealed by an owner in its writing set (section 6.5, **Writing**), signature valid. Envelopes to agents add nobody to `E`, so it skips them.
2. It works out the **remaining people**:

   ```
   remaining = ((E ∩ M) ∪ O) − X

   E = the human recipients of the version v envelopes it verified
   M = the share's members as the server lists them
   O = the sealing owners of the space (section 6.5), less any owner this action removes
   X = P, and any member the owner leaves out
   ```

   The dialog shows each remaining person, with their role taken from their own version `v` envelope (a reader's has a `null` `draftKey`), or from the dialog for a person being demoted (section 7.4). A listed member with no verified envelope, or whose key change isn't confirmed (section 8.4), can't be sealed to, so the dialog shows them as left out and puts them in `X`. If the server lists an owner who isn't a sealing owner, or lists one at a key the app hasn't accepted, the app stops (`unaccepted-owner`) and names them. Owners are never left out, so no owner is stranded without the new version: an owner whose key changed is re-added first (section 7.6).
3. The app makes version `v + 1`, and seals it to each remaining person, by role.
4. It sends `{expectedKeyVersion: v, removed, demoted, envelopes}`. `removed` holds the identity IDs of every listed member in `X`, so the server never waits on someone the app left out; `demoted` holds the identity IDs of members becoming readers. Under the lock on `S`, the server checks that the current version is `v` (`stale-head` otherwise), and that the envelopes go to exactly the members it lists minus `removed`, plus every owner, each at their current key version, with `draftKey` `null` exactly for readers after `demoted` is applied. It then removes the people in `removed`, ends the grants of their agents in `S`, applies `demoted`, sets `currentKeyVersion = v + 1`, and bumps the permission versions.
5. Agents of the remaining people get `v + 1` from their own person's app at its next unlock (section 9.4). Until then they can read but can't save in `S`.

Because the recipients of `v + 1` are drawn from verified `v` envelopes and the sealing owners, a server can't slip a new person into a rotation. If another owner rotated first, the app gets `stale-head`, fetches again, and asks the owner again if the remaining people changed.

**Rotate keys** without removing anyone is the same flow with `X` empty. Owners use it after an agent that held the share's keys is revoked (section 9.7).

**Remove from every folder in this space.** One owner action removes `P` from every share in the space where `P` is a member, rotating each, in one dialog that lists each share's remaining people. It also takes `P` out of every group in the space, in the same request: `POST /api/spaces/:spaceId/members/:identityId/remove {rotations, permissionVersion}`, with one rotation for each share where `P` holds keys, checked as in section 7.9. If `P` is an owner, the app removes `P` as an owner instead (section 7.6).

**What the removed person keeps.** Every key version up to `v`, and so everything wrapped under them: what they downloaded, and what a server still serves them (A3). The same holds for their agents. Nothing wrapped under `v + 1` or later reaches them, because the server refuses saves under `v` (section 6.8). A server that accepts such saves anyway, or hides `v + 1` from a writer, is A2.

### 7.6 Co-owners and transfer

**Adding co-owner `Q`** (an owner action; `Q` must be a human with a vault, found as in section 7.3):

1. The owner's app seals every version of every share in the space to `Q`, with both keys.
2. For every retained revision and metadata version in the owner region, it seals the content key to `Q` in a v2 envelope it grants (section 5.8).
3. It signs an owner statement naming `Q` (section 6.5).
4. It uploads all of this in one request. The server adds `Q` as an owner only when the envelopes cover every share version and every owner-region record. `Q` stops being a member of the space's shares, and leaves its groups (section 7.8).

Before the upload, the adder's app records `Q` as accepted, at the key it sealed to, in a contacts write (section 8.6). If `Q` is on the space's `removedOwners`, that write takes them off it; adding someone again is the only way off the list.

`Q`'s app then accepts the adder through the co-owner dialog, or through the statement chain if it already accepted an owner of the space (section 6.5). The first time it opens the space as an owner, it names the adder by label and, once `Q` confirms, signs an owner statement naming them, even if the adder has left since.

**Re-adding an owner whose key changed** is the same flow, run after confirming the change (section 8.4). It seals everything to the new key version and signs a statement for it.

**Removing owner `R`.** Any owner can remove `R`, including themself. The server refuses to remove the last owner (`last-owner`), so a space always keeps one. The removing owner's app:
1. if `R` is another owner, adds `R`'s ID to the space's `removedOwners` in a confirmed contacts write (sections 8.2 and 8.6). That app doesn't accept `R` again for the space unless its person adds them again;
2. rotates every share in the space as in section 7.5, with `R` in `X` and left out of `O`. In these rotations only, envelopes `R` sealed count as if `R` were in the writing set: a current version `v` that `R` sealed counts for step 1's writing check, and `R`'s envelopes count when the app verifies `v` (section 7.5, step 1). They don't move the **No going back** mark (section 6.8). `R` is still a listed owner, who could seal them, and otherwise a share that `R` rotated last couldn't be rotated away from `R`. This exception is only for the owner who removes `R`, in these rotations;
3. sends `{rotations: [{shareId, expectedKeyVersion, removed, demoted, envelopes}]}` in one request. The server removes `R` as an owner, ends the grants of `R`'s agents in the space, and applies every rotation at once, and refuses unless there is one rotation for each share in the space and each one's envelopes go to exactly its members minus `removed`, plus every owner but `R`.

**If the request fails** after step 1, the server still lists `R`, who is now on the app's `removedOwners`, so the app refuses other owner actions in the space (`unaccepted-owner`) and offers only to retry the removal. A retry repeats steps 2 and 3; step 1's contacts change is already there, and writing it again changes nothing (section 8.6).

Nothing in the owner region is rotated: later saves leave `R` out (section 6.6). The other owners and members write under the new versions because they accept the remover, whether or not the remover stays (section 6.5).

**An owner who removes themself made the new versions, and so knows them** until a remaining owner rotates again (section 7.5). Their rotation still matters: it leaves out their agents, which held the old versions, and the server ends those agents' grants.

**Transfer** is one owner's action: the old owner adds the new one, then removes themself. The old owner knows the current versions, as above. The new owner's app then offers Rotate keys for every share, and rotates each one first, as in section 7.5. The old owner isn't on its `removedOwners` yet, so their envelopes count as usual, and the exception in step 2 above doesn't apply. Only after every share's rotation has succeeded does the app add the old owner to its `removedOwners`, in a confirmed contacts write (the "remove an owner" change of section 8.6). If a rotation fails, or the app stops part-way, the old owner isn't listed as removed yet: the offer stays pending, the app shows it again, and a retry rotates every share whose current version the new owner didn't seal, from that version. After the write, the new owner's app uses a version the old owner seals only for reading.

### 7.7 Shared with me, and ancestor names

- **Shared with me** lists every share in which the person is a member and not an owner. Each item shows the share root's name, decrypted with the share's published key (the space's name, for a space share), and the person who shared it, by label: the owner the app accepted first for that space (section 6.5, step 2). An agent's list (`wikistow spaces list`) names each share by the folder it was picked at, which may be inside the share; only the server keeps an agent's picks (section 9.4), so the app takes that folder from the name record the server serves (A1).
- **Members never receive ancestor names.** The names of the folders above a share root are in the owner region or in no share at all, so no member holds a key for them.
- **The server withholds the rest.** It never serves a member the IDs, metadata or records of nodes outside their shares, ancestors included, nor any other share's wraps or envelopes. A path in Shared with me starts at the share root.

### 7.8 Groups

A **group** is a named set of people in one space, and their agents, that a share goes to as one. Only the space's current owners make, rename, fill and delete groups, and only they are served anything about them. Owners aren't members: they hold every key already, and a person added as a co-owner leaves the space's groups (section 7.6). A group holds no keys. Folder keys are still sealed to each person, by an owner's app, from that app's pins.

```
Group       = { groupId: ID, spaceId }                  // the ID is made by the owner's client
member      = { groupId, identityId }                    // a person, or an agent for its person
share group = { shareId, groupId, role: "reader" | "editor", canPublish }
```

**Nothing new is signed.** A membership isn't signed: it is only the owners' instruction about whom to seal to. Who holds a share's keys is still fixed by the signed folder key envelopes (section 6.4), and an owner's app seals only to people it shows by their pinned labels and the owner confirms (section 7.2). A server that adds someone to a group can at most put a stranger in an owner's dialog, as it can put one in a share's member list.

**The group name record.** A group's name is a metadata record v2 (sections 5.4 and 5.7) with `subjectKind: "group"` and `subjectId` the group ID, holding the node metadata payload (section 5.5; `emoji` and `tint` unused). It is always in the space's owner region (section 6.6): v2 envelopes to exactly the space's current owners, and never a wrap. The first version has `basedOn: null`; a rename is a new version based on the current one, as for a folder. The server refuses a group name with a wrap, or any other key material than envelopes to exactly its current owners, and a write of one through the space and folder metadata route. A space share never wraps it (section 6.7), and a new co-owner gets an envelope for it like every owner-region record (section 7.6, step 2). Members never receive a group's name or members. Deleting a group deletes its name versions.

**Effective access.** A person's access in a share is the highest of their **direct grant** there and the access of each group they are in that has the share, in the order reader, editor, editor with publish. There are no exceptions or denials: to take someone out of a share they reach through a group, remove them from the group, or the group from the share.

The server keeps one member row per person holding the share's keys, and enforces only that row. Its `role` is the class of the keys they hold (their envelope of the current version), which is their effective role unless they wait for draft keys (section 7.9); its publish right is their effective one, for an editor. Two more columns keep the direct grant, null for someone there only through groups. Every change to a direct grant, a group's access, its members or its shares recomputes the rows it touches, in the same transaction and under the lock on the space, so access checks, rotations and envelope checks read the rows and a group is never expanded at request time.

**Requests.** All are for owners of the space. Each change to who has access names the permission version of the space, or for a change to one share, of its root (section 6.8), and bumps them. Making and renaming a group change no access, and carry none: a rename is checked against the name's current version instead.

| Request | What the server does |
|---|---|
| `GET /api/spaces/:spaceId/groups` | Lists each group's name, as an owner-region record with the caller's envelopes, its members at their current keys, its agents with whether their person confirmed it, and its shares with their access; every direct grant in the space's shares; the live agents of the space's owners and of the people in its groups, each with its person and the server's name for it; and the space's permission version. The share listing (section 7.5) is unchanged, since older apps read it strictly. |
| `POST /api/spaces/:spaceId/groups {groupId, metadata, envelopes}` | Makes an empty group with its first name version. |
| `POST /api/groups/:groupId/name {metadata, envelopes}` | Renames it. |
| `POST /api/groups/:groupId/members {identityId, keyVersion, envelopes}` | Adds a person at their current key, not an owner. The envelopes must give them every version of exactly the group's shares where the keys they hold fall short of their new access (section 7.9). |
| `POST /api/groups/:groupId/agents {agentId}` | Adds an agent, for its person, who must be in the group or an owner of the space. Nothing is sealed: it gets nothing until its person confirms (section 9.4). |
| `POST /api/groups/:groupId/members/:identityId/remove {rotations}` | Takes a person or an agent out, with the rotations section 7.9 requires. A person's agents leave with them. |
| `PUT /api/shares/:shareId/groups/:groupId {access, envelopes, rotation}` | Shares the share with the group, or changes its access. Raising it carries envelopes; lowering it a rotation, as section 7.9 requires. Publish rights alone carry neither. |
| `POST /api/shares/:shareId/groups/:groupId/remove {rotation}` | Takes the group out of the share. |
| `POST /api/groups/:groupId/delete {rotations}` | Takes the group out of every share it has, then deletes it. |
| `POST /api/shares/:shareId/members/:identityId/direct/remove {rotation}` | Drops someone's direct grant, keeping what their groups give them. |
| `POST /api/spaces/:spaceId/members/:identityId/remove {rotations}` | Remove from every folder in this space (section 7.5). |
| `GET /api/me/waiting`, `POST /api/spaces/:spaceId/members/:identityId/give-access {keyVersion, envelopes}` | Waiting people, and giving them access (section 7.9). |

Making a share (section 6.7) takes `groups: [{groupId, role, canPublish}]` too. Adding a member (section 7.3) sets their direct grant.

The audit log records `group.created`, `group.deleted`, `group.member-added`, `group.member-removed`, `share.group-added`, `share.group-changed` and `share.group-removed`, and a person's `agent.group-confirmed` and `agent.group-left`, with IDs and roles only, never names. Each rotation a group change makes records `share.rotated`, naming the group.

### 7.9 Waiting, and the server's checks

**Waiting.** Only an owner's app seals, so someone a group brings into a share can be without keys: a member whose changed key nobody has confirmed, a member left out of a rotation because their envelope didn't verify, a member the owner's app didn't seal to, or an agent its person hasn't confirmed. They **wait**: their effective access needs keys they don't hold at their current identity key. Until an owner's app seals to them, someone with no member row for that share is served nothing from it, Shared with me doesn't list it, and nothing tells them it exists. Folders they already hold stay as they were: someone waiting only for draft keys keeps reading as a reader, and a member whose key changed keeps their row at the old key, as before groups, so the share stays listed but their new key opens none of it.

`GET /api/me/waiting` lists, for every space the caller owns, each share where someone waits: the person at their current key, the role and publish right their access needs, and what they hold there now: nothing, keys of a role at an older identity key version (their key changed), or a reader's keys at their current key (they wait only for draft keys). The list is the server's, so it isn't trusted: after unlocking, the owner's app shows waiting people by their pinned labels, with the key-change warning where it applies (section 8.4), and **Give access** seals only once the owner confirms. It never seals by itself, since membership isn't signed.

**The sealing check.** A request that gives access (adding a member, adding someone to a group, sharing with a group or raising its access, making a share with groups, giving access) may carry envelopes only for people whose keys at their current identity key fall short of their effective access after the change, and adding a member may also seal again to that member. Each of them gets either every key version of the share at that key, with `draftKey` exactly for an editor, or nothing. The server refuses anything else as `recipients-mismatch`. Adding a direct member, or a person to a group, must cover every share where they fall short. Elsewhere, people left out wait. Envelopes given replace the person's envelopes in that share, and their member row takes the new key version and role.

**The coverage check.** A request that takes access away (removing someone from a group, a group from a share, lowering a group's access, deleting a group, dropping a direct grant, removing someone from every folder) carries rotations, each as in section 7.5, step 4. Under the lock on the space, the server works out every member's effective access after the change, and refuses (`stale-head`) unless the rotations cover exactly the shares where some member's keys exceed it, or that an agent reached through a pick or a confirmed group before the change and no longer does, one each, and each leaves those members out, or, for one who keeps reading, leaves them out or demotes them. A rotation leaves agents out by itself, since only their person seals to them. Where nobody's keys exceed their new access, nothing is rotated. Where only publish rights go, the server drops them. A member whose role is unchanged, such as a direct editor leaving a group that made them an editor, keeps their keys and their row. The server applies every rotation at once with the change, or nothing. Demoting someone (section 7.4) also lowers their direct grant to reader. Someone removed or demoted who keeps more through a group waits.

For each share that rotates, the owner's app works out the person's effective access without the change, from the server's listing of direct grants and groups, and plans the rotation as in section 7.5 with them in `X`, or demoted. It works out which agents reach each share before and after the change from the share listing's picks and the groups' confirmed agents. The rest of the request, and anyone the app leaves out, follow the usual rotation rules.

---

## 8. Pinned keys and the key-change warning

Each person's app records the first key it sees for each person, and warns when that key changes. There are no safety codes. Pins live in the person's contacts record, which PR #29 added; this section keeps its format and changes its payloads.

### 8.1 Contacts record

Each person's pins, labels, agents and accepted owners live in one encrypted, self-signed record on the server. It syncs across devices. The person's enrolled agents can read the shared part, but not the private part. **Nothing goes in browser storage.**

```
SealedContacts = {
  record: { protocol: 1, installationId, ownerId, ownerKeyVersion,
            version: integer ≥ 1, prevHash: Hash32 | null, payloadHash: Hash32,
            keyCommitment: Hash32, privatePayloadHash: Hash32, privateKeyCommitment: Hash32 },
  signature:  base64url,
  payload:    Sealed,                                          // shared part, under contentKey
  keys:       [ { recipientId, recipientKeyVersion, sealedKey } ],   // contentKey, sealed per reader
  private:    Sealed,                                          // private part, under privateKey
  privateKey: base64url                                        // privateKey sealed to the owner only
}

signed bytes         = canonical('contacts/v1', [protocol, installationId, ownerId, ownerKeyVersion,
                       version, prevHash, payloadHash, keyCommitment, privatePayloadHash,
                       privateKeyCommitment])
contactsHash         = base64url(BLAKE2b-256(signed bytes))

ad                   = canonical('contacts-payload/v1', [installationId, ownerId, ownerKeyVersion, version])
payloadHash          = base64url(BLAKE2b-256(payload.nonce ‖ payload.ciphertext))
keyCommitment        = base64url(BLAKE2b-256(canonical('content-key-commit/v1', [contentKey (bytes)])))

privateAd            = canonical('contacts-private-payload/v1', [installationId, ownerId, ownerKeyVersion, version])
privatePayloadHash   = base64url(BLAKE2b-256(private.nonce ‖ private.ciphertext))
privateKeyCommitment = base64url(BLAKE2b-256(canonical('content-key-commit/v1', [privateKey (bytes)])))
privateKey (field)   = base64url(crypto_box_seal(privateKey, owner.boxPublicKey))   // 80 bytes
```

- `version 1` has `prevHash = null`. Each later version has `version = previous + 1` and `prevHash = contactsHash(previous)`.
- Each version uses two fresh 32-byte keys: `contentKey` for the shared payload, and `privateKey` for the private payload.
- **`contentKey` is sealed to the owner, and to each agent listed in the shared payload's `agents` whose `enrollment` verifies under the owner's key and which isn't in `revokedAgents`.** The writer builds this set from the payload it is writing, never from a list the server gives it.
- **`privateKey` is sealed only to the owner.**
- `keys` entries and `privateKey` aren't signed. The signed key commitments make a swapped key fail to open (`key-commitment`) rather than decrypt to other content.

### 8.2 Payloads

**Shared payload**, readable by the person and their listed agents:

```
{
  format: { major: 1, minor: 0 },
  contacts:      [ { identity: PublicIdentity, verifiedAt: Timestamp, method: "first-seen" | "confirmed" } ],
  removed:       [ { id, keyHash, removedAt: Timestamp } ],
  agents:        [ { enrollment: AgentEnrollment, label: { name: string, enrolledAt: Timestamp },
                     shares: [ { spaceId, shareId, drafts: boolean } ],
                     groups: [ { spaceId, groupId, drafts: boolean } ] } ],
  revokedAgents: [ { agentId, revokedAt: Timestamp } ],
  spaceOwners:   [ { spaceId, owners: [ { id, keyHash } ], removedOwners: [ HumanId ] } ],
  extensions:    { }
}
```

**Private payload**, readable by the person only:

```
{
  format: { major: 1, minor: 0 },
  labels:     [ { id, keyHash, name: string, email: string } ],
  extensions: { }
}
```

- **`contacts` are the pins**, humans only, one per identity ID. `verifiedAt` is when the key was pinned. `method` is `"first-seen"` for a key pinned the first time it was seen (section 8.3), or `"confirmed"` for a key the person accepted after a key-change warning (section 8.4).
- **`labels`** name the pins. Each pin has exactly one label, written in the same version, matched by `id` and `keyHash`. `email` is the normalized email the person was found by, or the one the directory showed when the key was first seen. `name` is the directory's display name at that moment, which the person may edit, 1–100 characters under section 3.3, rule 5. Neither is ever updated from later directory text. The interface names a pinned person only by their label, so the server can't swap two people's names. Avatars come from the server, which could swap them, so they are only decoration: the interface never names a person, or lets someone choose one, by an avatar. A pin with no usable label is shown by its fingerprint only, and can't be chosen in a dialog until the person names it.
- **`removed`** holds keys the person stopped trusting: a changed key they declined, or a pin they removed. A removed key is never sealed to, and nothing it signed is accepted.
- **`agents`** holds one entry per agent the person enrolled (section 9.2). `label.name` is the name the person typed at approval, distinct among their agents, never filled in from text the server or the CLI sent. **`shares`** lists the shares the person has granted the agent, and whether the agent gets draft keys there (`drafts`, section 9.4). Their app seals to the agent only versions of these shares, with draft keys only where `drafts` is `true`. **`groups`** (Milestone 5; optional, an empty list when absent) lists the groups the person confirmed for the agent, and whether it gets draft keys through each (section 9.4). The app also seals to the agent the versions it holds of the shares those groups have, by the same rule.
- **`revokedAgents`** lists agents the person revoked. An agent ID is never removed from it. The person's apps never seal to a listed agent: not the contacts key, and not a folder key.
- **`spaceOwners`** holds, per space, the owners the person's app has accepted (section 6.5), by identity ID and key hash, and in `removedOwners` the IDs of owners this person removed (section 7.6), whom their apps don't accept again unless this person adds them back as a co-owner. They are in the shared payload because the person's agents accept v1 records only from accepted owners (section 5.7). A compromised agent host learns which spaces the person belongs to (A7).
- **Uniqueness.** Each list has a key, and two items with one key make the payload `malformed`: `contacts` by identity ID; `labels` by `id`, and by `email`; `agents` by agent ID, and by `label.name`; `spaceOwners` by `spaceId`.
- **Sets.** `removed` (by `keyHash`), `revokedAgents` (by `agentId`), an agent's `shares` (by `{spaceId, shareId}`; two items with one key and different `drafts` make the payload `malformed`) and `groups` (by `{spaceId, groupId}`, the same way), and a space's `owners` (by `{id, keyHash}`) and `removedOwners` (by ID) are sets: writers sort and deduplicate them, and readers ignore order and duplicates.
- Both payloads are loose, have an `extensions` map, and follow the format rules of section 5.5. A writer never writes a payload it would read as `malformed`.
- **`wikistow.plugins`**, in the private payload's `extensions`, holds the library plugins the person approved ([ADR 0002](../docs/adr/0002-plugin-library-and-browser-plugins.md), `plugin-approvals.ts`), so they follow the person to every device and agents can't read them:

  ```
  { plugins: [ { id: PluginId, hash: hex SHA-256 (64 characters), enabled: boolean,
                 access: [ { spaceId, folderId: FolderId | null, access: "read" | "write" } ] } ] }
  ```

  One entry per plugin `id`. `hash` names the approved version in the server's library; a device runs only that version. `access` is the plugin access the person gave: a whole space when `folderId` is null, otherwise that folder and what is under it. The runtime caps it at the approved version's manifest `access`. An entry a client can't parse is skipped when reading and kept when writing, and so are fields it doesn't know, in an entry, a scope or beside `plugins` (section 5.5). Folder and development installs on the desktop keep their approvals in the device's `plugins.json`, not here.

### 8.3 Pinning

A person's app pins a key the first time it uses it: to seal to that person (sections 7.2 and 7.3), to accept a folder key envelope, v2 envelope or owner statement they signed (sections 6.4 and 6.5), or to verify a record they wrote (section 5.1). If it holds no pin for that identity ID and no label for that email, it pins the directory's identity, with `method: "first-seen"`, and a label (section 8.2), in its next contacts write. The keys must pass section 4.1. This is trust on first sight (A4).

Agents and the CLI never write the contacts record. They use their person's pins, and keep first-seen pins of their own in their local file (section 9.3).

### 8.4 Key changes

Before it uses a key, a person's app compares it with its pins:
- **by identity ID:** a pin for that ID has the same `keyVersion` and keys;
- **by email,** when it found the person by email, or picked them from the list of people by the email it shows (section 7.3): the label with that email names the same identity ID and key hash.

Any difference is a **key change**. The directory never changes a row's keys (section 4.1), so a different key at the pinned key version is always a substitution, and a higher key version is a rotation or a substitution. Until the person confirms the change:
- **Sharing stops.** No dialog seals to that person (`identity-key-changed`); it shows them with the warning instead.
- Folder key envelopes, v2 envelopes and owner statements signed with the changed key aren't accepted.
- A record signed at a key version above the pinned one is shown with a "key changed" mark. A record signed at the pinned version with other keys is refused (`identity-key-changed`).

The warning shows the old and new fingerprints (section 4.3), and suggests checking with the person by phone or in person. If the person confirms, the app replaces the pin, with `method: "confirmed"`, and its label's key hash. If they decline, the new key goes into `removed`.

### 8.5 Reading the record

A client accepts a contacts record only if:
- the signature verifies under the owner's own key: the vault identity for a human, or the human pinned at enrollment for an agent (section 9.3);
- `payloadHash` matches the shared ciphertext, and `keyCommitment` matches the unsealed `contentKey` before it decrypts (`key-commitment` otherwise);
- the shared payload decrypts under its AD and parses;
- for the owner: `privatePayloadHash` and `privateKeyCommitment` match the same way, and the private payload decrypts and parses. An agent checks that `privatePayloadHash` is well-formed and skips the rest;
- it meets the client's **mark** for the record.

**Contacts marks.** A client keeps a mark `{version, contactsHash}` for its own record (for an agent, its human's record). A served record with a lower `version` is `contacts-rollback`. One with the same `version` and a different `contactsHash` is `contacts-fork`. One with a higher `version` must chain to the mark: the desktop app and the CLI fetch every version from the mark up (`GET /api/me/contacts?after=n`) and check each signature and `prevHash`. The CLI, and the desktop app with a trusted keyring, keep the mark in a local file; the browser, and the desktop app without a keyring, keep it in memory, for one session. Both errors are reported as possible server attacks. A server that keeps each device on its own branch goes undetected (A2). Each device's settings show the record's `version` and the first 8 characters of its `contactsHash`, so a person comparing two devices can notice.

**After a restore.** An operator restoring an older backup rolls back every record, which these marks and the **No going back** marks (section 6.8) would refuse. `scripts/restore.sh` records the restore, and `GET /api/installation` reports it as `restore: {restoredAt, backupTakenAt}`, or null before any. A client that keeps marks keeps the `restoredAt` it last saw with them. When the server reports another, the client drops its contacts mark and its No going back marks, takes what the server serves now as its new starting point, and tells the person, with the backup's date when known (`unseenRestore`, `restoreNotice`). A client meeting the server for the first time keeps the `restoredAt` and says nothing. The report isn't checked: a server can claim a restore to roll records back, but not silently, since every device that used it says so (A2).

**An invalid own record.** When the client's own record is `contacts-invalid`, the client refuses to seal or sign anything until the person resolves it. It MUST NOT write a version that drops pins, `removed`, `agents`, `revokedAgents` or `spaceOwners`. If the person starts a fresh record, the client seeds it from every list it can still read.

### 8.6 Writing and merging

`PUT /api/me/contacts {expectedVersion, record}` is a compare-and-swap. The server stores the record only if its current version equals `expectedVersion`, the new `version` is `expectedVersion + 1`, `ownerId` is the caller, and the signature is valid. Otherwise it answers `stale-head` with the current record.

On conflict, the client fetches the newer record, verifies it, and **re-applies its own pending changes** on top:

| Change | Applied to the newer record |
|---|---|
| pin `identity` with `label` | No-op if the same ID is pinned to the same keys. **Stop and ask the person** (`contacts-conflict`) if it is pinned to other keys, or another label has the same `email`. Otherwise add both, and drop any `removed` entry with the same `keyHash`. |
| confirm a changed key | Replace that pin and its label's key hash. Stop and ask if the newer record holds a third key for the ID. |
| rename a label, or unpin | Change or remove that pin's label; for an unpin, remove the pin and add a `removed` entry. |
| enroll agent `{enrollment, label, shares}` | Add it unless the same agent ID is there. Stop and ask if another agent has the same label name. |
| rename agent, or change its `shares` or `groups` | Set the field. For `shares` and `groups`, apply the added and removed `{spaceId, shareId}` or `{spaceId, groupId}` items, and the changed `drafts` values, never the whole list. |
| revoke agent | Add it to `revokedAgents` if absent. Never remove an entry. |
| accept an owner | Add `{id, keyHash}` to that space's `owners`, unless the ID is in its `removedOwners`. |
| remove an owner | Add the ID to that space's `removedOwners`. Keep the `owners` entries, which opening still uses (section 6.5). |
| add a co-owner | Remove the ID from that space's `removedOwners`, and add `{id, keyHash}` to its `owners`. |
| approve a library plugin | Set its whole `wikistow.plugins` entry: `hash`, `enabled: true` and `access`, replacing any entry for that ID. |
| update, change access, turn on or off | Set only that field of the plugin's entry. No-op if the newer record has no entry for it: a plugin removed on another device stays removed. |
| remove a library plugin | Drop its entry. |

**`removedOwners` is a union** across devices, as `removed` is for pins: only this person's own "add a co-owner" takes an entry out, as only a pin takes a `removed` entry out. Each change is re-applied on top of the newer record, so when two devices disagree about an owner, or about one field of a plugin's entry, the change written last stands, by the order of the record's versions, never by a clock. Plugin changes never stop to ask.

**Confirmed writes.** Adding an agent to `revokedAgents`, adding a share to an agent's `shares` or a group to its `groups`, or changing their `drafts`, and adding an owner to `removedOwners` are confirmed: the client writes the version, re-reads the record, and goes on only if the served version holds the change (section 9).

**When to write.** Clients write the record when they pin, confirm, decline, rename or unpin a key; enroll, rename, grant, change the role of, or revoke an agent; accept, add or remove an owner; and approve, update, change the access of, turn on or off, or remove a library plugin. The CLI never writes it.

---

## 9. Agents

An agent is a CLI installation, or a chat assistant its person's own app runs (section 9.8), with its own key pair, enrolled by one person. It holds folder keys only from that person, and the server never lets it do more than that person can.

### 9.1 Enrollment states

| State | Entered when | Server holds |
|---|---|---|
| `requested` | The CLI posts its public keys and `pollSecretHash` | keys, `pollSecretHash`, `lookupCodeHash`, `expiresAt`, attempts |
| `claimed` | A person enters the lookup code | + `ownerAccountId`, `ownerId` |
| `cli-confirmed` | The CLI user confirms the enrollment fingerprint | + `confirmedAt` |
| `approved` | The person approves (signed enrollment) | + `AgentEnrollment`, identity row, credential row, sealed token |
| `delivered` | The CLI's next poll collects the token | sealed token deleted |
| `expired` / `cancelled` / `rejected` | Timeout, cancel by either side, or "Don't match" | — |

`expiresAt` is 10 minutes after the request. An enrollment in any state but `approved` or `delivered` expires then. Every transition is single-use and checked under a row lock. **Both clients enforce expiry from their own clocks too**, taking the earlier of `expiresAt` and their own start time plus 10 minutes. The CLI generates fresh keys for every request, and never reuses keys from an expired or cancelled one.

### 9.2 Steps

1. **Request (CLI).** The CLI generates fresh X25519 and Ed25519 keys and a 32-byte random `pollSecret`. It posts `{boxPublicKey, signPublicKey, pollSecretHash}`, where `pollSecretHash = base64url(BLAKE2b-256(canonical('agent-poll-secret/v1', [pollSecret])))`. The server returns `{enrollmentId, lookupCode, expiresAt}`:
   - `lookupCode` is 8 random symbols from Crockford base32 (`0123456789ABCDEFGHJKMNPQRSTVWXYZ`, 40 bits), shown as `XXXX-XXXX`;
   - the server stores only `base64url(BLAKE2b-256(canonical('agent-lookup-code/v1', [normalizedCode])))`; normalizing means uppercasing, removing `-` and spaces, and mapping `I` and `L` to `1` and `O` to `0`;
   - requests are rate-limited per IP.

   The CLI checks `lookupCode` against `^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$`, `enrollmentId` against the ID regex, and `expiresAt` against `Timestamp`, and refuses the response if any fails.
2. **Claim (person).** The person enters the code in an unlocked browser session, after a recent sign-in. Failed claims are limited per account and across the installation. A code works once. The server binds the enrollment to the claimer's account and current human identity, and returns the agent's public keys.
3. **Compare.** Both sides compute the agent's ID (section 4.2) and the **enrollment fingerprint**:

   ```
   enrollmentFingerprint = BLAKE2b-160(canonical('agent-enrollment-check/v1', [installationId,
                             ownerId, ownerKeyVersion, ownerBoxPublicKey (bytes), ownerSignPublicKey (bytes),
                             agentId, agentBoxPublicKey (bytes), agentSignPublicKey (bytes)]))
   shown as lowercase hex in 10 groups of 4, like a fingerprint (section 4.3)
   ```

   It covers the agent's keys and the person's keys. The browser learns the agent's keys from the server, and the CLI learns the person's keys from the server, so each side's copy would differ if the server swapped either. The browser shows the fingerprint next to the lookup code. The CLI polls with `pollSecret`, learns it was claimed, and receives the person's `PublicIdentity`. It checks that identity (`kind` is `"human"`, a valid `HumanId`, an integer `keyVersion`, keys that pass section 4.1), and refuses it otherwise. It may print the claimer's name and email, marked as untrusted and escaped (section 9.3). It prints the fingerprint **last**, on lines of its own, computed locally, after all server text. The person compares all ten groups. With 160 bits, making both sides show the same value with keys of the server's own takes about 2^80 work, inside a 10-minute window, against fresh CLI keys.
4. **CLI confirmation.** Straight after the fingerprint, the CLI asks: *"Does your browser show exactly `xxxx xxxx …`? Type yes to continue."* On yes, it posts `{pollSecret, agentId}`. The server checks that `agentId` derives from the claimed person and the posted keys, and moves to `cli-confirmed`. This stops someone who saw the lookup code from claiming the CLI: the real user would see a fingerprint that matches nothing.
5. **Approve (person), behind re-authentication.** While the fingerprint is on screen, the person types a name for the agent, distinct from their other agents' names, and picks its folders and roles (section 9.4). They press "Fingerprints match, approve". Their client:
   - signs the `AgentEnrollment` (section 4.5), and adds `{enrollment, label: {name, enrolledAt}, shares}` to its contacts record in a confirmed write (section 8.6), so the agent can read the shared payload;
   - seals the chosen shares' keys to the agent (section 9.4).

   The server checks that the state is `cli-confirmed` and unexpired, that the enrollment is signed by the caller's current human key, and that the agent ID derives correctly. It creates the agent identity row (`kind: agent`, `keyVersion: 1`, owned by the person's account) and the credential (section 9.6). It stores the token sealed to the agent's box key, so a database snapshot holds no usable token.
6. **Deliver (CLI).** The CLI's next poll returns the sealed token and `credentialId` **once**, and the server deletes the sealed copy. Anyone can seal to the agent's box key, so the CLI checks that `credentialId` matches `^[A-Za-z0-9_-]{22}$`, that the opened token matches section 9.6, and that the token's `credentialId` equals the polled one. It writes its key file with a structured serializer, never by joining strings.

### 9.3 What the CLI trusts

- **Its person.** It pins the person's `PublicIdentity` from step 3 only after the user typed yes, and after it verifies the stored `AgentEnrollment` under that key. **It opens folder key envelopes only when that person sealed them** (section 6.4).
- **Its person's contacts record**, which is sealed to it (section 8.1). It verifies the record with the pinned key, checks record authors against its pins (section 8.4), and never seals anything.
- **A local file** in the key-file directory (mode `600`), holding its contacts mark, its **No going back** marks (section 6.8), its own first-seen pins (section 8.3) and the last restore of the server it has seen (section 8.5, **After a restore**).

`wikistow whoami` prints the agent's label name, `enrolledAt` and ID. That identifies the device only if the device is trustworthy (A8).

**Printing text the CLI didn't write.** A string the CLI writes is **foreign** unless it is a literal in the CLI's own code, a number or date it formatted, an ID or hash it has checked against its pattern, or what the user gave it: an argument they typed, or a path made from one or from the environment, such as the key-file directory. These come from the user, not the server, so its own messages print them as they are, and a Windows path shows single backslashes. Foreign strings include server text (names, emails, error messages and codes), decrypted content (titles, Markdown, folder and space names, attachment names, and file names made from them), labels, and the text of errors from the system or a library. The CLI MUST pass every foreign string through one of these encoders, on **every** output path, stderr and exception text included:

1. **Human output.** Each code point in U+0000–U+001F, U+007F–U+009F, U+2028, U+2029, U+061C, U+200E, U+200F, U+202A–U+202E and U+2066–U+2069 is written as `\u{` + lowercase hex + `}`, and a backslash as `\\`. Every other code point is written as itself in UTF-8, **unless the output encoding isn't UTF-8**, in which case every code point above U+007E is escaped the same way. The encoding is UTF-8 only if the first set of `LC_ALL`, `LC_CTYPE` and `LANG` names a codeset that, compared case-insensitively with `-` removed, is `utf8`. On Windows, which has no such variables and whose consoles show Unicode, it is always UTF-8.
2. **During enrollment** (section 9.2, steps 3 and 4), server text is always written as ASCII only, whatever the locale.
3. **`--json` output** is written by a serializer that emits only printable ASCII inside strings: every code point outside U+0020–U+007E as a lowercase `\uXXXX` escape. A plain `JSON.stringify` is not enough.
4. **Raw output** of decrypted content is allowed only when stdout isn't a terminal.

These encoders disarm escape sequences, operating-system commands such as OSC 52 and OSC 8, carriage returns and backspaces, which could otherwise draw a forged fingerprint or prompt. The encoders of PR #29 stay (`cli-text.ts`), with the fingerprint in place of the safety-code words.

The CLI never receives the person's keyring, vault key, password or browser cookie.

### 9.4 Picking folders, and sealing to agents

**Only a person's own app seals keys to their agents.** Owners never seal to agents.

- **Picking.** At approval, and later from the agent's settings, the person picks folders or spaces and a role: reader or editor, with publish only where they can publish. Each pick is inside a share they are a member of, or in a space they own.
- **A pick in the owner region** of a space they own first makes the folder a share (section 6.7), with the agent as its only member besides the owners. The nesting rule applies (section 6.1).
- **A pick inside a share.** The person's app seals to the agent every version of that share it holds, up to the highest one that counts for its own writing (section 6.5, **Writing**): both keys if the role picked in the dialog is editor and the person holds the draft key, otherwise the published key only. **The agent gets the whole share's keys**; the server limits it to the picked folder (A1).
- **Recording.** Before sealing, the app adds `{spaceId, shareId, drafts}` to the agent's `shares` in a confirmed contacts write (section 8.6). `drafts` is `true` when the role picked is editor and the person holds the share's draft key, and `false` otherwise. The server records the grant `{agentId, shareId, folderId | null, role, canPublish}`.
- **At every unlock**, the person's app seals to each of its agents that isn't in `revokedAgents`, for each share in that agent's `shares`, and each share of a group in its `groups`, every version it holds that the agent lacks, up to the highest one that counts for its own writing (section 6.5, **Writing**). The server lists what is missing, which includes a version the agent holds without the draft key where its grant now lets it edit; the app checks the share is on the agent's list, or that the server lists it for a group on the agent's list, and never seals any other share. **The class comes from `drafts` in the person's own contacts record, never from the server's grant or an earlier envelope:** both keys only if the share's `drafts` is `true`, or a group's `drafts` is `true` and the server lists the group as an editor there, and the person holds the new version's draft key; otherwise the published key only. A sealed version replaces the agent's envelope for it. It never seals a version it doesn't hold, so **when the person loses access to a share, their agents stop receiving its new versions too**. Rotations leave such agents out by construction.
- **Changing an agent's role.** The app sets that share's `drafts` in a confirmed contacts write (section 8.6), then seals every version it holds again, as above, and these envelopes replace the agent's ones; the server sets the grant's role. On a change to reader, the agent keeps the draft keys it had (A6), so the app offers to ask the share's owners to rotate keys (section 7.5), as after a revocation (section 9.7).
- **Removing a pick.** The app removes `{spaceId, shareId}` from the agent's `shares` in a confirmed write, and the server deletes the grant. The agent keeps the versions it had (A6); an owner can rotate the keys (section 7.5).
- **Groups** (section 7.8). An owner may add an agent to a group for its person, who must be a member of the group or an owner. Only the person's app seals to it, so the group gives it nothing until the person confirms. `GET /api/me/agents/groups` lists the groups the person's live agents are in, by space and group ID, each with its shares and their access and whether the person confirmed it; never the group's name. To confirm, the app adds `{spaceId, groupId, drafts}` to the agent's `groups` in a confirmed write, then sends `POST /api/me/agents/:agentId/groups/:groupId/confirm {drafts}`, then seals what the agent lacks as at unlock, and at every unlock after. The interface confirms with `drafts: true`; with `false` the agent gets the published keys only. The server grants the agent each of the group's shares whole, at the group's role (reader without `drafts`), capped by its person's current access (section 9.5); a pick in the same share stands beside it, and the higher counts. An owner adding their own agent confirms the same way straight after. `POST /api/me/agents/:agentId/groups/:groupId/leave` takes the agent out, confirmed or not: the app removes the group from its `groups` first, in a confirmed write. It keeps the keys it had (A6), and the owners' apps list it among the agents holding the share's keys with no grant, and offer to rotate them. An owner taking the agent out rotates the shares it no longer reaches (section 7.9), and a person's agents leave a group with them. A revoked agent's groups give it nothing.

### 9.5 Abilities, limits and attribution

- **The cap (#2).** The server limits an agent, on every request, to the lesser of its grant and its person's **current** access at the node. A person with no access leaves their agent none. An owner's access counts as editor with publish.
- **An agent can** read, create pages and folders, edit drafts, attach files, view history, and move pages and folders within one region, inside what it was picked for, within its grants and the cap. It can publish and unpublish only if its grant allows it **and** its person can publish there.
- **An agent can never** share, add or remove members, change roles, rotate keys, move across shares, add or remove owners, or use account, admin, vault or agent-management routes or `PUT /api/me/contacts`.
- **Attribution.** An agent signs its own records. The record names the agent's ID, which derives from its person's ID and its keys (section 4.2), so any client can check whose agent wrote it. The interface shows it as "agent (for person)": the person's own label for their agent, or for someone else's agent the server's agent name marked as from the server, with the person's pinned label.
- **After a rotation,** an agent can't save in that share until its person's app unlocks and seals it the new version. The server answers `key-version`, and the CLI reports missing keys (section 6.8).

### 9.6 Bearer credential

```
token          = "wsa_" ‖ credentialId ‖ "." ‖ secret
credentialId   = base64url(16 random bytes)      // 22 characters
secret         = base64url(32 random bytes)      // 43 characters
stored hash    = BLAKE2b-256(canonical('agent-credential/v1', [credentialId, secret (bytes)]))
```

The token is sent as `Authorization: Bearer <token>`. To accept it, the server:

1. matches `^wsa_([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$`, decodes the secret strictly, and finds the credential by ID;
2. recomputes the hash and compares the 32 raw bytes in **constant time**;
3. checks, on every request, that the credential isn't revoked, that it was created after `users.credentials_revoked_at` for the person's account (or that timestamp is null), that the account isn't suspended or deleted, and that the agent identity isn't revoked;
4. **refuses a request that also carries a `Cookie`, or an `Origin` other than the server's own**, so a token is never mixed with a person's session or used from another site. The server's own origin is allowed for the agents a person's app runs (section 9.8), whose requests a browser sends with it. A browser never attaches a token by itself, so another site can't use one.

Agents may use the content routes of section 9.5 (moves among them, section 10), `GET /api/me/contacts` (their person's record), their own folder key envelopes, and directory lookups of the authors of records they can read. Everything else is for humans only.

### 9.7 Revocation

Each of these ends an agent's bearer token on its next request:

- **The person revokes the agent.** This sets its credential's `revoked_at` and its identity's `revokedAt`. The person's app adds it to `revokedAgents` in a confirmed write, and never seals to it again (section 8.2).
- **A password reset** sets `users.credentials_revoked_at = now()` in the same transaction as the reset. Every credential created before then is dead (#7).
- **An administrator** revoking sessions and agents, or suspending the account, does the same.
- **A password change** does the same as a reset: any write of the account's password ends every credential made before it. Each of these three also revokes the account's agent identities and ends their grants, and the person's app adds those agents to `revokedAgents` at its next unlock.
- **Reactivating an account never restores anything.** The person enrolls a new agent.

**Keys.** A dead token stops the agent fetching. It doesn't take back the folder keys it holds (A6). When an agent is revoked, the interface lists the shares in its `shares`, and offers to ask their owners to rotate keys. Owners' apps list shares where a revoked agent held keys, and offer Rotate keys (section 7.5). A person's app that rotates a share it owns does so at once.

### 9.8 Agents an app runs

The page chat's assistants (wikistow.md, AI assistant) are agents the person's own app runs, in the browser or the desktop app. Each is enrolled as in section 9.2, with the app playing both sides, so there is no code to type and no fingerprint to compare by eye:

1. **Request.** The app makes fresh agent keys and a poll secret and posts them, as a CLI does.
2. **Claim**, behind a recent sign-in, with the lookup code the server just returned.
3. **Check.** In place of two people comparing fingerprints, the app checks that the agent keys the server served with the claim are exactly the ones it made, and that the person the server served to the agent's side (its poll) is this person at their current keys. Their two fingerprints are then the same by construction. A key the server swapped either way fails here, as it would show as a different fingerprint, and the app turns the enrollment down.
4. **Confirm** as the agent, with its poll secret.
5. **Approve** as for any agent: name, picks, the signed `AgentEnrollment` in a confirmed contacts write, keys sealed (sections 9.2 and 9.4).
6. **Deliver.** The app polls for the token and checks it as the CLI does (section 9.2, step 6).

It then keeps the agent's secret keys and token in the person's **private** contacts payload, under the `wikistow.appAgents` extension, in a confirmed write: `{agents: [{agentId, boxSecretKey, signSecretKey, token}]}`. Only the person opens that payload (section 8.2), so the server never holds them in the clear, and the agent works from any of the person's devices. If approving fails, the app turns the enrollment down, and revokes the agent if the server made it anyway (its answer was lost). If anything after approval fails (the poll, the token's checks or that write), the keys and token are lost with the app's memory, so the app revokes the agent rather than leave one nobody can use holding its name.

The app opens it as the agent's own session (section 9.3): its keys, its token in a client of its own that sends no cookie, and its person at their current keys, starting from the contacts mark the person's session accepted. Its pins and marks last only that session. Nothing it opens goes into the person's keyring or revision cache. The desktop app passes the agent's token through to the server instead of the person's session. Revocation is as for any agent (section 9.7); the app also stops the chat at once and drops its pending proposals.

---

## 10. Moves

- **Within one region** (inside one share, or inside the owner region), a move changes no keys. Editors may move within a share; the server checks edit rights at the node and both parents.
- **Across a region boundary** (into a share, out of one, or between two), only owners may move. The nesting rule applies (section 6.1). A share root moved within the owner region stays a share and needs no rewrap.
- **Regions.** The source region is the moved node's own region, and the destination region is the region of the destination parent's name record (section 6.1). Neither comes from the tree.
- **Preview.** The owner's client lists, for each audience class, who gains and who loses access, by label. For a share, the people are the human recipients of the verified envelopes of its current version, fetched as in section 7.5, step 1, never the server's member list; for the owner region, they are the sealing owners (section 6.5). A server can hide envelopes another owner sealed (A2), so the gainers shown are a lower bound, and the preview says "at least these people gain access". It says that once confirmed, cancelling can't take keys back from gainers (A10). Nothing is wrapped or sealed before the owner confirms. An owner may turn this confirmation off on a device; the app then works out the preview the same way and moves at once, showing the preview while the keys are rewrapped.
- **Rewrap.** For every retained revision and metadata version in the moved subtree, the client opens the content key and checks it against the record. It then writes a key wrap under the destination share's current version, which must count for writing (section 6.5, **Writing**) and pass the check of section 6.8 (**No going back**), or, into the owner region, v2 envelopes to every sealing owner.
- **Upload.** The client sends the move, the expected old parent, and the new wraps or envelopes in one request. Under a lock on the space, the server checks the nesting rule, the destination's current key version, and that every record in the subtree is covered. It then moves the subtree, replaces its wraps or envelopes, and bumps permission versions, all at once. If anything fails, it deletes what was uploaded.
- **Losers** keep what they had (A3). No rotation is needed: later saves of the moved content are wrapped under the destination's keys, which the losers don't hold.
- A move into another space isn't a move; it is a copy or a publication (section 13).

---

## 11. Unpublish and republish

**Unpublish.** Someone who can publish at the page sends `POST /api/pages/:id/unpublish {expectedPublishedHead}`. Under a lock, the server checks the published head (`stale-head` otherwise), sets it to `null`, and bumps the page's permission version.

**Current reader history.** A page's current reader history is its published revisions stored after its latest unpublish, in the server's order. While the page is published, readers see only that history. While it is unpublished, they get `not-found`, as if it had never been published. Editors and owners see the full history and can restore any version. This is the server's rule only (A1): readers already hold the keys of what they could read before, and new members get every key version (section 7.3).

**Unpublishing changes no keys.** It only hides the page from readers. The next publish is an ordinary publish under the share's current key version.

**Limits.** Readers who already read a version keep it. Downloaded copies can't be recalled. The interface says so before unpublishing.

---

## 12. Attachment reuse

Publishing or restoring may list an earlier copy of an attachment instead of uploading it again (#18). It does so only when it gives nobody a key they don't already hold.

### 12.1 Plaintext hash

```
plainHash = base64url(BLAKE2b-256(canonical('attachment-plain-hash/v1',
              [installationId, spaceId, pageId, plaintext (bytes)])))
```

The canonical prefix is known before the bytes arrive, so `plainHash` can be computed in a streaming pass: feed `encodeField("wikistow/attachment-plain-hash/v1") ‖ encodeField(installationId) ‖ encodeField(spaceId) ‖ encodeField(pageId) ‖ 0x03 ‖ uint32be(length)`, then the bytes. It is scoped to the page, binds no audience, and sits inside the encrypted payload only. `AttachmentRef.plainHash` is **optional** (`Hash32`). Adding it makes the page payload format **1.1**. A ref without it is never reused. Every decryption checks it (section 5.3).

### 12.2 The rule

When a client prepares the payload of a record for audience `T` of page `p`, an attachment `ref` may list an existing copy `c` instead of a fresh reseal only if all of these hold:

1. `c.id = ref.id`.
2. `ref.plainHash` and `c.plainHash` are both present and equal.
3. **Same audience.** `c`'s audience equals `T`, read from the signed record of a revision of `p` that lists `c`, never from the server.
4. **Same region.** That revision's content key is in the same region as the new record: wrapped under the same share, at any key version, or both in the owner region.
5. **Checked by this client.** In this operation, the client has downloaded `c`, checked `blobHash`, decrypted it, and recomputed `plainHash` itself.

**Why that is enough.** Everyone who can open the new record already holds a key that opens `c`: a share's members hold every key version of it (section 7.3), and owners hold every owner-region content key (section 7.6). A removed person may hold `c` too, but already has its plaintext. After a move, the rewrapped revisions count as in the destination region (section 10).

**Carrying a copy forward.** A write that keeps an unchanged ref from its `basedOn` record, in the same audience and region, is a reuse by construction. Otherwise the client reseals under a fresh key. This replaces Milestone 1's rule in `resealAll`, which compared the source copy's `key` and `blobHash`.

---

## 13. Cross-space publication

A publication copies explicitly chosen versions of a source page into a destination page in another space (`wikistow.md` L185–189).

**Destination page.** The destination page `D` in space `T` is an ordinary page. Its published revisions are ordinary `revision-record/v2` records in `T` with `audience: "published"` and **`basedOn: null`**, because there is no draft in `T`. Their content key is wrapped or sealed for `D`'s region in `T` (section 6.8). The order of its versions is the server's.

**Sealing.** The publisher's client:

1. opens the chosen source version, draft or published, which needs a key for it;
2. builds the destination payload from its `title`, `markdown` and `extensions`, leaving out `wikistow.links` (section 5.5), and sets the extension `wikistow.publication`:
   ```
   { format: 1, sourceSpaceId, sourcePageId, sourceRevisionId,
     sourceAudience: "draft" | "published",
     sourceRecordHash: base64url(BLAKE2b-256(the source record's own signed bytes)) }
   ```
   The signed bytes are `revision-record/v1` or `revision-record/v2`, chosen by the source record's `protocol`;
3. **reseals every chosen attachment** under a fresh key, with the destination AD `attachment/v1 [installationId, T, D, "published", attachmentId]`, and recomputes `plainHash` for `T` and `D`. It never reuses a source copy. Attachments the publisher didn't choose are dropped, and a `wikistow.cover` banner naming one of them becomes the theme gradient, and an icon naming one is left out (section 5.5);
4. wraps the content key under the published key of `D`'s share at its current version, which must count for writing (section 6.5, **Writing**) and pass section 6.8, or seals it to `T`'s sealing owners in the owner region (section 6.5).

**Provenance lives only inside the encrypted payload.** The server's `publications` row (destination, source space and page, last source revision sent) is visible metadata (A7). Destination readers can't verify the source fields, so the interface treats them as a label ("Published from another page"), never as a link. It names the source only for a viewer whose app opens `sourceRevisionId` of `sourcePageId` and finds its `sourceRecordHash`, title and Markdown match the copy, since anyone who can publish at `D` can write any source into it.

**Server checks** (`POST /api/publications`):
- the caller can publish at the source page, whichever version they send, and the version is one of that page's. A page's readers can't copy it into another space. (Clarified after the freeze: see `protocol-review.md`.) Agents may where both their pick and their person allow publishing at the source (section 9.5);
- the caller can publish at the destination;
- the destination's key version (section 6.8) and permission version, and a compare-and-swap on its published head;
- an idempotency key, and one row per source page and destination space.

**No draft key reaches the destination**, because the copy is published and wrapped only with a published key. Source readers don't gain destination access, and destination readers don't gain source access.

**Ending.** Someone who can publish at the source page may end its live publication in `T`, even when they can't open `D`, so a copy made where they can't see never keeps the source's publishers out of `T`. The server marks the row `detached_at` and changes nothing in `D`, which stays as it is, its readers keep it, and a publisher of `D` detaches it to edit it. The next publication of the source into `T` makes a new page. The server tells a source publisher that a live copy they can't publish at exists in `T`, and nothing else about it, not its ID or folder. It lists a source page's live publications to its publishers (`GET /api/pages/:id/publications`): each one's space, and for a copy they can publish at, its page and folder. A copy they can't publish at is named by its space alone, and one with no version yet that they can't publish at is left out, as when they ask about one space. Only publications made from the page's own space, since the page was made, count. The per-space requests don't check this yet (#75). The app names the space and folders by the names it can open, and shows the rest as unreadable.

**Unfinished openings.** A page opened for a publication that has no version yet is replaced when another source publisher opens one in a different folder, and is swept once it is a day old with nothing uploaded for it in that day. A publisher still working on it then gets not-found and opens again; nothing is shown to anyone in between.

**Detaching** makes `D` an independent page. A publisher writes `D`'s first draft from its latest publication, **removing the `wikistow.publication` namespace** (and `wikistow.links`, which a copy never carries; section 5.5). These and the copy itself leaving out `wikistow.links` are the only places a namespace is dropped on purpose. The server marks the publication row `detached_at`.

---

## 14. Milestone 1 data

### 14.1 What it has

A space created in Milestone 1 has one owner grant row, nodes with server-recorded parents, v1 records written by the one owner with v1 envelopes to that owner, and a published history. Milestone 1 had no unpublish, so all of that history is the current reader history (section 11).

### 14.2 Until first shared

A Milestone 1 space keeps working, owner-only, until its owner first shares it, shares a folder in it, adds a co-owner, or grants an agent a folder in it. Until then its owner's app accepts only itself, because it authored the space's name record (section 6.5, step 1), and everything in it is in the owner region (section 6.6). An owner the server adds to the space's rows isn't accepted, so the owner's app refuses to save (`unaccepted-owner`) rather than seal to them. A server that withholds the owner's own name record gets no first sight either: the server lists the owner as an owner, so the app shows the co-owner dialog for any statement it is served, naming a signer the owner never added (section 6.5, step 2). New records there are v2, with a v2 envelope to the owner. Nothing needs a backfill, a signature over the tree, or the owner's review before the first share.

### 14.3 What sharing it does

- **Sharing the space, or a folder in it,** makes a share as section 6.7 describes. The owner's client wraps every retained record of the subtree, v1 and v2 alike, under version 1, after the owner has checked the preview. The v1 envelopes of those records are deleted. Members open v1 records through these wraps, and accept them because their author is an accepted owner (section 5.7).
- **Adding a co-owner** seals every owner-region record's content key to them, v1 records included, in v2 envelopes (section 7.6).
- **Granting an agent** a folder makes that folder a share first (section 9.4).

**The tree is the server's** (A1). Milestone 1 never signed parent links, and Milestone 2 doesn't either. A server that moved a private page into a folder before it is first shared gets that page wrapped only if the owner misses it in the preview. A page the server moves into a share afterwards stays sealed to the owners: nobody wraps it, and the owner's next save of it is refused as `region-mismatch` (section 6.8).

### 14.4 Reading old data

- v1 revision and metadata envelopes stay valid on v1 records, when the granter is the record's author (section 5.2).
- v1 records open through a v1 envelope, a v2 envelope or a key wrap.
- Payloads at format 1.0 open as before. Refs without `plainHash` are never reused (section 12).

---

## 15. Changes to what PR #29 merged

PR #29 merged the client and contracts formats of the earlier design. None of them reached the server or stored data, so this design changes some of them in place, keeping their domain names, rather than add new versions.

**Kept unchanged:**
- strict JSON for signed and hashed objects, raw integer tokens, duplicate and `__proto__` handling, and well-formed strings (`json.ts`, `encoding.ts`; section 3.3);
- strict payload decoding (section 3.2), `Hash32`, `Timestamp`, `Email`, and the field-length check in `encodeField`;
- the key commitment: `content-key-commit/v1`, `keyCommitment`, `requireCommittedKey` and the `key-commitment` error (section 5.7);
- the contacts record format: `contacts/v1`, `contacts-payload/v1`, `contacts-private-payload/v1` (section 8.1);
- `identity-key-hash/v1`, `attachment-plain-hash/v1`, the agent enrollment checks, the agent ID pattern, the enrollment and credential hashes, and the CLI text encoders (`cli-text.ts`).

**Changed:**

| Item | In PR #29 | Now |
|---|---|---|
| `revision-record/v2` fields | … `payloadHash, keyCommitment, authorizedSeq, authorizedHash` | … `payloadHash, keyCommitment` |
| `metadata-record/v2` fields | … `payloadHash, keyCommitment, authorizedSeq, authorizedHash` | … `payloadHash, keyCommitment` |
| `key-envelope/v2` and `metadata-envelope/v2` fields | … `granterId, granterKeyVersion, authorizedSeq, authorizedHash` | … `granterId, granterKeyVersion`; used only in the owner region, granted by an accepted owner |
| `RevisionRecordV2`, `MetadataRecordV2`, `KeyEnvelopeV2`, `MetadataEnvelopeV2` schemas | have `authorizedSeq`, `authorizedHash` | don't |
| `checkEnvelopeV2` (`envelope.ts`) | refuses an envelope older than its record (`recordAuthorizedSeq`); `Authorization` type | checks recipient, accepted-owner granter and signature only; `Authorization` removed |
| `openRevisionV2`, `openMetadataV2` | take an `AuthorizeRevision` or `AuthorizeMetadata` hook for the log checks | take a key wrap or a v2 envelope; no hook |
| contacts shared payload | `method: "safety-code"`; `agents: {enrollment, label}` | `method: "first-seen" \| "confirmed"`; `agents` gains `shares` (`{spaceId, shareId, drafts}` items); adds `spaceOwners` with `owners` and `removedOwners` |
| contacts private payload | `labels`, `spaceMarks`, `unresolvedAppends` | `labels` only |
| label `name` | typed by the person while comparing a safety code | the directory's name at first sight, which the person may edit |
| `enrollAgent`, `TrustStore.pinVerified` | take a compared safety code | `enrollAgent` takes the compared enrollment fingerprint; pinning is first-seen, with a confirm step for key changes |

`CONTACTS_FORMAT` stays `1.0`, because no contacts record was ever stored.

**Retired**, with their domains, schemas, tests and vectors:
- `access-entry.ts` and `contracts/src/records/access-log.ts`: `access-entry/v1` and `access-body/v1`;
- `placement.ts` and `contracts/src/records/placement.ts`: `node-placement/v1`, `node-id/v1`, `legacy-node/v1`, `legacy-placements/v1` and `legacy-records/v1`;
- `authority.ts`: the author authority check;
- `owner-request.ts` and `contracts/src/records/owner-request.ts`: `owner-request/v1`;
- `safety-code.ts` and `bip39-english.ts`: `safety-code/v1` and `safety-code-salt/v1`;
- the errors `authority-invalid`, `placement-invalid`, `legacy-invalid` and `safety-code-mismatch`.

**New:** `content-key-wrap/v1` (section 6.3), `folder-key-envelope/v1` (section 6.4), `space-owner/v1` (section 6.5), `agent-enrollment-check/v1` (section 9.2), and the errors `missing-key`, `untrusted-sealer`, `unaccepted-owner`, `region-mismatch` (client), `key-version` (client and server), and `share-nesting`, `last-owner` (server). Identity key rotation (`identity-rotation/v1` in earlier drafts) is left to a later milestone (section 4.6).

---

## 16. Implementation notes for PR 2 and PR 3

These notes say what the next two PRs change. They add no rules; where they differ from the sections above, the sections above win.

**PR 2 (keys) changes in what #29 merged:**
- `revision.ts`, `metadata.ts` and their contracts schemas: drop `authorizedSeq` and `authorizedHash` from the v2 records and envelopes (`revisionRecordV2Bytes`, `keyEnvelopeV2Bytes` and the metadata equivalents), keep the domain names, and regenerate the #29 vectors (section 15).
- `envelope.ts`: `checkEnvelopeV2` takes an accepted-owner check (section 6.5) instead of `recordAuthorizedSeq` and `trust.require(granter)`; `Authorization` goes. `openEnvelope` (v1) also checks that the author is an accepted owner (section 5.7). Agents take accepted owners from `spaceOwners`.
- `trust.ts`: `pinVerified` becomes a first-seen pin plus a confirm step (sections 8.3 and 8.4); `recipients()` pins a person seen for the first time instead of throwing `unknown-identity`; `enrollAgent` takes the enrollment fingerprint instead of calling `safetyCode`; pins load from and save to the contacts record.
- `contacts.ts`: `method` becomes `"first-seen" | "confirmed"`; `spaceMarks`, `unresolvedAppends` and their integer paths go; add `agents[].shares` (with `drafts`) and `spaceOwners` with `removedOwners`, the uniqueness keys of section 8.2, and the "accept an owner", "remove an owner" and "add a co-owner" merges of section 8.6.
- New modules: key wraps (section 6.3), folder key envelopes (section 6.4), owner statements and the accepted-owner rule (section 6.5), and a record's region (section 6.1). The accepted-owner module takes the space's contacts entry, the app's identity, the space's name records, the served statements and envelopes, and the server's owner list. It returns two predicates over a sealer and key, one for opening and one for writing (section 6.5, **Using the result**), the sealing owners, and the contacts changes to write; rotation, moves, publication and agent sealing take the writing predicate rather than deriving their own. The region module covers `basedOn: null` writes on an existing page (section 6.1). Folder keys are stored under `(spaceId, shareId, keyVersion, class)`, and the **No going back** mark under `(spaceId, shareId)`, in the local file in the CLI and on a desktop with a trusted keyring, and otherwise in memory (section 6.8).
- Remove the retired modules (section 15).

**PR 3 (sharing on the server) routes.** Shapes are brief; every write also carries its permission version.

| Action | Request | Server |
|---|---|---|
| Make a share (6.7) | `POST /api/spaces/:spaceId/shares {shareId, rootId, wraps: [{subjectKind, versionId, wrap}], envelopes, members: [{identityId, keyVersion, role, canPublish}], agentGrants: [{agentId, folderId \| null, role, canPublish}]}` | refuses a used `shareId` in any space; the checks of section 6.7. `agentGrants` is for a pick in the owner region (9.4): each agent is the caller's, and its envelopes are sealed by the caller |
| Add a member, or share again with one whose key changed (7.3) | `POST /api/shares/:shareId/members {identityId, keyVersion, role, canPublish, envelopes}` | envelopes cover versions 1 to current at `keyVersion`; replaces the member's key version and deletes their envelopes for older key versions |
| Reader to editor (7.4) | the same route, with draft keys | replaces that member's envelopes |
| Rotate, remove or demote (7.5, 7.4) | `POST /api/shares/:shareId/rotate {expectedKeyVersion, removed: [identityId], demoted: [identityId], envelopes}` | the exact-set check of section 7.5, step 4 |
| Add a co-owner (7.6) | `POST /api/spaces/:spaceId/owners {identityId, keyVersion, statement, folderKeyEnvelopes, keyEnvelopes, metadataEnvelopes}` | the coverage check of section 7.6 |
| The new owner's statement (6.5) | `POST /api/spaces/:spaceId/owner-statements {statement}` | the signer is the caller and an owner; the named owner is a human who is, or has been, an owner of the space |
| Remove an owner (7.6) | `POST /api/spaces/:spaceId/owners/:identityId/remove {rotations: [{shareId, expectedKeyVersion, removed, demoted, envelopes}]}` | one rotation per share; the caller may be `identityId`; `last-owner`; ends the grants of `identityId`'s agents in the space. A retry after a failure is the same request, prepared again from the current versions (section 7.6); once the server no longer lists `identityId`, there is nothing to retry |
| Transfer | the old owner adds a co-owner, then removes themself | two requests by one person (section 7.6) |
| Owner statements | `GET /api/spaces/:spaceId/owner-statements` | to owners and members of the space |
| Envelopes of a version (6.4) | `GET /api/shares/:shareId/versions/:keyVersion/envelopes` | every envelope of that version for an owner of the space; otherwise only the caller's own |
| My envelopes in a space (6.5, step 2) | `GET /api/spaces/:spaceId/my-envelopes` → `[FolderKeyEnvelope]` | every folder key envelope addressed to the caller in the space, at the caller's current identity key version, for every folder key version; the client orders them by `shareId`, then `keyVersion`, itself |
| What an agent lacks (9.4) | `GET /api/me/agents/:agentId/missing` → `[{spaceId, shareId, keyVersions: [n]}]` | only shares the agent has a grant in; then `POST /api/me/agents/:agentId/envelopes {envelopes}` |
| Approve an agent (9.2, step 5) | `POST /api/agents/enrollments/:enrollmentId/approve {enrollment, grants: [{shareId, folderId \| null, role, canPublish}], envelopes}` | the checks of section 9.2, step 5; each grant is in a share the caller is a member of or owns, with its role capped at the caller's; the envelopes are sealed by the caller to the agent, and cover versions 1 to current of each granted share, with `draftKey` `null` exactly for reader grants; all or nothing. The client seals only up to the highest version that counts for its own writing (section 9.4), so if a share's current version is one it can't write under, such as one a removed owner sealed and the server served (A5), approval is refused. The server could refuse anyway, so this is acceptable. Picks in the owner region are made shares right after approval, with Make a share and `agentGrants` |
| Grant an agent a pick, or change its role (9.4) | `PUT /api/me/agents/:agentId/grants/:shareId {folderId \| null, role, canPublish, envelopes}` | the same checks as approval for one share; replaces the grant and the agent's envelopes in the share |
| Remove an agent's pick (9.4) | `DELETE /api/me/agents/:agentId/grants/:shareId` | deletes the grant; the agent's envelopes stay (A6) |

**Records with their key material.** Every record the server serves, in a read or in history, comes with `wrap: KeyWrap | null` and `envelopes`: the caller's own v1 or v2 envelopes for it. Exactly one of the two is non-empty (section 6.1). A member's record never comes with another share's wrap.

---

## 17. Open questions and limitations

| # | Question or limitation | Current answer |
|---|---|---|
| Q1 | **Agents in groups.** | Built in Milestone 5 (sections 7.8, 7.9 and 9.4). A group is a set of people and their agents added to shares together; it needs no new key format. |
| Q2 | **Contacts rollback in the browser, and contacts forks between devices** (section 8.5). | Accepted. The desktop app and the CLI detect a rollback; the person can compare the version and hash each device shows. |
| Q3 | **KDF floor.** Vault wrappers accept libsodium's minimum Argon2id cost (section 5.6). | Recommend refusing to *write* below INTERACTIVE. Needs a code change. |
| Q4 | **Identity key rotation** isn't in Milestone 2 (section 4.6). | Later milestone, which also defines its statement format. Until then a person with a new key version is re-shared by owners after a key-change warning. |
| Q5 | **Published history order** is the server's, and unsigned. | Accepted, as in Milestone 1 (A2). |
| Q6 | **New key version after unpublish.** | Dropped. New members get every key version and current readers get the new one, so the rotation protected nothing. Unpublish only hides the page from readers (section 11). |
| Q7 | **Agents wait for their person after a rotation** (section 9.4). An unattended agent can't save in a rotated share until its person unlocks an app. | Accepted for Milestone 2. Owners sealing to agents directly would need owners to trust the server's list of agents. |
| Q8 | **Large first shares.** Making a share wraps every retained record of the subtree in one request (section 6.7). | PR 3 measures it in the sharing-cost benchmark (`apps/server/bench/sharing-cost.ts`, results in [`benchmarks/sharing.md`](benchmarks/sharing.md)), and may split the upload under an open operation that commits at once. |
| Q9 | **Node deletion** is the server's. | Affects availability only (A1, A2). |
| Q10 | **Owners don't see an agent's demotion** (section 9.4). An agent changed to reader keeps the draft keys it had (A6). Its person's app offers Rotate keys when the person owns the space. Otherwise it tells them to ask the owners, whose apps aren't told: they list agents with no grant that held keys, but the server doesn't record which keys an envelope held. | Accepted for Milestone 2. Telling owners would need the server to keep each envelope's key class, so a demoted agent could be listed beside former agents. |
| Q11 | **Which agent wrote a draft** is the server's claim (section 9.5). The page's 🤖 pill and the space's activity card show the agent the server says last saved a draft, which nothing signed backs. They name only the person's own agents, by the person's label, and any other as "an agent". | Accepted for Milestone 2. They drive no key decisions. Checking the claim against the draft's signed author needs the draft revision, which the published view doesn't load, so it is deferred. History is checked: each version's signed author, and the agent's person from its pinned keys (section 4.2). |
| Q12 | **A deleted space's ID can be used again.** Space IDs are made by clients (section 3.2), and the server refuses only an ID in use, so after a space is deleted, whoever knows its ID can make a new space with it. Apps keep accepted owners and `removedOwners` by space ID (section 8.2), so a former member's app starts the new space with the old one's entry. It skips first sight, and accepts the owners it accepted there and those they name, as before (section 6.5, steps 3 and 4, and **Using the result**). So it opens what those owners share there, and nothing from an owner no one it accepted names. A plugin the person let into the whole old space (section 8.2) is let into the new one too. | Accepted. Apps make space IDs at random, so only someone who knew the old space's ID can reuse it on purpose. A former owner was already trusted there, and what the app then won't open affects availability only. Reserving deleted space IDs, as the server already does for identity IDs, would close it. |

---

## 18. Security review

`wikistow.md` L333 and L357 make a focused security review of this protocol a release gate. The earlier design was reviewed in 16 rounds, logged in [`protocol-review.md`](protocol-review.md). Their outcomes for the parts this design keeps still stand: primitives, encodings, records, key commitment, the contacts record format, enrollment and the CLI's output rules. Their outcomes for the access log, vouching, safety codes, read-only spaces, re-homing, closing and owner requests no longer apply, because those parts are gone.

This design gets its own review round, with the same three briefs: a malicious server, a malicious or removed member or a compromised agent host, and encoding pitfalls. It focuses on what is new: shares and regions, key wraps, folder key envelopes, accepted owners, the key version check, rotations, moves and agent sealing. It also checks that the accepted risks in section 2.4 are the only ways the guarantees in section 2.3 fail. The round's findings, and the freeze once a round meets the stopping rule, are logged in `protocol-review.md`. Rounds 17 to 19 reviewed it on 2026-10-05. Round 19 met the stopping rule, and its findings are fixed, so the design is frozen for Milestone 2.
