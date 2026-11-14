# WikiStow Web Clipper: privacy

The WikiStow Web Clipper is a browser extension for Chrome, Edge, Brave and Firefox. It saves what you choose from a web page to the WikiStow desktop app on the same computer, which saves it as a draft in your own WikiStow. This page says what the extension reads, what it sends, and where.

## What it sends, and where

The extension sends only to **the WikiStow desktop app on your computer**, through the browser's native messaging: the browser starts a small program installed with the app, `wikistow-clip-host`, which passes the messages to the running app on your computer. The extension has no server of its own and sends nothing over the internet. Nothing goes to WikiStow's developers, the stores, or anyone else. There are no analytics, no tracking and no advertising.

When you clip, it sends the app:

- the tab's address and title;
- what you chose to clip from that tab: the link (with any text you selected, and your note), the selected part of the page, the article Mozilla's Readability finds in it, or the whole page, each as HTML and as its plain text, and for an article its byline and site's name;
- the title, tags and folder you chose in the popup.

The desktop app encrypts the clip and saves it, as a draft, on the WikiStow server you signed in to, which is yours or your organisation's. The app downloads the clip's images itself, from the sites they're on, without your cookies.

To show you where a clip can go, the extension asks the app for folders matching what you type, and the five folders clips went to last. It asks the app how it is (closed, starting, locked, signed out, ready, offline) when you open the popup, every few seconds while the popup is open and the app is starting, locked or signed out, and before each clip, saying the extension's version and which kind of browser it's in. When you choose **Open WikiStow**, it asks the app to open or come forward, and when you choose **Open in WikiStow**, to show the draft it just saved.

## What it reads

The extension reads a page only when you clip from it: when you press its toolbar button, choose **Send link to WikiStow** or **Send selection to WikiStow** in the context menu, or use its keyboard shortcuts. Then it reads only that tab, through the browser's `activeTab` permission. It doesn't read the pages you visit otherwise, and has no access to any site until you clip from it.

## What it keeps

- **On disk:** only its own setting, which WikiStow app to use if you run both the stable app and the beta.
- **For the browser's session,** in memory, gone when the browser closes (`storage.session`): the folder your last clip went to, with its name, so the next clip can go there too; what you typed in the popup, if it closed before you saved; and how your last clip went, with the saved page's title and folder.

It keeps no keys, passwords or tokens, and no folder names on disk.

## Its permissions

| Permission | Why |
| --- | --- |
| `nativeMessaging` | To send clips to the WikiStow desktop app on your computer. |
| `activeTab` | To read the tab you clip from, only when you clip. |
| `scripting` | To read that tab's page, its selection, article or whole page, when you clip. |
| `contextMenus` | For **Send link to WikiStow** and **Send selection to WikiStow**. |
| `storage` | For its setting, and what it keeps for the browser's session. |

It asks for no access to websites (no host permissions).

## Firefox's data consent

Firefox asks you to agree, when you install it, that the extension sends **website content** and **browsing activity**: Mozilla counts anything sent outside the browser, even to a program on your own computer, as transmitted. What's sent, and to where, is as above.

## Questions

The extension and the app are open source: [github.com/skint007/wikistow](https://github.com/skint007/wikistow). How the extension and the app talk is decided in [ADR 0017](adr/0017-web-clipper.md). Questions and reports go in the repository's issues.
