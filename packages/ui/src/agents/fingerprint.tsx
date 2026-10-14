import { fingerprintGroups } from './model';

/**
 * The enrollment fingerprint, large, in the CLI's groups of four, for the
 * person to compare group by group (protocol section 9.2, step 3). Read out
 * as a whole by assistive technology.
 */
export function Fingerprint({ value }: { value: string }) {
  return (
    <p
      role="img"
      aria-label={`Enrollment fingerprint: ${value}`}
      data-testid="enrollment-fingerprint"
      className="grid grid-cols-5 justify-items-center gap-x-3 gap-y-2 rounded-control bg-muted px-4 py-2 font-mono text-xl font-bold tracking-wider max-[480px]:text-base"
    >
      {fingerprintGroups(value).map((group, index) => (
        <span key={index}>{group}</span>
      ))}
    </p>
  );
}
