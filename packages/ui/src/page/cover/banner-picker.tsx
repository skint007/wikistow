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

/** An image banner as this app writes it, its height and fade left out where it has none. */
const imageChoice = ({ attachmentId, focal, height, fade }: Extract<Banner, { kind: 'image' }>) =>
  ({
    kind: 'image',
    attachmentId,
    focal,
    ...(height !== undefined && { height }),
    ...(fade !== undefined && { fade }),
  }) satisfies BannerChoice;

/** A 0 to 100 slider for an image banner, which changes the band as it moves. */
function Slider({
  label,
  value,
  valueText,
  ends: [start, end],
  onChange,
}: {
  label: string;
  value: number;
  valueText: string;
  ends: [string, string];
  onChange: (value: number) => void;
}) {
  const id = useId();
  return (
    <div className="grid gap-1">
      <label htmlFor={id} className="text-sm font-bold">
        {label}
      </label>
      <input
        id={id}
        type="range"
        min={0}
        max={100}
        step={1}
        value={value}
        aria-valuetext={valueText}
        onChange={(event) => onChange(Number(event.target.value))}
        className="w-full"
      />
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>{start}</span>
        <span>{end}</span>
      </div>
    </div>
  );
}

/**
 * The Banner popover's content: the theme gradient, the presets, an
 * uploaded image with its focal point, height and fade, and Remove.
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
        <>
          <Slider
            label="Focal point"
            value={banner.focal}
            valueText={`${banner.focal}% from the top`}
            ends={['Top', 'Bottom']}
            onChange={(focal) => onChoose({ ...imageChoice(banner), focal })}
          />
          <Slider
            label="Height"
            value={banner.height ?? 0}
            valueText={`${banner.height ?? 0}% of the way to the tallest`}
            ends={['Short', 'Tall']}
            onChange={(height) => onChoose({ ...imageChoice(banner), height })}
          />
          <Slider
            label="Fade"
            value={banner.fade ?? 0}
            valueText={`${banner.fade ?? 0}% of the banner fades`}
            ends={['None', 'Long']}
            onChange={(fade) => onChoose({ ...imageChoice(banner), fade })}
          />
        </>
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
