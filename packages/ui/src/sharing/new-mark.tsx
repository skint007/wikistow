/**
 * "New: not in your contacts yet", beside someone this app has never seen
 * (section 8.3), so a look-alike of a contact doesn't read the same as the
 * contact. Put it outside any truncated text, so it never cuts off.
 */
export function NewMark() {
  return (
    <span className="inline-block rounded-full bg-status-draft px-1.5 text-[11px] font-bold whitespace-nowrap text-status-draft-foreground">
      new: not in your contacts yet
    </span>
  );
}
