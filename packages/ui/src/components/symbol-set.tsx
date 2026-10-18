import { Icon, type LucideIconData } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

// Every icon in the set, read from Lucide's own files, which hold each
// icon's name and older names beside its drawing. The package lists icons
// otherwise only as components, named in another case, or as one import
// each, which would split the set into a chunk per icon.
const modules = import.meta.glob<{ __iconData?: LucideIconData }>(
  ['../../node_modules/lucide-react/dist/esm/icons/*.mjs', '!**/index.mjs'],
  { eager: true },
);

/** One icon of the set: its name, the words it's found by, and its drawing. */
export type SetIcon = { name: string; words: string; data: LucideIconData };

/** The set, each icon once, by name. */
export const SYMBOL_LIST: readonly SetIcon[] = Object.values(modules)
  .flatMap(({ __iconData: data }) =>
    data?.name
      ? [
          {
            name: data.name,
            words: [data.name, ...(data.aliases ?? [])].join(' ').replaceAll('-', ' '),
            data,
          },
        ]
      : [],
  )
  .sort((a, b) => a.name.localeCompare(b.name));

// An icon Lucide renamed is found by its old name too.
const BY_NAME = new Map(
  SYMBOL_LIST.flatMap((icon) =>
    [icon.name, ...(icon.data.aliases ?? [])].map((name) => [name, icon.data] as const),
  ),
);

/** An icon of the set in the text colour (`SymbolIcon`), or `fallback` for a name the set doesn't have. */
export default function DrawnSymbol({
  name,
  fallback,
  label,
  className,
}: {
  name: string;
  fallback: ReactNode;
  label?: string | undefined;
  className?: string | undefined;
}) {
  const data = BY_NAME.get(name);
  if (!data) return fallback;
  return (
    <Icon
      icon={data}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
      strokeWidth={1.75}
      className={cn('size-[1.2em] shrink-0 text-foreground', className)}
    />
  );
}
