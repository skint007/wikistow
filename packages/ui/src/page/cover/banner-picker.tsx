import {
  BANNER_PRESETS,
  type Banner,
  type BannerChoice,
  type BannerPreset,
} from '@wikistow/client';
import { ImageUp } from 'lucide-react';
import { useId } from 'react';
import { Button, uploadButtonClass } from '@/components/ui/button';
import { cn } from '@/lib/utils';

// Written out in full so Tailwind finds each class.
const PRESET_CLASS: Record<BannerPreset, string> = {
  sunrise: 'bg-(image:--banner-sunrise)',
  ocean: 'bg-(image:--banner-ocean)',
  meadow: 'bg-(image:--banner-meadow)',
  lavender: 'bg-(image:--banner-lavender)',
  dusk: 'bg-(image:--banner-dusk)',
  stone: 'bg-(image:--banner-stone)',
};

const OPTIONS: { label: string; swatch: string; choice: BannerChoice | null }[] = [
  { label: 'Theme', swatch: 'bg-cover-band', choice: null },
  ...BANNER_PRESETS.map((name) => ({
    label: name[0]?.toUpperCase() + name.slice(1),
    swatch: PRESET_CLASS[name],
    choice: { kind: 'preset', name } as const,
  })),
];

const isCurrent = (banner: Banner, choice: BannerChoice | null) =>
  choice === null
    ? banner.kind === 'theme'
    : choice.kind === 'preset' && banner.kind === 'preset' && banner.name === choice.name;

/**
 * The Banner popover's content: the theme gradient, the presets, an
 * uploaded image with its focal point, and Remove.
 */
export function BannerPicker({
  banner,
  uploading,
  error,
  onChoose,
  onUpload,
}: {
  banner: Banner;
  uploading: boolean;
  error: string | null;
  /** Null goes back to the theme gradient. */
  onChoose: (choice: BannerChoice | null) => void;
  onUpload: (file: File) => void;
}) {
  const focalId = useId();
  return (
    <div className="grid gap-3">
      <h2 className="text-sm font-bold">Banner</h2>
      <div className="grid grid-cols-4 gap-2">
        {OPTIONS.map(({ label, swatch, choice }) => {
          const current = isCurrent(banner, choice);
          return (
            <button
              key={label}
              type="button"
              aria-pressed={current}
              onClick={() => onChoose(choice)}
              className="group grid gap-1 rounded-row text-xs font-bold text-subtle-foreground outline-offset-2 hover:text-foreground"
            >
              <span
                className={cn(
                  'h-9 rounded-row bg-cover ring-offset-2 ring-offset-popover group-active:opacity-80',
                  swatch,
                  current
                    ? 'ring-2 ring-primary'
                    : 'group-hover:ring-2 group-hover:ring-foreground/25',
                )}
              />
              {label}
            </button>
          );
        })}
      </div>
      <label className={uploadButtonClass}>
        <ImageUp className="size-4" strokeWidth={1.75} />
        {uploading ? 'Encrypting…' : 'Upload image'}
        {/* Only the types bannerImage reads, so iOS converts a HEIC photo to JPEG as it's chosen. */}
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          className="sr-only"
          disabled={uploading}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) onUpload(file);
            event.target.value = '';
          }}
        />
      </label>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {banner.kind === 'image' && (
        <div className="grid gap-1">
          <label htmlFor={focalId} className="text-sm font-bold">
            Focal point
          </label>
          <input
            id={focalId}
            type="range"
            min={0}
            max={100}
            step={1}
            value={banner.focal}
            aria-valuetext={`${banner.focal}% from the top`}
            onChange={(event) =>
              onChoose({
                kind: 'image',
                attachmentId: banner.attachmentId,
                focal: Number(event.target.value),
              })
            }
            className="w-full accent-primary"
          />
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>Top</span>
            <span>Bottom</span>
          </div>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Images are resized and encrypted on this device.
      </p>
      {banner.kind !== 'theme' && (
        <Button variant="outline" size="sm" onClick={() => onChoose(null)}>
          Remove banner
        </Button>
      )}
    </div>
  );
}
