// Apart from the worker host, which reaches the app's pages, so a unit test can read it.

/**
 * Why the app refused a message from a script: its first problem, such as
 * a block's field ID the app doesn't take. A field of a kind, or with a
 * key, this app doesn't know is most likely from a newer SDK, so that says
 * to update, naming the field; so does a kind of message it doesn't know.
 */
export function refusal(
  data: unknown,
  issues: readonly { code: string; path: readonly PropertyKey[]; message: string }[],
): string {
  const [issue] = issues;
  if (!issue) return 'Its script sent a message the app doesn’t accept.';
  const newer = 'it may need a newer WikiStow.';
  const [top, part, field] = issue.path;
  if (issue.code === 'invalid_union' && issue.path.length === 1 && top === 'type') {
    const type = (data as { type?: unknown }).type;
    const named = typeof type === 'string' ? `, “${type.slice(0, 40)}”,` : '';
    return `Its script sent a kind of message${named} this app doesn’t know: ${newer}`;
  }
  const unknown = (at: number) =>
    (issue.code === 'invalid_union' && issue.path[at] === 'type' && issue.path.length === at + 1) ||
    (issue.code === 'unrecognized_keys' && issue.path.length >= at);
  if (top === 'block' && part === 'fields' && typeof field === 'string' && unknown(3)) {
    const block = (data as { block?: { type?: unknown } }).block?.type;
    const named = typeof block === 'string' ? `block “${block}”` : 'a block';
    return `Its script’s ${named} has a field, “${field}”, this app can’t draw: ${newer}`;
  }
  if (top === 'inline' && part === 'field' && unknown(2)) {
    const span = (data as { inline?: { type?: unknown } }).inline?.type;
    const named = typeof span === 'string' ? `inline code “${span}”` : 'inline code';
    return `Its script’s ${named} has a field this app can’t draw: ${newer}`;
  }
  return `Its script sent a message the app doesn’t accept (${[...issue.path, issue.message].join(': ')}).`;
}
