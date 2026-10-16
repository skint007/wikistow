import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';

/**
 * A button that chooses a whole folder, on a computer: `onFolder` gets
 * its files, each with its path under the folder's own name in
 * `webkitRelativePath`. Phones can't choose folders, so they see `phone`
 * instead, on a line of their own in a wrapping row. `name` labels the
 * hidden input.
 */
export function ChooseFolder({
  label,
  name,
  phone,
  onFolder,
}: {
  label: string;
  name: string;
  phone: string;
  onFolder: (files: File[]) => Promise<void>;
}) {
  const input = useRef<HTMLInputElement | null>(null);
  const [computer] = useState(() => window.matchMedia('(any-pointer: fine)').matches);
  if (!computer)
    return <p className="order-last basis-full text-sm text-muted-foreground">{phone}</p>;
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => input.current?.click()}>
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
