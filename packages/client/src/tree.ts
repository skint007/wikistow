// Walking the folder tree as a server lists it.

/**
 * The folder `rootId` and every folder under it, by the parent links in
 * `folders`: what moves with it, and so where it can't go (section 10).
 * Pages never hold anything, so a page moves alone.
 */
export function foldersUnder(
  folders: readonly { id: string; parentId: string | null }[],
  rootId: string,
): Set<string> {
  const under = new Set<string>([rootId]);
  for (let grew = true; grew;) {
    grew = false;
    for (const f of folders) {
      if (f.parentId !== null && under.has(f.parentId) && !under.has(f.id)) {
        under.add(f.id);
        grew = true;
      }
    }
  }
  return under;
}
