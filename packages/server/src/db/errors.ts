const pgCode = (error: unknown): unknown =>
  typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;

/** Whether `error` is Postgres's SQLSTATE `code`, raw from postgres.js or wrapped by Drizzle. */
function isPgError(error: unknown, code: string): boolean {
  if (pgCode(error) === code) return true;
  return (
    typeof error === 'object' && error !== null && 'cause' in error && pgCode(error.cause) === code
  );
}

/** A unique-constraint violation. */
export const isUniqueViolation = (error: unknown) => isPgError(error, '23505');

/** A lock asked for with `nowait` that another transaction holds. */
export const isLockNotAvailable = (error: unknown) => isPgError(error, '55P03');
