# WikiStow desktop app

The desktop app is the same WikiStow you use in the browser, packaged for Linux on x86_64. The Arch package runs on Arch's system Electron (`electron44`), so it is only the app's code. Debian, Ubuntu and Fedora don't package that Electron, so the `.deb` and `.rpm` bring their own copy.

## Install

Each [GitHub Release](https://github.com/skint007/wikistow/releases) has the app as a `.deb`, an `.rpm`, and `wikistow-desktop-<version>.tar.gz`, the archive the Arch package installs ([releasing](releasing.md#the-desktop-downloads)). Once it's installed, start **WikiStow** from your app launcher, or run `wikistow-desktop`. The launcher is named that way because the agent CLI already owns `wikistow`.

The app never updates itself. How you update it depends on the package, as below. When a newer release is out, the app tells you (see [Updates](#updates)). Updating, or removing the package, leaves your sign-in, settings and plugins in `~/.config/WikiStow` as they were. To remove those too, delete that folder yourself.

### Arch Linux

Install [`wikistow-desktop-bin`](https://aur.archlinux.org/packages/wikistow-desktop-bin) from the AUR. It installs the app CI built and tested for the newest release, checked against the release's checksum, and runs it on Arch's `electron44`. With an AUR helper such as `yay` or `paru`:

```sh
yay -S wikistow-desktop-bin
```

Without one, build the package yourself:

```sh
git clone https://aur.archlinux.org/wikistow-desktop-bin.git
cd wikistow-desktop-bin
makepkg -si
```

`pacman -Syu` alone doesn't update AUR packages. Your AUR helper's update, such as `yay -Syu`, does. Without a helper, run `git pull` in that folder and `makepkg -si` again.

### Debian, Ubuntu and Fedora

The `.deb` works on Debian 13, Ubuntu 24.04 and Ubuntu 26.04. The `.rpm` works on Fedora 43 and 44. Releases have them from 0.3.0 on. Download the package and `SHA256SUMS` from the [latest release](https://github.com/skint007/wikistow/releases/latest), check the download, and install it. apt and dnf install what it depends on.

```sh
sha256sum -c --ignore-missing SHA256SUMS
sudo apt install ./wikistow-desktop-<version>-amd64.deb     # Debian, Ubuntu
sudo dnf install ./wikistow-desktop-<version>-x86_64.rpm    # Fedora
```

A package downloaded from GitHub doesn't add a repository, so `apt upgrade` and `dnf upgrade` never see a newer one. To update, download the new release's package and install it the same way; it replaces the old version. To hear about new releases, use **Watch → Custom → Releases** on the [repository](https://github.com/skint007/wikistow). The packages aren't signed. The checksum shows the download matches what the release published.

To remove the app, run `sudo apt remove wikistow-desktop` or `sudo dnf remove wikistow-desktop`. `apt purge` also keeps `~/.config/WikiStow`.

These packages carry their own Electron, so your distribution's security updates don't reach it. Each WikiStow release bundles the newest Electron 44 patch out when it's made, and an Electron security fix is a reason to release ([releasing](releasing.md#the-deb-and-rpm)). Updating the app is how you get those fixes.

Chromium's sandbox helper, `/usr/lib/wikistow-desktop/chrome-sandbox`, is installed setuid root, as Google Chrome's package does. Chromium uses it where it can't sandbox the app with user namespaces, as on Ubuntu 24.04 and later.

### How it was installed

Each package records how it was installed in `/usr/lib/wikistow-desktop/install-source`: one word, `aur`, `deb` or `rpm`, and a newline. The app reads it to tell which package manager updates it. The file belongs to the package, so only root can change it, and it goes when the package does. The path is fixed, so a development build also sees an installed package's file. The app trusts it only when it runs from `/usr/lib/wikistow-desktop`.

### Updates

When a newer stable release is out, a blue dot shows on your avatar, at the bottom of the rail (in a narrow window, on the menu button that opens it too), and the account menu says **Update available**: the new version, the one you have, and how to update. With the AUR package that is your AUR helper; with a `.deb` or `.rpm` it is the new package from the release; when the app can't tell how it was installed, it opens the release page. The link opens the release in your browser, with its notes and downloads. Screen readers hear the avatar as "Account, update available", and the link with the versions and how to update.

The app asks GitHub for the latest release (`api.github.com/repos/skint007/wikistow/releases/latest`) when it starts and every 6 hours. It sends no token and nothing about you or your wiki. GitHub's latest release is never a prerelease, so the app only offers stable releases; running a prerelease such as `0.4.0-rc.1`, you're offered `0.4.0` once it's out. The app keeps the last answer in `~/.config/WikiStow/update.json`, so it still knows offline. A check that fails changes nothing and shows nothing. The browser shows no update notice: updating the desktop app never updates your server.

## The window

The window has no system title bar or menu bar. WikiStow draws its own titlebar across the top of every screen, sign-in included. Drag its empty part to move the window, and double-click it to maximize or restore, as your desktop does with a system title bar. The window resizes from its edges as usual, within a few pixels of each one. On the right are buttons plugins add, **Window menu** (⋯), and **Minimize**, **Maximize** (**Restore** while maximized) and **Close**. Close asks first if a page has changes not saved yet, as closing always has. Tab reaches the titlebar's buttons after the page's own. While a dialog or sheet is open, close it first: the titlebar's buttons wait behind it, though dragging still works.

The window opens at the size and place it was last left, and maximized if it was.

What the old menu bar did is in **Window menu**, and these keys still work:

| Keys | Does |
| --- | --- |
| Ctrl+R, Ctrl+Shift+R or F5 | Reload. With changes not saved yet, it asks first. |
| Ctrl+= and Ctrl+- | Zoom in and out |
| Ctrl+0 | Actual size |
| F11 | Full screen, and back |
| Ctrl+Shift+I or F12 | Developer tools |
| Ctrl+W | Close the window, which quits |
| Ctrl+Q | Quit, which closes the window first |

Cut, copy, paste, undo, redo and select all work in both editors with their usual keys. Ctrl+Shift+Alt+P still restarts the app without plugins. If the window's page ever stops, the app asks whether to reload it or close, since the window has no frame of its own to close it by.

This is tested on X11. On Wayland, moving, double-clicking and resizing depend on the compositor, as they do for any app that draws its own titlebar.

## Signing in

The app asks for your server's address, such as `https://wiki.example.com`, then opens your browser. Sign in there as usual and choose **Sign in to the desktop app**. The browser hands the app back to you through a `wikistow://` link. The first time, your browser may ask whether to open it; allow it.

Each computer gets its own desktop session. You can see them, and sign any of them out, under **Settings → Desktop apps** in the browser.

## The keyring

With GNOME Keyring or KWallet running, the app keeps its sign-in between launches, sealed by the keyring. The unlock page also offers **Remember on this computer**, which opens your vault when the app starts. Locking the vault or signing out forgets the unlock.

The app also keeps your search index in `~/.config/WikiStow/search-index`, encrypted with a key only your unlocked vault has, so the first search after a launch only reads the pages that changed since. Beside it, `trust-marks` keeps, encrypted the same way, the newest contacts record and key versions the app has seen, so it still warns after a relaunch if the server serves older ones. Signing out, or signing in again, deletes both.

Without a keyring the app keeps nothing secret, nor these files. Each launch signs in through the browser again and asks for your vault passphrase. That is on purpose: Electron's fallback store seals data with a key every program on the computer knows, so the app never uses it. Quitting signs that launch's session out, so they don't pile up on the server. If the app crashes, or the server doesn't answer within 3 seconds, the session stays; sign it out under **Settings → Desktop apps**.

On KDE the app uses KWallet. Anywhere else it looks for a Secret Service, such as GNOME Keyring, so Hyprland, Sway or i3 work too once GNOME Keyring runs. To pick one yourself, add a switch such as `--password-store=gnome-libsecret` to `~/.config/wikistow-desktop-flags.conf`. `--password-store=basic` means no keyring.

The app keeps its key in the keyring under its own name. In KWallet that is **WikiStow Safe Storage** in the **WikiStow Keys** folder. Earlier versions used the entry every Chromium-based app shares there, `Chromium Safe Storage` in `Chromium Keys`, so any of those apps could open the app's secrets without a prompt. Leave that entry alone: browsers and other apps may still use it. In GNOME Keyring the key was always the app's own, marked for WikiStow. It is labelled **WikiStow Safe Storage**, or `Chromium Safe Storage` if an earlier version made it.

The first launch after that change, on any desktop, signs in through the browser again and asks for your passphrase. The name doesn't lock other programs out: anything running as you can still ask the keyring for the key.

## While you work on it

```sh
pnpm exec vp -C apps/web build
pnpm exec vp -C apps/desktop pack
pnpm -C apps/desktop start
```

The desktop tests run the real app under a virtual display, with the browser half of each sign-in in Chromium beside it:

```sh
cd apps/desktop && xvfb-run -a -s '-screen 0 1600x1000x24' pnpm exec playwright test
```

The keyring test runs only with `KEYRING=1`, inside a session that has GNOME Keyring. `e2e/with-keyring.sh` sets one up in a CI container; don't run it on your own machine, since it replaces `~/.local/share/keyrings`.

Signing in from a development build needs `wikistow://` links to reach it. With the package installed, they already do: the link starts the packaged app, which finds the development build running on the same profile (`~/.config/WikiStow`) and hands the link over. Without the package, save this as `~/.local/share/applications/wikistow-dev.desktop`, with your checkout's path:

```ini
[Desktop Entry]
Type=Application
Name=WikiStow (development)
Exec=/path/to/wikistow/apps/desktop/node_modules/.bin/electron /path/to/wikistow/apps/desktop %U
NoDisplay=true
MimeType=x-scheme-handler/wikistow;
```

Then make it the handler:

```sh
xdg-mime default wikistow-dev.desktop x-scheme-handler/wikistow
```

## Releasing

The app holds decrypted pages and, if asked, the key to your vault, so an update can read everything you can. Before anyone else installs it:

1. Release only through a tag, as [releasing](releasing.md) describes. CI builds and tests the tagged commit, then publishes the app from that build. Every package installs that same build.
2. Keep the AUR key and any package signing credentials outside this source repository. The AUR key lives only in the repository's `aur` environment.
3. To roll back, revert the change on `main`, let CI pass, and release a new version. It is newer, so it ships as an ordinary update. Reinstalling an older package doesn't stick: the next update brings the bad build back. To hold a computer on the older package until the fix ships, reinstall the older `wikistow-desktop-bin-*.pkg.tar.zst` with `pacman -U` and add `IgnorePkg = wikistow-desktop-bin` to `/etc/pacman.conf`, then remove that line again. AUR packages never enter pacman's cache: AUR helpers keep the packages they built in their own folder, such as `~/.cache/yay/wikistow-desktop-bin`, and `makepkg` leaves them in the folder it ran in. Without one, build the older release's package from the AUR repository's history. With a `.deb` or `.rpm`, install the older release's package with `sudo apt install --allow-downgrades ./<file>.deb` or `sudo dnf downgrade ./<file>.rpm`. It stays until you install a newer one.

The AUR package's version is the release's, such as `0.2.0`. It provides and conflicts with `wikistow-desktop`, the package the old PKGBUILD built from source, so installing it replaces that one. The `.deb` and `.rpm` are `wikistow-desktop` at the release's version, with package release `1`. A prerelease such as `0.3.0-rc.1` becomes `0.3.0~rc.1` there, which apt and dnf sort before `0.3.0`. Later releases must keep versions increasing.

The account menu ends with **What’s new**, which lists every release up to this one with its highlights, and the version running. A release shows its version, as `0.2.0`. A build of any other commit adds the first 8 characters of that commit, as `0.2.0+5b9e5ec4`.
