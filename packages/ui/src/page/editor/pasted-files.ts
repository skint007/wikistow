/**
 * The files a paste attaches: none when it has text as well, unless the
 * text is only the files' names, one to a line, as a file copied in the
 * macOS Finder pastes.
 */
export function pastedFiles(data: Pick<DataTransfer, 'files' | 'getData'> | null): File[] {
  const files = Array.from(data?.files ?? []);
  const text = data?.getData('text/plain') ?? '';
  if (files.length === 0 || text === '') return files;
  const lines = text
    .split(/\r\n?|\n/)
    .filter((line) => line !== '')
    .sort();
  const names = files.map((file) => file.name).sort();
  return lines.length === names.length && lines.every((line, i) => line === names[i]) ? files : [];
}
