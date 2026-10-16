---
status: proposed
---

# Image icons for folders and pages

People want a picture, a logo or a small drawing as a folder's or page's icon instead of an emoji (#49). This ADR settles where the image lives, how its key reaches everyone who can see it, the limits, and how the picker offers it. Nothing here changes the server.

In short: a folder's image is stored inside the folder's own encrypted metadata, so it travels with the folder's name and needs no new key handling. A page's image is one of the page's attachments, named from `wikistow.cover`, the way an image banner already works. Every image is resized in the browser to at most 144 px and stored as WebP (or JPEG or PNG where the browser can't write WebP), so SVG never reaches storage. Each icon is uploaded where it is used; there is no shared icon library. Older clients, and any image that fails to load, show the emoji.

## What the code supports today

- **Blobs belong to pages.** A blob row has a non-null `pageId` (a foreign key to the node, deleted with it) and a `draft` or `published` audience (`packages/server/src/db/schema/blobs.ts`). Uploads need edit rights at a page (`uploadBlob` calls `requirePage`), a blob is committed only when a page revision lists it in `blobRefs` (`attachBlobs`), and a reader may download only a published blob listed in the page's current reader history (`downloadBlob`, `readerMayRead`). Unlisted blobs are swept after a day. Folder metadata has no `blobRefs`, so the server can't store, keep or serve a blob for a folder without new tables and rules.
- **Folder metadata is already readable by everyone who sees the folder.** `NodeMetadata` is a loose object with an `extensions` map (`packages/client/src/metadata.ts`). Its content key is wrapped under the share's published key (class `metadata`, protocol section 6.2), so readers, editors, owners and agents of the share open it; in the owner region it is sealed to each owner. Moves rewrap every retained metadata version's key (section 10), a new co-owner gets every one (section 7.6), and Shared with me opens a share root's metadata with the published key (section 7.7). `reviseMetadata` carries extensions it doesn't know into the next version, so older clients and the CLI keep them through a rename.
- **The tree carries every folder's current metadata.** `GET /api/spaces/:spaceId/tree` returns each folder's head version sealed (`FolderSummary`), and `loadTree` opens them all. Metadata versions are never compacted; draft revisions are, after 30 days (`sweepDrafts`).
- **Page covers already name attachments.** `wikistow.cover` holds `emoji` and `banner`, and an image banner names one of the version's attachments by ID (`packages/client/src/cover.ts`). Its key stays in `attachments[]`, publishing re-encrypts it with the rest, `coverOf` falls back when the attachment isn't listed, `reviseCover` keeps fields it doesn't know, and a copy into another space drops a banner it leaves behind (`bannerLeftBehind`). The sidebar already opens each page's shown version for its title and emoji (`pageLabels`).
- **Images are shown from `blob:` URLs.** The CSP allows `img-src 'self' blob:`. Decrypted attachments become `blob:` URLs revoked at lock (`vaultStore.objectUrl`), loaded through `decryptedQuery` (`packages/ui/src/page/attachments.tsx`). Banners are resized and re-encoded in the browser before upload (`banner-image.ts`), which also strips EXIF.
- **The picker is shared.** `EmojiPopover` (`packages/ui/src/page/cover/emoji-picker.tsx`) is used by the page badge and by the folder look fields and dialog (`packages/ui/src/shell/folder-look.tsx`, #48).

## Decisions

### 1. Where a folder's image lives, and how its key reaches people

**Options**

- **A. Inside the folder's metadata (recommended).** The resized image goes in `extensions['wikistow.icon']`:

  ```
  { format: 1, mediaType: "image/webp" | "image/jpeg" | "image/png", data: base64url }
  ```

  Its key is the metadata's key, so it reaches exactly the people who can read the folder's name, readers included, with nothing new. Key rotation needs nothing: like the name, the next save is wrapped under the new key version, and removed people keep what they could already read (section 7.5). Moves and new co-owners need nothing beyond the rewrap they already do. Shared with me can show it. No server change.

  The cost is size. Each folder's current metadata comes with every tree load, so a folder with an image adds its bytes there (about 1.8 times the image, since the image is base64 inside JSON that is encrypted and sent as base64 again): 2 to 12 KB for the icons measured below, up to about 29 KB at the 16 KB cap. The tree is fetched again whenever the window regains focus and after most changes, and the server doesn't compress responses, so 30 folders with images cost a few hundred KB per fetch. Every metadata version also keeps its own copy (a rename or colour change copies the image), and metadata versions are never compacted; folders change rarely, so that part stays small.

- **B. A folder-owned encrypted blob.** The image is a blob, and the metadata extension holds its key and hash. The tree stays small and the cap could be larger. But the server needs: blobs that can belong to a folder, an upload route for one, metadata versions that list blobs (a `metadata_revision_blobs` table) so the sweep keeps them, a download rule that lets readers of the folder fetch it, and a migration. The protocol's rule that key material lives only in `attachments[].key` (section 5.5) gains an exception. It is one more request per folder per session too.

- **C. Reuse a page's blob** (a hidden page per folder, or a page's attachment). Hidden pages would show up everywhere pages are listed, and a page's audience and access rules don't match a folder's.

**Recommendation: A.** It is the only option with no server work and no new key path, and the size cost is small for icons this size. If tree size ever matters, B can replace it later behind the same `wikistow.icon` namespace (a `format: 2` that holds a blob reference).

Removing a folder's image writes `wikistow.icon: null`, since `reviseMetadata` merges extensions and has no way to delete a key. Readers treat anything that isn't a valid icon as no image.

### 2. A page's image

**Options**

- **A. An attachment named from `wikistow.cover` (recommended).** The cover gains `icon: { attachmentId }`, a loose object beside `emoji` and `banner`. It works like an image banner: upload as a draft attachment, list it in `attachments[]`, publish re-encrypts it, readers download the published copy, a move doesn't touch it, and a copy into another space drops it when it leaves the attachment behind (generalise `bannerLeftBehind`). `coverOf` returns it only when the version lists the attachment. The sidebar gets the ref from the version `pageLabels` already opens and downloads the blob through `decryptedQuery`.
- **B. Inside the cover extension, like folders.** No download for the sidebar, but every page version carries the image. Autosave writes a version per save, kept for 30 days, so an image of 5 KB is uploaded and stored again on every save.

**Recommendation: A.** Pages are saved often and folders rarely, which is why the two differ. A page icon costs one small download per page in the sidebar. Its query keeps the `blob:` URL until the vault locks (`gcTime: Infinity`; `decryptedQuery` today keeps the default five minutes, after which it decrypts again and makes a new URL while the old one lives until lock). The attachment is hidden from the attachment list as the banner's is (`hiddenAttachment` becomes a list), and export writes it out as an attachment, as it does a banner.

### 3. Uploading each time, or a per-space icon library

**Options**

- **A. Upload each time (recommended).** Each folder or page holds its own copy. Choosing the same picture twice means choosing the file twice.
- **B. A per-space library.** A new encrypted record listing the space's icons. Its key would have to reach everyone who can see any folder or page using an icon, and the space's shares have different members: an owner-region library can't be read by a share's readers, so each icon would still need copying into each region that uses it. That is a new record type, new sealing rules and new server storage for a convenience.

**Recommendation: A.** With icons of a few KB the copies cost nothing that matters. If people ask for reuse, a later "recent images" row in the picker can copy the bytes of icons the person can already see, with no new record.

### 4. Size, type, downscaling, and SVG

**Recommendation.**

- **Accepted files:** PNG, JPEG, WebP, GIF and SVG, up to 25 MB and 50 megapixels, the banner's limits. An animated GIF keeps one frame.
- **Resized in the browser** to fit within 144 by 144 px, its shape kept: twice the 72 px page badge, the largest place an icon shows. A raster image is never enlarged; an SVG is always drawn to fit 144 px, since icon sets declare sizes like 24 px and browsers report a default size for an SVG that declares none. Tiles and the page badge show it filling their square (`object-cover`), so a wide image shows its middle; the full image is kept, so the display can change later without uploading again. A sidebar page row, which has no tile, shows it as a 20 px rounded square where the emoji was.
- **Encoded afresh** as WebP at quality 0.85, which also drops EXIF and other metadata. A browser that can't write WebP hands back PNG (`banner-image.ts` handles the same case; Safari has been one). Then an opaque image is stored as JPEG and one with transparency as PNG, so logos keep their clear background on the folder's tint.
- **At most 16 KB encoded.** Past that, it is drawn again at 96 px; still past it, it is refused with a plain message. The spike's 144 px results were 1 to 7 KB as WebP or JPEG; only PNG of a busy photo reached 40 KB, and a photo is opaque, so it gets JPEG. The cap is low because every tree fetch carries each folder's image.
- **SVG is rasterised, never stored.** The browser draws it from a `blob:` URL into an `<img>`, then onto a canvas, and stores the result like any other image. Browsers never run an SVG's scripts or fetch what it links to when it is shown in an `<img>`, as the avatar code already relies on. `createImageBitmap` refuses SVG in all three engines, so this path uses `<img>`. An SVG with `<foreignObject>` taints the canvas in Chromium and WebKit, which then refuse to export it; the app says that SVG can't be used. Because only raster images are ever stored, there is no sanitiser and no CSP change.
- **Readers check what they show.** `mediaType` must be one of the three, and `data` must decode to at most 16 KB (16,384 bytes); anything else counts as no image.

### 5. Fallback

- **Older clients** ignore `wikistow.icon` and `cover.icon` and keep both when they save: metadata extensions are carried, and `reviseCover` keeps fields it doesn't know. A folder shows its emoji on its tint (⭐ on blue by default); a page shows its emoji, or none. An older client lists a page's icon in the attachment list, since it only hides the banner; deleting it there removes the icon, and newer clients fall back to the emoji. An older client can't replace an image, though: picking a new emoji there changes only the fallback, and newer clients keep showing the image. Updating fixes that; nothing in the design needs to.
- **A newer client that can't show the image** (a shape it doesn't accept, an attachment the version doesn't list, a failed download or decode) shows the emoji, using the image's `onError` as the avatar does.
- **Choosing an image keeps the emoji** as it was, so the fallback is the person's last emoji (recommended). Choosing an emoji removes the image. **Remove image** removes only the image, so the emoji shows again. For a page, replacing or removing the image also drops its attachment from `attachments[]`, as a replaced banner's is (`apply` in `use-cover-editor.ts`). A folder's **Back to ⭐ on blue** removes the image too, so the button shows whenever the folder has an image, not only when its emoji or tint differs (`sameLook` in `folder-look.tsx` counts the image).

  The other way, choosing an image clears the emoji, leaves older clients showing ⭐ for folders and nothing for pages. It is slightly simpler to explain, but loses a fallback the person chose.

### 6. Quota and storage cost

- A page icon is a blob counted against its uploader, like any attachment: a few KB, at most 16 KB. Later versions list the same blob, so it is stored about once per audience: a draft copy, and a published copy that later publishes reuse (section 12).
- A folder icon counts against the author of each metadata version that holds it, as metadata does today, once per version.
- On the wire, the tree grows by about 1.8 times each folder image, and the sidebar downloads each page icon once until the vault locks.

At the default 5 GiB quota none of this is noticeable. No new limit is needed beyond the 16 KB cap.

### 7. How the picker gains an image tab

`EmojiPopover` gains an optional `image` prop: `{ current: string | null; onPick: (file: File) => Promise<void>; onRemove?: () => void }`, with `current` a `blob:` URL. When given, the popover shows two toggle buttons at the top, **Emoji** and **Image**, opening on the kind in use. The Image tab has **Upload an image…** (a file input with the accepted types), the current image with **Remove image** when there is one, and one line: "PNG, JPEG, WebP, GIF or SVG. It’s resized to fit." Picking a file keeps the tab open while the caller prepares and stores it (showing Encrypting… for a page, as the banner picker does), shows a refusal there if `onPick` rejects, and closes once it resolves. So pages and folders share the tab and its messages, and keep their own saving:

- **Pages:** the cover editor resizes, uploads as a draft attachment and sets `cover.icon`, the way `upload` sets a banner, with saves waiting for it (`handle.track`).
- **Folders:** `FolderLookFields` keeps the prepared image in the dialog until **Save** writes the metadata, in the New folder dialog (`createFolder`'s look gains an optional image) and in **Emoji and colour…**. The 48 px tile shows the image on the tint, which shows through a transparent image. The colour swatches keep showing the emoji, so the colour choice stays visible, and the tint still matters for the fallback.

The image shows wherever the emoji shows now: the sidebar's folder and page rows, the folder look tiles and the page badge. A shared `IconImage` component draws the `blob:` URL and falls back to the emoji. Page icons get their URL from `decryptedQuery`, kept until lock as above. A folder's bytes come with the tree, so its URL is cached by the metadata version's ID the same way, not made again on each tree fetch, which would pile up URLs until the vault locks. Space icons (rail, space header) and the Shared with me page's folder looks (it shows a generic icon today) can use the same field and component later; they are out of scope.

## Spike evidence (2026-10-16)

A throwaway page served with the app's real CSP (`img-src 'self' blob:`), run in Playwright's Chromium 153, Firefox 155 and WebKit 26.6 (WebKit in the CI Playwright image). Each image was decoded from a `blob:` URL into an `<img>`, drawn into a canvas fitting 144 px, and encoded. Sizes in bytes.

| Image | Chromium WebP / JPEG / PNG | Firefox WebP / JPEG / PNG | WebKit WebP / JPEG / PNG |
| --- | --- | --- | --- |
| Busy 1200×900 photo (synthetic, noisy) | 4106 / 4969 / 38353 | 6262 / 6662 / 39727 | 6710 / 6683 / 39554 |
| Logo SVG, transparent | 2956 / 3681 / 5164 | 2504 / 3633 / 4539 | 2380 / 3752 / 1936 |
| Logo PNG 256 px, transparent | 3294 / 3701 / 5687 | 2810 / 3656 / 5280 | 3408 / 3692 / 4935 |
| App icon PNG 512 px | 2996 / 3928 / 11466 | 2330 / 4095 / 8692 | 2860 / 4163 / 5435 |
| Screenshot PNG 1280×720 | 1074 / 1776 / 3409 | 862 / 2117 / 1800 | 1338 / 2142 / 1739 |

| Question | Chromium | Firefox | WebKit |
| --- | --- | --- | --- |
| SVG decodes in an `<img>` under the CSP | yes | yes | yes |
| `createImageBitmap` on an SVG blob | refused | refused | refused |
| Canvas export after drawing an SVG with `<foreignObject>` | refused (tainted) | allowed | refused (tainted) |

Playwright's Linux WebKit writes WebP; Safari on Apple systems may not, which is why the JPEG and PNG fallbacks stay.

## Considered options

- **A folder-owned blob** (1B) and **an image inside every page version** (2B), above.
- **A per-space icon library** (3B), above.
- **Storing SVG and sanitising it.** It would need a sanitiser and care with `blob:` SVG documents. Rasterising is one code path for every type, and an icon is shown at 20 to 72 px, where vector sharpness hardly shows.
- **Cropping to a square on upload.** Simpler to draw, but a logo would lose its sides for good. Keeping the shape and cropping only on display keeps the choice open.

## Consequences

- The protocol spec's section 5.5 gains the `wikistow.icon` metadata extension and the cover's `icon` field, with the reader rules above. Section 5.5's key-material rule is unchanged: the folder image has no key of its own, and the page image's key stays in `attachments[]`.
- The tree response grows with folder images, by about 1.8 times each image.
- `ui-design.md` describes the picker's Image tab, where icons show, and the fallback.
- Nothing changes on the server, and no migration is needed.

## Decisions for Scott

1. A folder's image lives inside its encrypted metadata (`wikistow.icon`), not as a server blob. Recommended.
2. A page's image is an attachment named from `wikistow.cover` (`icon: {attachmentId}`). Recommended.
3. Each icon is uploaded where it is used; no per-space library. Recommended.
4. Images are resized to fit 144 px, stored as WebP (JPEG or PNG where WebP can't be written), at most 16 KB; SVG is rasterised, never stored. Recommended. The cap is the number to change if folder images should be sharper or the tree smaller.
5. Choosing an image keeps the emoji as the fallback for older clients and failed loads. Recommended.

## Implementation, in pull requests

1. **The picker's Image tab and folder images.** Client: `wikistow.icon` schema, `folderIconOf`, writing and removing it, `createFolder` taking an image. UI: `iconImage` beside `banner-image.ts` (sharing its header reader and fitting), `EmojiPopover`'s Image tab, `FolderLookFields` and both folder dialogs, `IconImage` with the emoji fallback, the sidebar's folder rows. Spec section 5.5 and `ui-design.md`. Evidence: screenshots of the picker's tab, the folder dialog and the sidebar, at desktop and phone sizes; a temporary browser check that a reader of a shared folder sees its image, that SVG is rasterised and a `<foreignObject>` SVG is refused with its message, and that a folder whose icon is damaged shows its emoji; the existing metadata tests showing an older-shaped revision keeps the extension. No new permanent tests unless one meets the testing standard.
2. **Page images.** Client: `cover.icon` in `Cover`, `coverOf`, `reviseCover`, the generalised left-behind check for copies into another space, and the icon's ref and audience in `PageLabel`, and in the sidebar entry the draft session writes after a save (`use-draft-session.ts`), so a new icon shows at once. UI: the cover editor's image upload, the badge, the sidebar's page rows through `decryptedQuery`, hiding the icon from the attachment list. Spec and `ui-design.md`. Evidence: screenshots of the badge and sidebar; a temporary check that a reader sees the image after publish and not before, that a copy into another space leaves it out, and that a version whose icon attachment is gone shows the emoji; the existing cover unit tests updated where `Cover` changes. No new permanent tests unless one meets the testing standard.

PR 2 needs PR 1's Image tab and `IconImage`. Neither touches the server.
