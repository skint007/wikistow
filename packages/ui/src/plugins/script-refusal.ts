// Apart from the worker host, which reaches the app's pages, so a unit test can read it.

/**
 * Why the app refused a message from a script: its first problem, such as
 * a block's field ID the app doesn't take. A field of a kind, or with a
 * key, this app doesn't know is most likely from a newer SDK, so that says
 * to update, naming the field.
 */
export function refusal(
  data: unknown,
  issues: readonly { code: string; path: readonly PropertyKey[]; message: string }[],
): string {
  const [issue] = issues;
  if (!issue) return 'Its script sent a message the app doesn’t accept.';
  const [top, part, field, key] = issue.path;
  const unknown =
    (issue.code === 'invalid_union' && key === 'type' && issue.path.length === 4) ||
    (issue.code === 'unrecognized_keys' && issue.path.length >= 3);
  if (top === 'block' && part === 'fields' && typeof field === 'string' && unknown) {
    const block = (data as { block?: { type?: unknown } }).block?.type;
    const named = typeof block === 'string' ? `block “${block}”` : 'a block';
    return `Its script’s ${named} has a field, “${field}”, this app can’t draw: it may need a newer WikiStow.`;
  }
  return `Its script sent a message the app doesn’t accept (${[...issue.path, issue.message].join(': ')}).`;
}
