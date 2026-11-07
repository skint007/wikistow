import type { ComponentProps, ReactNode, Ref } from 'react';
import { cn } from '@/lib/utils';
import { Place, type PlaceInputs } from '../plugins/places';
import type { ShownPage } from '../plugins/runtime';
import { FindBar, type PageFind, PageFindContext } from './find/find-bar';

/*
 * A page's layout and the places plugins draw into in it, which the page
 * and the workshop's preview (#257) both draw, so the preview shows a
 * plugin where the app would.
 */

/**
 * The page's card, scrolling within the window; its body fills what the
 * cover band leaves. Its width, not the window's, decides whether the
 * table of contents fits beside the page. It holds what's absolutely
 * placed in it, such as `sr-only` text, which would otherwise stretch the
 * window to wherever it sits in a long page.
 */
export function PageCard({
  children,
  find,
  label,
  ref,
}: {
  children: ReactNode;
  /** Find on page for what it shows, with its bar over the page (#276). */
  find?: PageFind;
  label?: string;
  ref?: Ref<HTMLElement>;
}) {
  return (
    <article
      ref={ref}
      data-region="page"
      aria-label={label}
      className="@container relative flex h-full min-h-0 flex-col overflow-y-auto rounded-card bg-card shadow-card"
    >
      {find ? (
        <PageFindContext value={find}>
          <FindBar find={find} />
          {children}
        </PageFindContext>
      ) : (
        children
      )}
    </article>
  );
}

/** The page's toolbar, over its cover band. Props go to its element, so it can anchor a popover. */
export function PageToolbar({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      {...props}
      data-region="page.toolbar"
      className={cn(
        'glass absolute inset-x-4 top-4 z-10 flex flex-wrap items-center gap-2 rounded-control px-3 py-2 text-sm max-[899px]:inset-x-3 max-[899px]:top-3 max-[899px]:gap-1 max-[899px]:px-2',
        className,
      )}
    />
  );
}

/**
 * The page's column, as wide as the card, with plugins' headers above
 * `children` and their footers below; and beside it, where the card is
 * wide enough, its contents and plugins' asides; where it isn't, the
 * asides go below. `className` sets its top padding.
 */
export function PageColumns({
  shown,
  contents,
  className,
  children,
}: {
  shown: ShownPage;
  contents: PlaceInputs['page.aside']['contents'];
  className: string;
  children: ReactNode;
}) {
  return (
    <div
      data-region="page.body"
      className={cn(
        'flex w-full flex-1 flex-wrap gap-10 px-11 pb-10 @min-[960px]:flex-nowrap max-[899px]:px-[18px] max-[899px]:pb-8',
        className,
      )}
    >
      <div data-region="page.content" className="flex min-w-0 flex-1 flex-col gap-4">
        <Place name="page.header" shown={shown} />
        {children}
        <Place name="page.footer" shown={shown} />
      </div>
      <Place name="page.aside" shown={shown} contents={contents} />
    </div>
  );
}
