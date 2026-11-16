# WikiStow Web Clipper: the store listings

The text and pictures for the Chrome Web Store and Mozilla Add-ons listings of the web clipper (`apps/clipper`, [ADR 0017](adr/0017-web-clipper.md), step 7), ready to paste into each dashboard. Both listings are public, and the Chrome Web Store publisher is a non-trader (ADR 0017, Decided 2026-11-15).

The first version of each is uploaded by hand, **before any release whose desktop app trusts the Firefox ID**: until Mozilla Add-ons holds `web-clipper@wikistow.skint007.github.io`, anyone could claim it and be trusted. So the first zips come from CI, not a GitHub Release: open the newest **CI** run on `main` (**Actions → CI**), download its `build` artifact, and take `clipper/dist/wikistow-clipper-<version>-chrome.zip`, `-firefox.zip` and `-source.zip` from it. Check that the Firefox zip's `manifest.json` names that ID; the repository variable `CLIPPER_FIREFOX_ID` sets it. An artifact is kept for 7 days; run CI on `main` again (**Run workflow**) for a fresh one. The store requirements below were checked on 2026-11-15 against the pages linked; a dashboard's own wording wins where they differ. Later versions go from the release itself, once the stores' keys are set ([releasing](releasing.md#to-the-stores)); the listing text changes only in the dashboards.

## Shared

| Field | Value |
| --- | --- |
| Name | WikiStow Web Clipper (from the manifest) |
| Homepage | https://github.com/skint007/wikistow |
| Support site | https://github.com/skint007/wikistow/issues |
| Support email | Scott's support address |
| Privacy policy | https://github.com/skint007/wikistow/blob/main/docs/web-clipper-privacy.md |
| Licence | MIT |
| Language | English |

### Short description

Chrome's summary is the manifest's `description`, at most 132 characters ([manifest description](https://developer.chrome.com/docs/extensions/reference/manifest/description)). Mozilla's summary may be 250 ([an appealing listing](https://extensionworkshop.com/documentation/develop/create-an-appealing-listing/)); use the same:

> Save links, selections, articles, whole pages and screenshots to your WikiStow desktop app, as drafts.

### Long description

> Clip from any web page into WikiStow, your own encrypted wiki. Choose what to save from the toolbar button, the context menu or a keyboard shortcut:
>
> - **Link**: the page's address and title, with a note.
> - **Selection**: the part of the page you selected, with its links and headings.
> - **Article**: the article alone, without menus and adverts, found as Firefox's Reader View finds it.
> - **Whole page**: everything the page shows.
> - **Visible area** or **Choose an area**: a screenshot of the tab, or of the part you drag out over it.
>
> Give the clip a title and tags, and find the folder it goes in by typing part of its name. WikiStow saves it as a draft, so you can tidy it before you publish it. Its images are saved with it.
>
> **It needs the WikiStow desktop app** on the same computer, signed in to your WikiStow server. The extension sends each clip only to that app, through the browser's native messaging; the app encrypts it and saves it on your server. The extension has no server of its own, keeps no keys or passwords, and has no analytics. If the app is closed, the extension can open it; if it's locked, the clip waits until you unlock it.
>
> The extension asks for no access to websites. It reads a page only when you clip from it, through the browser's `activeTab` permission.
>
> WikiStow is open source: https://github.com/skint007/wikistow

### Screenshots

The same four for both stores, from `docs/screenshots/clipper` (made by `apps/clipper/screenshots`, [README](../apps/clipper/README.md#the-stores-pictures)). Each is 1280 by 800, the size both stores take.

| File | Caption |
| --- | --- |
| `1-article.png` | Save an article to a folder you find by name, with tags. |
| `2-selection.png` | Save just the part of the page you selected. |
| `3-saved.png` | Each clip is a draft in WikiStow, ready to open. |
| `4-area.png` | Take a screenshot of the part of the page you drag over. |

## Chrome Web Store

In the [Developer Dashboard](https://chrome.google.com/webstore/devconsole), **Add new item**, then upload `wikistow-clipper-<version>-chrome.zip`. The first version must be uploaded there; the API only updates an item that exists ([API](https://developer.chrome.com/docs/webstore/api)).

### Account

- **Trader status:** Non-trader. WikiStow is a personal project, with no sales ([trader disclosure](https://developer.chrome.com/docs/webstore/program-policies/trader-disclosure)).
- **Contact email:** Scott's support address, which the Account page asks to verify ([account](https://developer.chrome.com/docs/webstore/set-up-account)).

### Store listing tab

[The listing tab](https://developer.chrome.com/docs/webstore/cws-dashboard-listing):

| Field | Value |
| --- | --- |
| Description | The long description above |
| Category | **Workflow & Planning**: "help users perform their tasks more efficiently" ([categories](https://developer.chrome.com/docs/webstore/best-practices)). There is no Productivity category any more. |
| Language | English |
| Store icon | `store-icon.png`: 128 by 128, the artwork 96 by 96 inside, as [images](https://developer.chrome.com/docs/webstore/images) asks |
| Screenshots | The four above. At least one, at most five, 1280 by 800 or 640 by 400, full bleed with square corners |
| Small promo tile | `promo-small.png`, 440 by 280. Optional, but an item without one is listed after those with one |
| Marquee promo tile | `promo-marquee.png`, 1400 by 560. Optional; without one the item can't be featured in the marquee |
| Video | None |
| Homepage URL | https://github.com/skint007/wikistow |
| Support URL | https://github.com/skint007/wikistow/issues |

### Privacy practices tab

[The privacy tab](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy):

**Single purpose:**

> Save what the person chooses from the current tab (its link, the selected text, the article, the whole page, or a screenshot) as a draft in their WikiStow wiki, through the WikiStow desktop app on the same computer.

**Permission justifications:**

| Permission | Justification |
| --- | --- |
| `nativeMessaging` | The extension sends each clip to the WikiStow desktop app on the same computer, which saves it. Native messaging is the only way it talks to the app; it has no server and sends nothing over the internet. |
| `activeTab` | To read the tab the person clips from, its address and title, and to take its screenshot, only after they press the toolbar button, choose the context menu item or use the shortcut. It gives no access to other tabs or sites. |
| `scripting` | To run the clipping script in that tab when the person clips: it reads the selection, the article or the whole page, or shows the overlay for choosing a screenshot's area. Nothing runs on a page otherwise; there is no content script on every page. |
| `contextMenus` | For "Send link to WikiStow" and "Send selection to WikiStow" in the page's context menu. |
| `storage` | `storage.local` keeps the one setting, which WikiStow app to use; `storage.session` keeps the last folder and the popup's unsaved text until the browser closes. |

**Remote code:** No, I am not using remote code. Every script is in the package, unminified, Readability included.

**Data usage**, the kinds of data it handles: tick **Website content** (the text, images and page content clipped) and **Web history** (the address and title of the page clipped). Leave the rest unticked: it collects no personal or authentication information, no personal communications, location, health or financial information, and no user activity such as clicks or keystrokes. The area overlay reads the mouse only to know the area, and sends only the screenshot.

**Certifications**, all three ticked. Google's pages show them only in pictures, so check the words in the dashboard; they are, as quoted elsewhere:

- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

The data goes only to the person's own desktop app, which the [Limited Use](https://developer.chrome.com/docs/webstore/program-policies/limited-use) policy allows as the item's single purpose.

**Privacy policy URL:** https://github.com/skint007/wikistow/blob/main/docs/web-clipper-privacy.md. Every item that handles user data needs one, even when the data stays on the device ([user data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)).

### Distribution tab

- **Visibility:** Public.
- **Regions:** All regions.
- **Payments:** Free.

The first upload gives the item its ID, which the dashboard shows. It goes in `PUBLISHED_EXTENSIONS.chromium` in `apps/desktop/src/clip/manifests.ts`, as `chrome-extension://<id>/`, so the desktop app trusts it. Its public key (the **Package** page, **View public key**) builds `dist/chrome-keyed`, an unpacked copy with the same ID, for checks by hand ([the clipper's README](../apps/clipper/README.md)).

## Mozilla Add-ons

At [the Developer Hub](https://addons.mozilla.org/developers/addon/submit/distribution), **Submit a New Add-on**, **On this site**, then upload `wikistow-clipper-<version>-firefox.zip` ([submitting](https://extensionworkshop.com/documentation/publish/submitting-an-add-on/)). Its ID is `web-clipper@wikistow.skint007.github.io`, and this first upload claims it for the account.

| Field | Value |
| --- | --- |
| Compatible platforms | Firefox only: untick **Firefox for Android**, which the manifest's `gecko_android` key may tick. Firefox for Android can't clip, having no native messaging, and is out of scope (ADR 0017, decision 9) |
| Source code | **Yes**: upload `wikistow-clipper-<version>-source.zip`. Its README says how to build it, with Node 26 and pnpm rather than the reviewers' Node 24 and npm ([source code submission](https://extensionworkshop.com/documentation/publish/source-code-submission/)) |
| Name | WikiStow Web Clipper |
| Add-on URL | `https://addons.mozilla.org/firefox/addon/wikistow-web-clipper/` |
| Summary | The short description above |
| Description | The long description above |
| Categories | **Bookmarks** and **Other**, at most two. None fits a clipper well ([categories](https://mozilla.github.io/addons-server/topics/api/categories.html)) |
| Tags | None: Mozilla's fixed list has none for notes or clipping |
| Support email | Scott's support address |
| Support website | https://github.com/skint007/wikistow/issues |
| Homepage | https://github.com/skint007/wikistow |
| Licence | MIT |
| Privacy policy | Yes, as it sends data outside the browser. Paste the text of `docs/web-clipper-privacy.md`, with its link above |
| Screenshots | The four above. 1280 by 800 is the largest Mozilla shows, at 1.6 to 1 ([an appealing listing](https://extensionworkshop.com/documentation/develop/create-an-appealing-listing/)) |
| Icon | From the manifest |

The manifest already declares Firefox's [data consent](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/), `websiteContent` and `browsingActivity` as required, which Firefox shows at install.

**Notes for reviewers:**

> The extension saves clips to the WikiStow desktop app, through native messaging (host `io.github.skint007.wikistow`, or `io.github.skint007.wikistow_beta` for the beta). The desktop app installs the host's manifest when it starts. Without the app, the popup only says that clipping needs it, which is the whole of what it can do. To try it fully, install the WikiStow desktop app from https://github.com/skint007/wikistow/releases and sign in to a WikiStow server.
>
> It asks for no host permissions: `activeTab` and `scripting` read the tab only when the person clips. The data sent to the native app (the page's address, title and the chosen content) is declared as `websiteContent` and `browsingActivity`. The privacy policy says what is sent and where.
>
> The build is unminified. The source zip's README.md has the commands; they need Node.js 26 and pnpm 10, not npm, and give `apps/clipper/dist/firefox`, the same files as this upload. Mozilla's Readability is bundled unchanged in `capture.js`, which is where `web-ext lint`'s two `innerHTML` warnings come from: it runs on a copy of the page made with `document.implementation.createHTMLDocument`, where nothing loads or runs.

Mozilla signs it after its automated review, within 24 hours, and a person may review it at any time after ([signing](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/)).
