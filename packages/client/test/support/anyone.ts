// Client tests only. Not exported from the package, so app code can't reach
// it: a predicate that accepts anyone defeats the owner check it stands for.
import { opensFor } from '../../src/owner-predicates.ts';

/**
 * An owner predicate that accepts anyone, for tests about something else. Real
 * callers take it from the space's accepted owners.
 */
export const opensAnyone = opensFor(() => true);
