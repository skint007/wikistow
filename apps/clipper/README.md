# WikiStow Web Clipper

The browser extension that saves pages to the WikiStow desktop app, for Chrome, Edge, Brave and Firefox ([ADR 0017](../../docs/adr/0017-web-clipper.md), [privacy](../../docs/web-clipper-privacy.md)). It hands each clip to the desktop app through native messaging; the app makes it a draft.

## Building it

WikiStow builds with Node.js 26 and pnpm 10 (the version in the root `package.json`'s `packageManager`), from the repository's root:

```sh
pnpm install --frozen-lockfile
./node_modules/.bin/vp -C apps/clipper pack
node apps/clipper/scripts/assemble.ts
```

That gives, in `apps/clipper/dist`:

| Path | What |
| --- | --- |
| `chrome/`, `wikistow-clipper-<version>-chrome.zip` | The Chrome Web Store's build, for Chrome, Edge and Brave |
| `firefox/`, `wikistow-clipper-<version>-firefox.zip` | Mozilla Add-ons' build |
| `chrome-test/` | The tests' build: a fixed ID, and access to every site (`<all_urls>`), to clip and take screenshots from the tests' site without the toolbar's click |

`CLIPPER_FIREFOX_ID` sets Firefox's add-on ID. Without it, the Firefox build names a placeholder, which no desktop app trusts.

The scripts are bundled unminified by `vp pack` (Rolldown): `background.js` from `src/background.ts`, `capture.js` from `src/capture.ts` with Mozilla's Readability, `area.js` from `src/area.ts`, the overlay for a screenshot's area, and `popup.js` from `src/popup/popup.ts`. `scripts/assemble.ts` writes each build's `manifest.json` (`src/manifest.ts`) and copies the popup's page, its styles and the icons. Mozilla's linter warns twice about `innerHTML` in `capture.js`: both are Readability's own, run on a copy of the page made with `document.implementation.createHTMLDocument`, where nothing loads or runs.

## Trying it

Load `dist/chrome-test` unpacked in Chrome or Chromium, or `dist/firefox` as a temporary add-on in Firefox, and start a development build of the desktop app with `--clip-manifests` and `--clip-extension=chrome-extension://mnoeboefdgcplmejicllacedgejajmdo/` (or the Firefox ID), so its manifests name this extension ([desktop](../../docs/desktop.md#clipping-from-your-browser)).

## Tests

- `vp test --project unit apps/clipper`: the store manifests ask for what ADR 0017 lists, and nothing more; a screenshot's area is cut in the screen's pixels.
- `pnpm -C apps/clipper e2e`: the tests' build in Chromium against a fake native host (`e2e/fake-host.ts`), after a build.
- `apps/desktop/e2e/clip.spec.ts` clips with the tests' build into the real desktop app, through the real helper.
- `web-ext lint` on the Firefox build, in CI's `clipper` job.

## Versions

The extension has versions of its own, in this `package.json`, apart from WikiStow's: the stores take numbers only, and update it apart from the app. Raise it when the extension changes. Each WikiStow release carries both zips; sending them to the stores is step 7 of ADR 0017.
