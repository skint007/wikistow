---
status: accepted
---

# Mermaid diagrams, drawn in a sandboxed frame

#239 asks for fenced `mermaid` code blocks to show as diagrams, as Joplin, Obsidian and GitHub show them, with a way to see the source. Scott decided they are built into the app, not a plugin, if Mermaid can run under the app's Content Security Policy. This records the spike that checked it and how it is built.

In short:
- Mermaid runs in a hidden `sandbox="allow-scripts"` frame, `/diagram-host.html`, with a policy of its own, as plugin scripts do (ADR 0002).
- The frame returns each diagram as SVG text. The app shows it as `<img src="blob:…">`, which `img-src blob:` allows and where nothing in the SVG runs.
- Mermaid's own single-file build ships with the app under `/assets/mermaid/`, named by its hash so it is cached for good, and loads only when a page shows a diagram.
- A public copy holds each diagram as a PNG that the publisher's app draws.

## Why a frame

The app's policy is `style-src 'self'`. Mermaid puts a `<style>` element in every SVG and sets style attributes while it measures text, and it needs a real document to measure in, so it can't run in a worker. On the app's page the policy refuses its styles and the diagram comes out wrong.

A sandboxed frame without `allow-same-origin` has an opaque origin. Its policy may allow inline styles there without touching the app's. It also keeps the diagram source out of the app's document: Mermaid has had script-injection bugs, and a diagram comes from whoever wrote the page. In the frame such a bug reaches no cookies, no storage, no app document and no network.

## The spike

Run 2026-11-01 against the built app on Mermaid 12.2.0. The frame drew a flowchart, a sequence diagram, a class diagram, a Gantt chart, a pie chart, a mind map, a label holding `<img src=x onerror=…>`, and a diagram that doesn't parse:

| Where | Result |
| --- | --- |
| Chromium (Playwright) | All drew, sized from their viewBox, no policy violation. The hostile label showed as text. The parse error came back as Mermaid's message. |
| Firefox (Playwright) | The same. |
| WebKit (Playwright, in the CI image) | The same. |
| Desktop app, `app://wikistow` (Electron 44, in the CI image) | The same. Chromium accepts `script-src` naming the app's two files under `app://wikistow`. The frame has no `wikistowDesktop` bridge. |

In every one the frame's own `fetch` of the app's API and of another host failed, and it could read no cookie, `localStorage` or parent document. Its first diagram took about 0.5 s with Mermaid loading, later ones 30 to 150 ms.

Things the spike found:
- The frame must be laid out, not `display: none`. In a hidden frame Mermaid can't measure text: sequence and class diagrams fail ("svg element not in render tree") and others get negative sizes. It sits off screen with `visibility: hidden` instead.
- Mermaid sizes its SVG to its container (`width="100%"` and a `max-width` style). As an image that is 150 px wide, so the frame sets `width` and `height` from the viewBox before returning it.
- Labels are drawn as SVG text (`htmlLabels: false`), not HTML in `foreignObject`, and in system fonts. An SVG image can't load the app's web fonts, and the frame measures with the same fonts the image draws with.
- The frame's scripts must be classic scripts. A module script or `import()` from the frame's opaque origin is a cross-origin request, which the app's same-origin resource policy refuses, so Mermaid's chunked ES build can't be used. Its single-file build (`mermaid.min.js`, 5.5 MB, 1.6 MB gzipped) is copied in at build time. Both scripts are sent with `Cross-Origin-Resource-Policy: cross-origin`, as the plugin host's is.
- The server answers a file outside `/assets` in full each time (`no-cache`, and no 304), and the server doesn't compress. So Mermaid's build goes under `/assets/mermaid/<hash>.js`, cached for good like the app's other built files, and the build writes `/diagram-host.html` naming it. The frame's policy names the folder, `/assets/mermaid/`, which holds nothing else.

The spike's code is kept outside the repo, in `~/.cache/wikistow-tmp/mermaid/kept/`.

## Decisions

1. **The frame and its policy.** `/diagram-host.html` loads Mermaid from `/assets/mermaid/<hash>.js`, then `/diagram-host.js`. It is sent with `default-src 'none'`, Mermaid's folder and the host script named in `script-src` with the app's origin (`app://wikistow` in the desktop app), `style-src 'unsafe-inline'`, `frame-ancestors 'self'` and `sandbox allow-scripts`, and without `X-Frame-Options` (`securityHeadersFor` in `packages/contracts/src/security.ts`). The app's own policy doesn't change: `frame-src 'self'` and `img-src blob:` already allow it.
2. **One frame, made when needed.** The app makes the frame for the first diagram, which is when Mermaid loads, and removes it after a minute with nothing to draw (`packages/ui/src/page/diagrams.ts`). If the frame spends over ten seconds on one diagram, timed from when it starts it, that diagram and any waiting behind it fail and the frame is replaced. Loading Mermaid has two minutes of its own, for a slow line. User journeys are drawn with their text as SVG text too (`journey.textPlacement`), since their default HTML text keeps a canvas from exporting the PNG a public copy needs. Mermaid runs on the frame's own thread, so a diagram that loops would freeze the tab in Firefox and WebKit (see ADR 0002). Mermaid's own limits (`maxTextSize`, `maxEdges`) keep that unlikely, and pages come from people the reader trusts.
3. **Theme.** A diagram is drawn with Mermaid's `dark` theme when the palette's `color-scheme` is dark, otherwise `default`, and drawn again when the palette changes.
4. **Reader and editor.** In the reader the block shows its diagram under its `mermaid` label, with a button to show the source instead and the copy button; a diagram that doesn't draw shows its source and Mermaid's reason. In the visual editor the block stays code, with its diagram under it, drawn again once typing pauses. Drawn diagrams are cached with the other decrypted queries and dropped when the vault locks.
5. **Public pages.** The server renders public pages and runs no Mermaid. The publisher's app draws each diagram in the light theme, paints it at twice its size on a white ground (so it reads on the dark palette too) and sends it as a PNG, a file of the copy's own with a new ID. The copy's Markdown has `<img src="attachment:…" alt="Diagram" width="…">` in place of the block, at the diagram's own width, then the source in a `<details>` titled **Diagram source**. The server's renderer now keeps an image's numeric `width`, as the app's reader does, so `READER_VERSION` is 3. A diagram that doesn't draw stays as written. A PNG, not the SVG, because the server shows only raster images inline (ADR 0005, decision 7), and an SVG file of the copy's would need its own checks.

## Considered options

- **A plugin block.** Scott decided against it: every server and every page should have diagrams with nothing to install.
- **Rendering on the app's page with the styles moved into a stylesheet.** Mermaid's styles are per diagram and generated at run time; there is no fixed stylesheet to ship, and its text measuring still writes style attributes.
- **Inline SVG in the page.** The policy refuses the SVG's `<style>`, and the SVG would be in the app's document.
- **SVG files for public copies.** Smaller and sharp at any size, but ADR 0005 shows only raster images inline, and an SVG opened on its own runs script unless the server sends it with a policy that stops it. A PNG needs no server change.
