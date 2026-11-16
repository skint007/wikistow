# WikiStow Web Clipper

The browser extension that saves pages to the WikiStow desktop app, for Chrome, Edge, Brave and Firefox ([ADR 0017](../../docs/adr/0017-web-clipper.md), [privacy](../../docs/web-clipper-privacy.md)). It hands each clip to the desktop app through native messaging; the app makes it a draft.

## Building it

WikiStow builds with Node.js 26 and pnpm 10 (the version in the root `package.json`'s `packageManager`), from the repository's root:

```sh
pnpm install --frozen-lockfile
./node_modules/.bin/vp -C apps/clipper pack
node apps/clipper/scripts/assemble.ts
node apps/clipper/scripts/source.ts        # the source zip, for Mozilla Add-ons
node apps/clipper/scripts/check-source.ts  # it builds dist/firefox exactly
```

That gives, in `apps/clipper/dist`:

| Path | What |
| --- | --- |
| `chrome/`, `wikistow-clipper-<version>-chrome.zip` | The Chrome Web Store's build, for Chrome, Edge and Brave |
| `firefox/`, `wikistow-clipper-<version>-firefox.zip` | Mozilla Add-ons' build |
| `wikistow-clipper-<version>-source.zip` | The Firefox build's source, which Mozilla Add-ons takes with each version: this folder, the workspace's root files and lockfile, and a README saying how its reviewers build it |
| `chrome-test/` | The tests' build: a fixed ID, and access to every site (`<all_urls>`), to clip and take screenshots from the tests' site without the toolbar's click |
| `chrome-keyed/` | Only with `CLIPPER_CHROME_KEY`: the Chrome Web Store's build with the store's public key, so an unpacked copy has the store's ID. Never zipped |

Two settings change the builds (`scripts/builds.ts`):

- `CLIPPER_FIREFOX_ID` sets Firefox's add-on ID, `web-clipper@wikistow.skint007.github.io`; CI takes it from the repository variable of that name. Without it, the Firefox build names a placeholder, which no desktop app trusts. Give `source.ts` the same, so its README names it.
- `CLIPPER_CHROME_KEY` is the extension's public key, from the Chrome Web Store's dashboard (the item's **Package** page, **View public key**), with or without its `BEGIN` and `END` lines. It adds `chrome-keyed/`, and the build prints the ID it gives. The store's own zip never has a `key`.

`check-source.ts` unpacks the source zip in a folder of its own, runs the commands in its README there, and checks they give `dist/firefox` byte for byte, as Mozilla's reviewers compare it. CI's `clipper` job runs it.

The scripts are bundled unminified by `vp pack` (Rolldown): `background.js` from `src/background.ts`, `capture.js` from `src/capture.ts` with Mozilla's Readability, `area.js` from `src/area.ts`, the overlay for a screenshot's area, and `popup.js` from `src/popup/popup.ts`. `scripts/assemble.ts` writes each build's `manifest.json` (`src/manifest.ts`) and copies the popup's page, its styles and the icons. Mozilla's linter warns twice about `innerHTML` in `capture.js`: both are Readability's own, run on a copy of the page made with `document.implementation.createHTMLDocument`, where nothing loads or runs.

## Trying it

Load `dist/chrome-test` unpacked in Chrome or Chromium, or `dist/firefox` as a temporary add-on in Firefox, and start a development build of the desktop app with `--clip-manifests` and `--clip-extension=chrome-extension://mnoeboefdgcplmejicllacedgejajmdo/` (or the Firefox ID), so its manifests name this extension ([desktop](../../docs/desktop.md#clipping-from-your-browser)). A desktop release trusts the Firefox ID already, and Chrome's store ID once it's in `PUBLISHED_EXTENSIONS` (`apps/desktop/src/clip/manifests.ts`); `dist/chrome-keyed`, loaded unpacked, has that ID, so it reaches a release with no flag.

## Tests

- `vp test --project unit apps/clipper`: the store manifests ask for what ADR 0017 lists, and nothing more, and their zips have no key; a screenshot's area is cut in the screen's pixels.
- `pnpm -C apps/clipper e2e`: the tests' build in Chromium against a fake native host (`e2e/fake-host.ts`), after a build.
- `apps/desktop/e2e/clip.spec.ts` clips with the tests' build into the real desktop app, through the real helper.
- `web-ext lint` on the Firefox build, and `scripts/check-source.ts`, in CI's `clipper` job.

## The stores' pictures

`STORE_SCREENSHOTS=1 ./node_modules/.bin/playwright test -c screenshots`, after a build, makes the listings' pictures in `docs/screenshots/clipper` from the tests' build against the fake host: four screenshots at 1280 by 800, the store icon, and Chrome's promo tile and marquee ([the store listing](../../docs/web-clipper-store-listing.md)). Make them again when the popup changes.

## Versions

The extension has versions of its own, in this `package.json`, apart from WikiStow's: the stores take numbers only, and update it apart from the app. Raise it when the extension changes. Each WikiStow release carries the three zips, and a stable release that raises it sends it to both stores ([releasing](../../docs/releasing.md#to-the-stores)); the listings' text is in [the store listing](../../docs/web-clipper-store-listing.md).
