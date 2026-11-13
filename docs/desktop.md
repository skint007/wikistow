# WikiStow desktop app

The desktop app is the same WikiStow you use in the browser, packaged for Linux on x86_64, for Windows on x64 and Arm, and for macOS. The Arch package runs on Arch's system Electron (`electron44`), so it is only the app's code. Debian, Ubuntu and Fedora don't package that Electron, so the `.deb` and `.rpm` bring their own copy, as the Windows and Mac apps do.

## Install

Each [GitHub Release](https://github.com/skint007/wikistow/releases) has the app as a `.deb`, an `.rpm`, `wikistow-desktop-<version>.tar.gz`, the archive the Arch package installs, a Windows installer for each architecture, and a zip for each kind of Mac ([releasing](releasing.md#the-desktop-downloads)). On Linux, once it's installed, start **WikiStow** from your app launcher, or run `wikistow-desktop`. The launcher is named that way because the agent CLI already owns `wikistow`. On Windows, see [Windows](#windows); on a Mac, see [macOS](#macos).

The app never updates itself. How you update it depends on the package, as below. When a newer release is out, the app tells you (see [Updates](#updates)). Updating, or removing the package, leaves your sign-in, settings and plugins in `~/.config/WikiStow` (on Windows, `%APPDATA%\WikiStow Desktop`, apart from the CLI's `%APPDATA%\wikistow`; on a Mac, `~/Library/Application Support/WikiStow`) as they were. To remove those too, delete that folder yourself.

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

To try each release before it's stable, install [`wikistow-desktop-beta-bin`](https://aur.archlinux.org/packages/wikistow-desktop-beta-bin). It takes betas and stable releases alike, and its update notice offers betas ([releasing](releasing.md#beta-and-stable)). It installs beside `wikistow-desktop-bin`, so you can have both: start **WikiStow Beta** from your app launcher, with a violet icon, or run `wikistow-desktop-beta`. The beta is an app of its own. It keeps its sign-in, settings and plugins in `~/.config/WikiStow Beta`, its key in the keyring as **WikiStow Beta Safe Storage**, and its extra switches in `~/.config/wikistow-desktop-beta-flags.conf`, so you sign in to it separately, and both can run at once. It signs in through `wikistow-beta://` links, which servers handle from 0.23.0-beta.2 on; with an older server, the browser opens the stable app instead, and the beta can't sign in. The CLI has `wikistow-cli-beta-bin` too, which installs beside `wikistow-cli-bin` as `wikistow-beta`.

### Debian, Ubuntu and Fedora

The `.deb` works on Debian 13, Ubuntu 24.04 and Ubuntu 26.04. The `.rpm` works on Fedora 43 and 44. Install it from WikiStow's package repository, so the app updates with the rest of your system, or download it from a release.

#### From the repository

WikiStow's apt and dnf repositories, at `https://skint007.github.io/wikistow`, hold the newest stable release ([releasing](releasing.md#the-apt-and-dnf-repositories)). Betas aren't in them. Add the repository once, then install the app. apt and dnf install what it depends on.

On Debian and Ubuntu:

```sh
sudo install -d -m 755 /etc/apt/keyrings
sudo wget -qO /etc/apt/keyrings/wikistow.asc https://skint007.github.io/wikistow/wikistow.asc
sudo wget -qO /etc/apt/sources.list.d/wikistow.sources https://skint007.github.io/wikistow/wikistow.sources
sudo apt update
sudo apt install wikistow-desktop
```

On Fedora:

```sh
sudo curl -fsSLo /etc/yum.repos.d/wikistow.repo https://skint007.github.io/wikistow/wikistow.repo
sudo dnf install wikistow-desktop
```

The first time, dnf asks twice whether to import the key, once for the repository and once for the package. Say yes both times when its fingerprint is `3059 DE56 0FA2 DC27 146F 5940 D358 0799 A108 71D8`. On Debian and Ubuntu, `gpg --show-keys /etc/apt/keyrings/wikistow.asc` shows the same fingerprint.

apt and dnf check every update against that key: apt checks the repository's signed index, and dnf both the signed index and the signature on the `.rpm` itself. From then on, `sudo apt update && sudo apt upgrade` or `sudo dnf upgrade --refresh` updates the app, as do GNOME Software and other update tools. Keep the two files' names: the app looks for `/etc/apt/sources.list.d/wikistow.sources` or `/etc/yum.repos.d/wikistow.repo` to tell you how to update ([updates](#updates)).

To stop using the repository, delete those files, and on Debian and Ubuntu `/etc/apt/keyrings/wikistow.asc` too. On Fedora, `sudo rpmkeys --delete 3059DE560FA2DC27146F5940D3580799A10871D8` removes the key dnf imported.

#### From a release

Each release has the packages from 0.3.0 on, betas too. Download the package and `SHA256SUMS` from the [latest release](https://github.com/skint007/wikistow/releases/latest), check the download, and install it:

```sh
sha256sum -c --ignore-missing SHA256SUMS
sudo apt install ./wikistow-desktop-<version>-amd64.deb     # Debian, Ubuntu
sudo dnf install ./wikistow-desktop-<version>-x86_64.rpm    # Fedora
```

A package downloaded from GitHub doesn't add a repository, so `apt upgrade` and `dnf upgrade` never see a newer one. To update, download the new release's package and install it the same way; it replaces the old version. Or add the repository. To hear about new releases, use **Watch → Custom → Releases** on the [repository](https://github.com/skint007/wikistow). The release's packages aren't signed. The checksum shows the download matches what the release published.

To remove the app, run `sudo apt remove wikistow-desktop` or `sudo dnf remove wikistow-desktop`. `apt purge` also keeps `~/.config/WikiStow`.

These packages carry their own Electron, so your distribution's security updates don't reach it. Each WikiStow release bundles the newest Electron 44 patch out when it's made, and an Electron security fix is a reason to release ([releasing](releasing.md#the-deb-and-rpm)). Updating the app is how you get those fixes.

Chromium's sandbox helper, `/usr/lib/wikistow-desktop/chrome-sandbox`, is installed setuid root, as Google Chrome's package does. Chromium uses it where it can't sandbox the app with user namespaces, as on Ubuntu 24.04 and later.

### Windows

The app runs on Windows 10 and 11 on x64, and Windows 11 on Arm. Download the installer for your computer from the [latest release](https://github.com/skint007/wikistow/releases/latest): `wikistow-desktop-<version>-x64-setup.exe` for most PCs, or `wikistow-desktop-<version>-arm64-setup.exe` for Windows on Arm, such as a Snapdragon laptop. **Settings → System → About** shows which you have, under **System type**. The x64 app also runs on Windows 11 on Arm, more slowly.

The installer isn't signed yet (#325), so the first time Windows shows **Windows protected your PC**. Choose **More info**, check that the app is the installer you downloaded and the publisher is **Unknown publisher**, then choose **Run anyway**. To check the download first, compare `Get-FileHash .\wikistow-desktop-<version>-x64-setup.exe` in PowerShell with its line in the release's `SHA256SUMS`.

It installs for you alone, with no administrator prompt, into `%LOCALAPPDATA%\Programs\WikiStow Desktop`, beside the CLI's `%LOCALAPPDATA%\Programs\wikistow` if you have it. It adds **WikiStow** to the Start menu, registers `wikistow://` links for signing in, and lists the app under **Settings → Apps** (**Installed apps** on Windows 11, **Apps & features** on Windows 10), where **Uninstall** removes it.

To update, download the new release's installer and run it; it replaces the old version. Close WikiStow first, or the installer asks you to. Windows shows the SmartScreen prompt again for each new installer.

### macOS

The Mac app runs on macOS 13 Ventura or newer, with one download for each kind of Mac: `wikistow-desktop-<version>-macos-arm64.zip` for Apple silicon (M1 and later) and `wikistow-desktop-<version>-macos-x64.zip` for Intel. Releases after 0.21.0 have them. Install it with Homebrew, or download it yourself.

With [Homebrew](https://brew.sh), from WikiStow's own tap, which picks the download for your Mac and checks it:

```sh
brew install --cask skint007/wikistow/wikistow
```

`brew upgrade wikistow` updates it, and `brew uninstall --cask wikistow` removes it. `brew uninstall --zap --cask wikistow` also deletes your sign-in, settings and plugins.

Or download the zip for your Mac and `SHA256SUMS` from the [latest release](https://github.com/skint007/wikistow/releases/latest), check the download with `shasum -a 256 -c --ignore-missing SHA256SUMS`, open the zip, and drag **WikiStow** into **Applications**. To update, do the same with the new release's zip and replace the old app. To remove it, drag it to the Trash.

#### The first time it opens

The app isn't signed by an Apple developer or notarized, so macOS won't open it until you allow it, whether it came from Homebrew or the release page. Both mark the download as coming from the internet. The first time:

1. Open **WikiStow** from Applications. macOS says "“WikiStow.app” Not Opened", as Apple could not verify it is free of malware, and offers **Done** or **Move to Trash**. Choose **Done**.
2. Open **System Settings → Privacy & Security**. Under Security, beside "“WikiStow.app” was blocked to protect your Mac", choose **Open Anyway**, and confirm with your password or Touch ID.
3. Open WikiStow again and choose **Open Anyway** once more. From then on it opens like any other app.

Each update is a new download, so macOS asks again the first time it opens. Instead of those steps, you can take away the mark in Terminal after installing or updating, which tells macOS you trust it:

```sh
xattr -d com.apple.quarantine /Applications/WikiStow.app
```

The app is signed ad hoc, which Apple silicon needs before it runs anything, but that names nobody: the checksum is what shows the download matches what the release published.

On a Mac the app keeps your sign-in, settings and plugins in `~/Library/Application Support/WikiStow`.

### How it was installed

Each Linux package records how it was installed in `/usr/lib/wikistow-desktop/install-source`: one word, `aur`, `deb` or `rpm`, and a newline. The app reads it to tell which package manager updates it. The file belongs to the package, so only root can change it, and it goes when the package does. The path is fixed, so a development build also sees an installed package's file. The app trusts it only when it runs from `/usr/lib/wikistow-desktop`. A `.deb` or `.rpm` from the repository is the same package as the release's, so the app also looks for the repository's file, `/etc/apt/sources.list.d/wikistow.sources` or `/etc/yum.repos.d/wikistow.repo`, and with it says to update with apt or dnf. The repository holds stable releases only, so for a newer beta it still points to the download.

The Windows installer writes `windows` to `resources\install-source`, beside the app's `app.asar`. The install folder is yours to change, so that file only decides what the update notice says.

The Mac app carries its own, `WikiStow.app/Contents/Resources/install-source`, beside its `app.asar`, which says `mac`, however it was installed.

### Updates

When a newer release is out, a blue dot shows on your avatar, at the bottom of the rail (in a narrow window, on the menu button that opens it too), and the account menu says **Update available**: the new version, the one you have, and how to update. With the AUR package that is your AUR helper; with the [repository](#from-the-repository) added, `apt upgrade` or `dnf upgrade --refresh`; with a `.deb` or `.rpm` alone it is the new package from the release; on Windows, the new installer, which the link downloads in your browser, x64 or Arm as the app you have is; on a Mac it is the new zip, or `brew upgrade wikistow`; when the app can't tell how it was installed, it opens the release page. Otherwise the link opens the release in your browser, with its notes and downloads. Screen readers hear the avatar as "Account, update available", and the link with the versions and how to update.

The app asks GitHub for its newest releases (`api.github.com/repos/skint007/wikistow/releases`) when it starts and every 6 hours. It sends no token and nothing about you or your wiki. It offers the newest stable release. On the beta channel, it offers the newest release of any kind, betas included: the app is on it when it is a beta itself, such as `0.4.0-beta.1`, or installed with `wikistow-desktop-beta-bin`, whose `/usr/lib/wikistow-desktop/channel` says `beta`. A beta installed from a release's downloads leaves the channel once you install a stable release over it. The app keeps the last answer in `update.json` in its data folder, so it still knows offline. A check that fails changes nothing and shows nothing. The browser shows no update notice: updating the desktop app never updates your server.

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

This is tested on X11 and on Windows 11. On Wayland, moving, double-clicking and resizing depend on the compositor, as they do for any app that draws its own titlebar. On Windows, dragging the titlebar to the top or a side of the screen snaps the window there, and Windows+Arrow keys snap it too. Snap layouts, the grid shown when you hover over a maximize button, only come with Windows' own window buttons, so they don't show here; Windows+Z still opens them.

### On a Mac

The window has the system's close, minimize and zoom buttons at the left of WikiStow's titlebar, in place of its own buttons and **Window menu** (⋯). The rest of the titlebar works as above. The app has a menu bar, as Mac apps do: **WikiStow** (About, Hide, Quit), **Edit**, **View** and **Window**. The keys are Cmd in place of Ctrl:

| Keys | Does |
| --- | --- |
| Cmd+R or Cmd+Shift+R | Reload. With changes not saved yet, it asks first. |
| Cmd+= and Cmd+- | Zoom in and out |
| Cmd+0 | Actual size |
| Ctrl+Cmd+F | Full screen, and back |
| Alt+Cmd+I | Developer tools |
| Cmd+M | Minimize |
| Cmd+H | Hide WikiStow |
| Cmd+W | Close the window, which quits |
| Cmd+Q | Quit, which closes the window first |

Cut, copy, paste, undo, redo and select all are Cmd+X, C, V, Z, Shift+Z and A, through the Edit menu. Ctrl+Shift+Alt+P restarts the app without plugins, as elsewhere. Closing the window quits the app, rather than leaving it running with no window as many Mac apps do.

## Signing in

The app asks for your server's address, such as `https://wiki.example.com`, then opens your browser. Sign in there as usual and choose **Sign in to the desktop app**. The browser hands the app back to you through a `wikistow://` link (`wikistow-beta://` for the [beta](#arch-linux)). The first time, your browser may ask whether to open it, as Edge does with "This site is trying to open WikiStow"; choose **Open**. On Linux the app's launcher entry claims those links, on Windows the installer does, and on a Mac the app does once it has opened.

Each computer gets its own desktop session. You can see them, and sign any of them out, under **Settings → Desktop apps → Review** in the browser.

If the server stops answering as WikiStow, say because its address moved, the app says so and names it, with **Try again** and **Sign out on this computer**. Signing out offers the same when it can't reach the server. Signing out on this computer forgets the session, your remembered unlock, the kept files below and the server's address, without asking the server, and then asks for a server, so you can sign in to another. The old session stays on the server until it expires, or until you sign it out there under **Settings → Desktop apps**.

## The keyring

On Windows the app seals what it keeps with Windows' own data protection (DPAPI), under a key tied to your Windows account, so there is nothing to set up, and it keeps what this section describes as a keyring would. Another person signed in to the same PC can't open it; programs you run can, as with a keyring.

On a Mac the app keeps its key in your login Keychain, as **WikiStow Safe Storage**, and everything below works as with a Linux keyring. The first launch adds the key without asking. The app is signed ad hoc, so each update counts as a different app to the Keychain: the first launch after an update asks for your Mac password to let WikiStow use its key there, before its window opens. Enter it and choose **Always Allow**. With **Deny**, the app keeps nothing and signs in at every launch, as with no keyring. Removing the key in Keychain Access makes the next launch sign in again.

On Linux, with GNOME Keyring or KWallet running, the app keeps its sign-in between launches, sealed by the keyring. The unlock page also offers **Remember on this computer**, which opens your vault when the app starts. Locking the vault or signing out forgets the unlock.

The app also keeps your search index in `search-index` in its data folder, encrypted with a key only your unlocked vault has, so the first search after a launch only reads the pages that changed since. It keeps it only while Keep for offline is on Every page; with Pages I open it deletes it and keeps the index in memory. Beside it, `trust-marks` keeps, encrypted the same way, the newest contacts record and key versions the app has seen, so it still warns after a relaunch if the server serves older ones, and opens your vault offline from that record. Signing out, or signing in again, deletes both.

Pages are kept for offline in `kept`, one encrypted file for each version, image or tree, named so a listing shows no page IDs. **Keep for offline** in Settings picks every page, which is where the app starts, or only the pages you open. The app keeps them current while it is online, and opens a kept version from the folder rather than downloading it again. `kept-account` names the account they belong to, unencrypted. `unlock` keeps, unencrypted, what unlocking reads before your vault opens: the server's last answer about your account, its installation ID, and your vault's wrapper as of the last time you unlocked online. The wrapper is the copy the server keeps: your vault key locked by your passphrase and by your recovery key. Signing out deletes them all, as does signing in to another account; signing in again to the same account keeps them. When the server stops answering, the app shows **Offline** and goes on reading them. The app also starts offline: your remembered unlock opens the vault, or your passphrase does. If you changed your passphrase on another device since this one last unlocked online, use the old one; once the server answers, the app locks and asks for the new one. Signing out offline offers **Sign out on this computer**, as above.

Drafts you edit, and pages and folders you make, while the server doesn't answer wait in `queue`, encrypted like the kept pages, one file for each page or folder and each file you attach, kept with or without a keyring. The app sends them once the server answers, and lists any it can't, such as a page someone changed or deleted meanwhile, with what you can do. Closing the app with changes waiting is safe. Signing out deletes them, and asks first; the sign-in page warns before signing in to another account deletes them.

Without a keyring the app keeps nothing secret, nor these files, apart from `kept-account` and `queue`: the pages it opens are kept in memory until it quits, it can't start offline, and Settings says **Keep for offline** needs a keyring. Each launch signs in through the browser again and asks for your vault passphrase. That is on purpose: Electron's fallback store seals data with a key every program on the computer knows, so the app never uses it. Quitting signs that launch's session out, so they don't pile up on the server. If the app crashes, or the server doesn't answer within 3 seconds, the session stays; sign it out under **Settings → Desktop apps**.

On KDE the app uses KWallet. Anywhere else it looks for a Secret Service, such as GNOME Keyring, so Hyprland, Sway or i3 work too once GNOME Keyring runs. To pick one yourself, add a switch such as `--password-store=gnome-libsecret` to `~/.config/wikistow-desktop-flags.conf` (`wikistow-desktop-beta-flags.conf` for the beta). `--password-store=basic` means no keyring.

The app keeps its key in the keyring under its own name. In KWallet that is **WikiStow Safe Storage** in the **WikiStow Keys** folder. Earlier versions used the entry every Chromium-based app shares there, `Chromium Safe Storage` in `Chromium Keys`, so any of those apps could open the app's secrets without a prompt. Leave that entry alone: browsers and other apps may still use it. In GNOME Keyring the key was always the app's own, marked for WikiStow. It is labelled **WikiStow Safe Storage**, or `Chromium Safe Storage` if an earlier version made it.

The first launch after that change, on any desktop, signs in through the browser again and asks for your passphrase. The name doesn't lock other programs out: anything running as you can still ask the keyring for the key.

## Clipping from your browser

The WikiStow browser extension will save pages from Chrome, Edge, Brave and Firefox to the app, as drafts ([ADR 0017](adr/0017-web-clipper.md)). The extension isn't published yet, and the app doesn't save clips yet: what this section describes is the part built so far, which lets an extension reach the app. **Settings → Browser clipping** turns it on or off on this computer; it starts on.

**The helper.** Every package installs a small program beside the app, `wikistow-clip-host` (`wikistow-clip-host.exe` on Windows), which the browser starts when the extension asks. It passes messages between the browser and the running app, and starts the app when it's closed, outside the browser, so closing the browser doesn't close WikiStow. It holds no keys and keeps nothing. It's in `/usr/lib/wikistow-desktop` (`/usr/lib/wikistow-desktop-beta` for the beta), beside `WikiStow.exe` in the Windows install folder, and in `WikiStow.app/Contents/MacOS`. The Windows installer waits for it to close too, as it does for the app: close the extension's popup, or the browser, if it says a browser is clipping.

**The browsers' manifests.** A browser starts only a program a manifest names, and lets only the extensions it names use it. At each launch, with Browser clipping on, the app writes one for each browser it finds, for you alone, naming the helper and only the published extensions, and fixes any that changed:

| Browser | Linux | macOS (in `~/Library/Application Support`) | Windows |
| --- | --- | --- | --- |
| Chrome | `~/.config/google-chrome/NativeMessagingHosts/` | `Google/Chrome/NativeMessagingHosts/` | the `HKCU\Software\Google\Chrome\NativeMessagingHosts` key |
| Chromium | `~/.config/chromium/NativeMessagingHosts/` | `Chromium/NativeMessagingHosts/` | `HKCU\Software\Chromium\…` |
| Edge | `~/.config/microsoft-edge/NativeMessagingHosts/` | `Microsoft Edge/NativeMessagingHosts/` | `HKCU\Software\Microsoft\Edge\…` |
| Brave | `~/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts/` | `BraveSoftware/Brave-Browser/NativeMessagingHosts/` | `HKCU\Software\BraveSoftware\Brave-Browser\…` |
| Firefox | `~/.mozilla/native-messaging-hosts/` | `Mozilla/NativeMessagingHosts/` | `HKCU\Software\Mozilla\…` |

Each is a file named `io.github.skint007.wikistow.json` (`io.github.skint007.wikistow_beta.json` for the beta, which never touches the stable app's). On Linux and macOS the app writes it only where the browser keeps its profiles (for Firefox, `~/.mozilla` or `~/.config/mozilla`, or on a Mac `Firefox`), so a browser installed later gets one at the app's next launch. On Windows it writes every key, which costs nothing where a browser is missing, each naming a file in `%APPDATA%\WikiStow Desktop\native-messaging`. Until the Chrome Web Store gives the extension its ID, only Firefox's is written. A Mac app opened where it was unzipped, rather than from Applications, writes none: macOS runs it from a temporary place it later removes, and Settings says to move it into Applications. Chromium browsers installed as a Flatpak or a snap can't start the helper, and nor can Chrome where a policy turns off per-user hosts.

**The socket.** While Browser clipping is on, the app listens for the helper on a Unix socket, in `$XDG_RUNTIME_DIR/wikistow` (`wikistow-beta`) on Linux, or in a `clip` folder in its data folder on a Mac or without `$XDG_RUNTIME_DIR`, a folder only you can open; on Windows on a named pipe, `\\.\pipe\wikistow-clip-<random>`. It writes the socket's name and a new random token to `clip-host.json`, which only you can read, in its data folder, or on Windows in `%LOCALAPPDATA%\WikiStow Desktop`, and deletes it when it quits. The helper and the app each prove they hold the token before anything else crosses. Other people's accounts can't read the token, and the app sends them nothing; no web page can reach a socket or a pipe; the app opens no network port. A program you run can still read the token and use the socket as the extension would, as it can ask the keyring for the key ([the keyring](#the-keyring)): the [protocol](../wikistow/protocol.md) (A14) says what that allows.

**Turning it off** closes the socket, deletes `clip-host.json`, and deletes the manifests and keys the app wrote. Turning it on writes them again.

**What removing the app leaves.** The Windows uninstaller deletes the keys, the manifests and `clip-host.json`. Uninstalling the Homebrew cask deletes the Mac manifests; `brew upgrade` does too, and the app writes them again when it next opens. On Linux, and for a Mac app dragged to the Trash, the manifests stay in your home folder. They name a helper that's gone, so the browser can't start it, and the extension says the app isn't installed. To remove them, delete the files the table names; Settings → Browser clipping, turned off before removing the app, deletes them too.

## While you work on it

```sh
pnpm exec vp -C apps/web build
pnpm exec vp -C apps/desktop pack
pnpm -C apps/desktop start
```

The browser clipper's helper is Go, in `apps/desktop/clip-host`. With Go installed, `scripts/clip-host.sh`, from `apps/desktop`, builds it for every system a package ships on into `out/clip-host`, and `go test ./...` in `clip-host` runs its tests against a fake app. A development build listens on its socket, but writes no browser manifests unless started with `--clip-manifests`, so it doesn't take the installed app's, and never deletes them, even with Browser clipping off. With the switch, they name the helper `scripts/clip-host.sh` built. `--clip-extension=chrome-extension://<id>/`, or a Firefox add-on ID, adds an extension to that launch's manifests, as the desktop tests do for theirs (`e2e/clip.spec.ts`); the next launch without it takes it out.

The desktop tests run the real app under a virtual display, with the browser half of each sign-in in Chromium beside it:

```sh
cd apps/desktop && scripts/clip-host.sh && xvfb-run -a -s '-screen 0 1600x1000x24' pnpm exec playwright test
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

On a Mac, a development build doesn't receive `wikistow://` links: they go to an installed WikiStow.app, which hands them to no other copy. To try signing in, build the app and open that instead. On a Mac, from `apps/desktop` after the build above, with `arm64` or `x64`:

```sh
node scripts/asar.ts
scripts/macos-app.sh "$(node ../../scripts/version.ts)" arm64 out/macos
open out/macos/WikiStow.app
```

The launch check CI runs on that app: `MAC_APP="$PWD/out/macos/WikiStow.app" pnpm exec playwright test`.

## Releasing

The app holds decrypted pages and, if asked, the key to your vault, so an update can read everything you can. Before anyone else installs it:

1. Release only through a tag, as [releasing](releasing.md) describes. CI builds and tests the tagged commit, then publishes the app from that build. Every package installs that same build.
2. Keep the AUR key, the Homebrew tap's key and any package signing credentials outside this source repository. The AUR key lives only in the repository's `aur` environment, the tap's in its `homebrew` environment, and the apt and dnf repositories' signing key in its `packages` environment.
3. To roll back, revert the change on `main`, let CI pass, and release a new version. It is newer, so it ships as an ordinary update. Reinstalling an older package doesn't stick: the next update brings the bad build back. To hold a computer on the older package until the fix ships, reinstall the older `wikistow-desktop-bin-*.pkg.tar.zst` with `pacman -U` and add `IgnorePkg = wikistow-desktop-bin` to `/etc/pacman.conf`, then remove that line again. AUR packages never enter pacman's cache: AUR helpers keep the packages they built in their own folder, such as `~/.cache/yay/wikistow-desktop-bin`, and `makepkg` leaves them in the folder it ran in. Without one, build the older release's package from the AUR repository's history. With a `.deb` or `.rpm`, install the older release's package with `sudo apt install --allow-downgrades ./<file>.deb` or `sudo dnf downgrade ./<file>.rpm`. Without the [repository](#from-the-repository), it stays until you install a newer one. With it, hold the app back too, until the fix ships: `sudo apt-mark hold wikistow-desktop`, then `sudo apt-mark unhold wikistow-desktop`, or on Fedora add `excludepkgs=wikistow-desktop` to `/etc/yum.repos.d/wikistow.repo`, then remove that line again. On Windows, run the older release's installer, which replaces the app the same way. On a Mac, replace WikiStow in Applications with the older release's zip. Homebrew can't hold a cask back, so don't run `brew upgrade` until the fix ships.

The AUR package's version is the release's, such as `0.2.0`. It provides and conflicts with `wikistow-desktop`, the package the old PKGBUILD built from source, so installing it replaces that one. The `.deb` and `.rpm` are `wikistow-desktop` at the release's version, with package release `1`. A prerelease such as `0.3.0-rc.1` becomes `0.3.0~rc.1` there, which apt and dnf sort before `0.3.0`. Later releases must keep versions increasing.

The account menu ends with **What’s new**, which lists every release up to this one with its highlights, and the version running. A release shows its version, as `0.2.0`. A build of any other commit adds the first 8 characters of that commit, as `0.2.0+5b9e5ec4`.
