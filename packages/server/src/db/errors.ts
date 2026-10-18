// Postgres's error, raw from postgres.js or wrapped by Drizzle as its cause.
const pgErrors = (error: unknown): unknown[] =>
  typeof error === 'object' && error !== null && 'cause' in error ? [error, error.cause] : [error];

/** Whether `error` is Postgres's SQLSTATE `code`, on `constraint` when given. */
function isPgError(error: unknown, code: string, constraint?: string): boolean {
  return pgErrors(error).some(
    (e) =>
      typeof e === 'object' &&
      e !== null &&
      'code' in e &&
      e.code === code &&
      (constraint === undefined || ('constraint_name' in e && e.constraint_name === constraint)),
  );
}

/** A unique-constraint violation, of `constraint` when given. */
export const isUniqueViolation = (error: unknown, constraint?: string) =>
  isPgError(error, '23505', constraint);

/** A lock asked for with `nowait` that another transaction holds. */
export const isLockNotAvailable = (error: unknown) => isPgError(error, '55P03');
