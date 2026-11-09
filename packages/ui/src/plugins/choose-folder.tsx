import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';

/**
 * A button that chooses a whole folder, on a computer: `onFolder` gets
 * its files, each with its path under the folder's own name in
 * `webkitRelativePath`. With `onPick`, the button calls that instead, to
 * choose it another way (the File System Access picker). Phones can't
 * choose folders, so they see `phone` instead, on a line of their own in
 * a wrapping row. `name` labels the hidden input.
 */
export function ChooseFolder({
  label,
  name,
  phone,
  onFolder,
  onPick,
}: {
  label: string;
  name: string;
  phone: string;
  onFolder: (files: File[]) => Promise<void>;
  onPick?: (() => void) | undefined;
}) {
  const input = useRef<HTMLInputElement | null>(null);
  const [computer] = useState(() => window.matchMedia('(any-pointer: fine)').matches);
  if (!computer)
    return <p className="order-last basis-full text-sm text-muted-foreground">{phone}</p>;
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        onClick={() => (onPick ? onPick() : input.current?.click())}
      >
        {label}
      </Button>
      <input
        ref={(element) => {
          input.current = element;
          // Not in React's types: lets the person choose a whole folder.
          element?.setAttribute('webkitdirectory', '');
        }}
        type="file"
        hidden
        aria-label={name}
        onChange={(event) => {
          const files = [...(event.target.files ?? [])];
          // So choosing the same folder again, once it is fixed, sends it again.
          event.target.value = '';
          if (files.length > 0) void onFolder(files);
        }}
      />
    </>
  );
}

/** A chosen file's path from the chosen folder's top. */
export const pathInFolder = (file: File) =>
  // The chosen folder's own name comes first.
  file.webkitRelativePath.split('/').slice(1).join('/') || file.name;

/** A folder input's files, each with its path from the chosen folder's top and as the person sees it. */
export const folderFiles = (files: File[]) =>
  files.map((file) => ({
    file,
    shown: file.webkitRelativePath || file.name,
    path: pathInFolder(file),
  }));
