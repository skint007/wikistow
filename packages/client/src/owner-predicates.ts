import type { PublicIdentity } from './identity.ts';

declare const opening: unique symbol;
declare const writing: unique symbol;

/**
 * Whether a key belongs to an owner this app accepts for a space, for
 * opening (section 6.5): any owner it has ever accepted, at the key it
 * accepted, even one since removed, so history stays readable. For an agent,
 * its own person. Made by `acceptOwners` or `ownersFromContacts`.
 */
export type OpensOwner = ((owner: PublicIdentity) => boolean) & { readonly [opening]: true };

/**
 * The writing set (section 6.5, **Writing**): accepted owners this person
 * hasn't removed. Only a key version one of them sealed counts for writing,
 * rotating from, sealing to agents and the No going back mark.
 *
 * The two types are distinct, so neither can be passed for the other.
 */
export type WritesOwner = ((owner: PublicIdentity) => boolean) & { readonly [writing]: true };

// The package entry doesn't export these. Only the accepted-owner module,
// Milestone 1's operations and tests label a predicate as one or the other.
export const opensFor = (accepts: (owner: PublicIdentity) => boolean) => accepts as OpensOwner;
export const writesFor = (accepts: (owner: PublicIdentity) => boolean) => accepts as WritesOwner;
