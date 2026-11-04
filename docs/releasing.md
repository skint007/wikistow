# Releasing WikiStow

GitHub Actions checks every change and publishes the server image and the desktop app. A release is a tag, `v` and the version, on a commit of `main`. Everything it publishes comes from that commit's build, after its checks pass.

## What CI does

`.github/workflows/ci.yml` runs on every pull request and every push to `main`, on GitHub-hosted runners:

| Job | What it checks |
| --- | --- |
| `check` | Formatting, lint and types (`vp check`), that every package carries the same version, and the [changelog](#the-changelog) |
| `test` | The client and unit tests |
| `test-integration` | The integration tests against a Postgres 17 service, including the backup and restore drill |
| `test-browser` | The protocol vectors and editor surfaces in Chromium |
| `build` | The server, CLI, web and desktop bundles and the desktop `app.asar`. The committed route tree must not change |
| `smoke` | The server and CLI bundles, run outside the workspace as the image runs them |
| `e2e` | The web app's browser tests against the built pages |
| `e2e-desktop` | The desktop app's tests under a virtual display, with GNOME Keyring |
| `macos-app` | Builds the [Mac app](#the-mac-app) for Apple silicon on a `macos-15` runner and for Intel on `macos-15-intel`, and starts each |
| `CI passed` | Passes only when every job above passed. Require this one check on `main` |

Pull-request jobs, forks' included, get a token that can only read the repository, and no secrets. They publish nothing.

A push to `main` or a release tag also runs four more jobs, which pull requests skip for time. To run them on a branch before it merges, start CI by hand: **Actions → CI → Run workflow**, and pick the branch.

| Job | What it does |
| --- | --- |
| `linux-packages` | Builds the `.deb` and `.rpm` from the build ([below](#the-deb-and-rpm)) |
| `linux-packages-check` | Installs them on each supported distribution, and checks every library resolves |
| `windows-packages` | Builds the Windows installers from the build, x64 and arm64 ([below](#the-windows-installers)) |
| `windows-packages-check` | Installs each on Windows of its architecture, starts the app, and uninstalls it |

After a push to `main` passes, the `image` job publishes the server image from the same build as `ghcr.io/skint007/wikistow:sha-<commit>`, with the commit's first 8 characters. Each commit gets its own tag, and the tag never moves. The `main` tag moves to the newest of these builds, for a test server that follows `main`. It waits for the packages too, so a release whose packages fail publishes nothing.

Only that job can write packages, and only that job and the release's `github-release` job can write to the repository. The Electron patch check can only read the repository and open issues. Only the release's `aur` job, or a run of the AUR workflow by hand, can use the AUR key, which can push to every AUR package its account maintains. Only the release's `homebrew` job, or a run of the Homebrew workflow by hand, can use the tap's deploy key, which can push only to the tap.

## Versions

WikiStow has one version, such as `0.2.0`. Every `package.json` in the workspace carries it:

```sh
node scripts/version.ts         # prints it, and fails if any disagree
node scripts/version.ts 0.3.0   # sets it everywhere
```

A release build shows the version alone in the account menu, as `0.2.0`. Any other build adds the commit it was built from, as `0.2.0+5b9e5ec4`, the same 8 characters as its image's `sha-` tag. The desktop app's `app.asar`, the CLI's `wikistow --version`, the image's `org.opencontainers.image.version` label and the desktop packages all carry the same version.

Versions follow [semantic versioning](https://semver.org). A version with a suffix, such as `0.3.0-beta.1`, is a prerelease. Its GitHub Release is marked as one, and only the [beta channel](#beta-and-stable) takes it. Its `.deb` and `.rpm` carry `0.3.0~beta.1`, which apt and dnf sort before `0.3.0`.

## Beta and stable

Each new version goes out as a beta first, then as a stable release once it has been tried. Both are tagged on `main`; there is no beta branch.

| | Beta channel | Stable channel |
| --- | --- | --- |
| Takes | every release from `main`: betas, and stable releases too | stable releases only |
| Server image | `:beta`, plus each release's own tag | `:latest`, `:<major>.<minor>`, each release's own tag |
| AUR | `wikistow-desktop-beta-bin`, `wikistow-cli-beta-bin` | `wikistow-desktop-bin`, `wikistow-cli-bin` |
| GitHub Release | marked as a prerelease | marked as the latest |
| Desktop update notice | the newest release, betas included | the newest stable release |

1. **Cut a beta.** [Cut a release](#cut-a-release) with the next version and `-beta.1`, such as `0.23.0-beta.1`. The beta channel takes it; nothing changes for stable.
2. **Fix what the beta finds.** Merge the fixes to `main`, then cut `-beta.2`, and so on.
3. **Promote it.** Cut a release of the version without its suffix, `0.23.0`. Its version pull request changes only the version and the changelog. Its entry describes everything since the stable release before, the betas' changes included ([below](#who-writes-what)). Both channels take it.

A stable release is cut from `main` as it is then, so whatever merged after the last beta ships in it untried. Promote right after the last beta, or cut another beta first. A fix to an older stable release still goes on a `release/` branch ([below](#cut-a-release)), which neither channel's newest moves for.

The desktop app's two AUR packages install side by side: the beta goes under names of its own (`/usr/lib/wikistow-desktop-beta`, `wikistow-desktop-beta`, **WikiStow Beta** with a violet icon), with its own data folder, keyring key and `wikistow-beta://` sign-in link ([desktop](desktop.md#arch-linux)). The CLI's two do as well: the beta installs as `wikistow-beta`, which keeps its files in `~/.config/wikistow-beta` and so enrolls as an agent of its own, and its help and skill name `wikistow-beta` (`apps/cli/src/program.ts`).

## Cut a release

1. Open the version pull request, from a branch of `main`:
   1. Run `node scripts/version.ts <version>`. If Electron has a newer patch of the major in `apps/desktop/package.json`, raise it too ([below](#the-deb-and-rpm)).
   2. In `CHANGELOG.md`, rename `## Unreleased` to `## <version> - <day>`, with the day you will tag it in UTC (`date -u +%F`). Put a new, empty `## Unreleased` above it.
   3. Finish the entry ([below](#the-changelog)). Check that its Changes list every pull request merged since the release before, or for a stable release, since the stable release before: `git log --merges --first-parent --oneline v<previous>..origin/main`. Write or edit its highlights.
   4. Run `node scripts/changelog.ts --tags`, then read the notes the release will publish: `node scripts/changelog.ts notes v<version>`.
   5. Commit, and merge once CI passes.
2. Wait for CI on the merged commit of `main`, which also builds and checks the desktop packages. Then, on the day the entry names in UTC, tag that commit and push the tag:

   ```sh
   git tag -a v0.3.0 -m 'WikiStow 0.3.0' <commit>
   git push origin v0.3.0
   ```

3. `.github/workflows/release.yml` then runs on the tag:
   1. `verify` checks that the tag names the version in the source, that the commit is on `main` or a `release/` branch, that Electron is its major's newest patch, and that every release in the commit's history, this one too, has a changelog entry dated the day of its tag.
   2. `ci` runs every CI job on the tagged commit, including the desktop packages. With the release's build, `image` publishes `ghcr.io/skint007/wikistow:0.3.0`, `:0.3` for a stable release, `:latest` for a stable release from `main`, and `:beta` for any release from `main`.
   3. `github-release` publishes a GitHub Release named after the version, with the notes made from its changelog entry. It holds the [desktop downloads](#the-desktop-downloads), the [CLI downloads](#the-cli-downloads) and their `SHA256SUMS`.
   4. For a stable release from `main`, `aur` publishes `wikistow-desktop-bin` and `wikistow-cli-bin` to the AUR ([below](#the-aur-packages)), and `homebrew` the cask to the Homebrew tap ([below](#the-homebrew-cask)). For any release from `main`, `aur-beta` publishes `wikistow-desktop-beta-bin` and `wikistow-cli-beta-bin`.

If `verify` fails, or a CI job before `image` does, nothing was published. Delete the tag, fix the cause, and tag again. If the tag's day isn't the entry's, change the date through a pull request and tag its merge. If a job fails by chance, or a later job fails, use **Re-run failed jobs** on the same run, which keeps the build it made. Never move a tag that published anything: release a new version instead.

To fix an older release while `main` has moved on, branch `release/<major>.<minor>` from its tag, merge the fix and the version change, with its changelog entry, into that branch through a pull request, and tag there. Its image gets its version and `<major>.<minor>` tags, but not `latest`. Its GitHub Release isn't marked as the latest, and the AUR packages stay on the newest release. Only `main` builds get `sha-` images.

## The changelog

`CHANGELOG.md` is the one record of what each release changed. The app's **What's new** page, in the account menu, shows each release's highlights from the copy built into it. The release publishes each GitHub Release's notes from its entry: the highlights, the technical changes, and a link comparing it with the release before. Nothing else needs writing.

### Who writes what

- Each pull request that changes what ships adds a line under `## Unreleased`, in `### Changes`, ending with its number, such as `(#51)`. Lines go under `####` headings by area: App (the interface the web and desktop share), Desktop, Server, CLI, Releases and packaging, Development. One that people will notice can add a highlight too.
- The version pull request owns the entry. It dates it, writes the final highlights, and checks that its changes are complete. In a batch of parallel pull requests, they leave this to it.
- Every release gets an entry, a maintenance release too.
- A fix on a `release/` branch gets its entry in that branch's `CHANGELOG.md`, describing only what the branch changed since its last release. Once it's released, the next version pull request on `main` copies that entry into its place by version, newest first, so later builds list it. Before then, `main`'s newest entry must stay its own version.

### The format

```md
## 0.6.0 - 2026-10-16

### Highlights

#### Features

- Folders can have their own emoji and colour.

### Changes

#### App

- Folder emoji and colour in New folder and the folder menu. (#55)
```

- Each release starts `## <version> - <YYYY-MM-DD>`, newest first, below `## Unreleased`. The day is the tag's, in UTC.
- Highlights go under these kinds, which the app and the notes show in this order: `Upgrade notes`, `Features`, `Fixes`, `Optimizations`, `UI polish`, `Maintenance`. Leave out a kind with nothing in it. Each highlight is one line starting with `- `. The app shows them as plain text, with backticks as code, so links and pull request numbers go under Changes.
- Changes are any Markdown, with `####` headings or smaller, published as written.

### Writing highlights

- Say in a short, plain sentence what people can do or will notice. Name controls as the app shows them, with curly apostrophes as its text has.
- When a control moves or is renamed, give its old and new name or place.
- Put anything someone has to do, such as updating other devices or changing a proxy setting, under Upgrade notes.
- Don't say something is faster, more reliable or more secure unless the change measured or proved it. Say what changed instead.
- A release with nothing people notice gets one line under Maintenance, rather than a benefit made up for it.
- A stable release after a release candidate describes everything since the stable release before, the candidate's changes included. A release candidate describes what it has since the release before it.

### What checks it

- `node scripts/changelog.ts`, in CI's `check` job: the file follows the format, every release has highlights and changes, each day is real, versions run newest first, and the newest is the version in `package.json`. So a version change can't merge without its entry.
- `node scripts/changelog.ts --tags`, in the release's `verify` job, which has the tags a pull request's checkout lacks: every tag in the history has an entry, every entry has a tag apart from the version being prepared, and each entry has its tag's day.
- `github-release` makes the notes with `node scripts/changelog.ts notes <tag>`, which fails without an entry, so nothing is published without notes.

To correct a published release's notes, fix its entry through a pull request, then replace only its description. That keeps its tag, files, and prerelease and latest marks:

```sh
node scripts/changelog.ts notes v0.5.0 > notes.md
gh release edit v0.5.0 --notes-file notes.md
```

## The desktop downloads

Each release has the desktop app, for Linux on x86_64, for Windows and for macOS, from the tested build:

| File | For |
| --- | --- |
| `wikistow-desktop-<version>.tar.gz` | The AUR package, which runs it on Arch's `electron44` |
| `wikistow-desktop-<version>-amd64.deb` | Debian 13, Ubuntu 24.04 and Ubuntu 26.04 |
| `wikistow-desktop-<version>-x86_64.rpm` | Fedora 43 and 44 |
| `wikistow-desktop-<version>-x64-setup.exe` | Windows 10 and 11 on x64 |
| `wikistow-desktop-<version>-arm64-setup.exe` | Windows 11 on Arm |
| `wikistow-desktop-<version>-macos-arm64.zip` | Macs with Apple silicon, and the Homebrew cask |
| `wikistow-desktop-<version>-macos-x64.zip` | Intel Macs, and the Homebrew cask |
| `SHA256SUMS` | The checksums of these, and of the [CLI downloads](#the-cli-downloads) |

Check a download before you use it:

```sh
sha256sum -c --ignore-missing SHA256SUMS
```

`wikistow-desktop-<version>.tar.gz` holds what the Arch package installs:

| File | Installed as |
| --- | --- |
| `app.asar` | `/usr/lib/wikistow-desktop/app.asar` |
| `wikistow-desktop` | `/usr/bin/wikistow-desktop`, which runs the app on the system `electron44` |
| `wikistow-desktop.desktop` | `/usr/share/applications/wikistow-desktop.desktop` |
| `wikistow-desktop.svg`, `wikistow-desktop.png` | The app's icons |
| `wikistow-desktop-beta.desktop`, `wikistow-desktop-beta.svg`, `wikistow-desktop-beta.png` | The same for the AUR's beta app, under `wikistow-desktop-beta` names |
| `LICENSE` | `/usr/share/licenses/wikistow-desktop-bin/LICENSE` |

The archive is built the same way every time, from the commit's files and time.

## The CLI downloads

Each release has the `wikistow` command-line client as one binary per system, which runs with nothing else installed:

| File | System |
| --- | --- |
| `wikistow-linux-x64`, `wikistow-linux-arm64` | Linux with glibc |
| `wikistow-darwin-arm64`, `wikistow-darwin-x64` | macOS |
| `wikistow-windows-x64.exe` | Windows |

`apps/cli/scripts/binaries.sh` builds them with `bun build --compile` from `wikistow.mjs`, the one-file bundle CI built and tested. Bun cross-builds every system from the Linux runner, putting the bundle into the Bun runtime for that system. `release.yml` pins Bun's version; raise it on purpose, and check the binaries on each system when you do. The script then copies the Linux x64 binary outside the workspace and checks that it prints the release's version and, unenrolled, exits with status 5. A `.env` or `bunfig.toml` in the folder a binary runs in changes nothing: the build turns off Bun's loading of both.

Bun signs the macOS binaries ad hoc, which Apple Silicon requires before it runs anything. They aren't notarized, so macOS refuses one downloaded in a browser until its quarantine flag is removed. `curl` sets no such flag, so the install script needs nothing more.

Beside the binaries are their install scripts, from `apps/cli/install/`:

- `install.sh`, for Linux and macOS: `curl -fsSL https://github.com/skint007/wikistow/releases/latest/download/install.sh | sh`. It picks the binary for the system, checks it against `SHA256SUMS`, puts it in `~/.local/bin`, and adds that to `PATH` in the shell's startup file (`.zshrc`, `.bashrc`, `.bash_profile` on macOS, fish's `config.fish`, or `.profile`) if it's missing. Musl systems such as Alpine get a plain refusal.
- `install.ps1`, for Windows: `irm https://github.com/skint007/wikistow/releases/latest/download/install.ps1 | iex`. The same checks, into `%LOCALAPPDATA%\Programs\wikistow`, added to the user's `PATH` as stored, so its other entries keep their `%VARIABLES%`.

Running either again updates the CLI. Both install the latest release; `WIKISTOW_RELEASE_URL` points them at another release's downloads, such as `https://github.com/skint007/wikistow/releases/download/v0.13.0`, or a local copy for testing.

The release also has `wikistow-cli-<version>.tar.gz`, with `wikistow.mjs` and the licence, for systems without a binary: run it as `node wikistow.mjs` on Node.js 26 or newer. Before publishing, the release unpacks it outside the workspace and checks that it prints the release's version. Like the desktop archive, it comes out the same every time from the same commit. `LICENSE` is a download of its own too, for the Arch package.

To build the binaries yourself, after the build in the README, put Oven's own Bun at the pinned version on your `PATH`, from [its releases](https://github.com/oven-sh/bun/releases). A distribution's package, such as Arch's `bun`, builds the binary for its own system with the libraries it links to, so that one won't run elsewhere:

```sh
cd apps/cli
scripts/binaries.sh "$(node ../../scripts/version.ts)" dist/binaries
```

## The .deb and .rpm

`apps/desktop/scripts/linux-packages.sh` builds both with [nfpm](https://nfpm.goreleaser.com), from `apps/desktop/packaging/nfpm.yaml`. They hold the same files as the archive, with Electron in `/usr/lib/wikistow-desktop`, renamed `wikistow-desktop`, and the app as its `resources/app.asar`. The launcher starts that Electron when it's there. Chromium's sandbox helper, `chrome-sandbox`, is setuid root. Each package also writes the [install source](desktop.md#how-it-was-installed), as the PKGBUILD does. Like the archive, both come out the same every time from the same commit.

The Electron is the one `apps/desktop/package.json` pins, which the desktop tests run on. Arch's `electron44` gets security fixes from Arch, but this copy only changes when WikiStow releases. So:

- Before each release, raise `electron` to the newest patch of its major: `pnpm -C apps/desktop add -DE electron@<version>`. [Electron's releases](https://releases.electronjs.org) list them. `verify` fails until it is the newest.
- When Electron ships a security fix, raise it and release, even with nothing else to ship.
- Each Monday, `.github/workflows/electron-patch.yml` runs the same check as `verify`. When a newer patch is out, it opens the issue "Raise Electron to its newest patch", unless one is already open. Run it by hand with **Actions → Electron patch → Run workflow**.
- Before Electron's major leaves support, move to a newer one. That changes the PKGBUILD's `electron44`, the launcher, and maybe the packages' dependencies.

The dependencies in `nfpm.yaml` are the libraries Electron links against, plus libsecret for the keyring and `xdg-utils` for signing in. On every push to `main` and every release, `linux-packages-check` installs each package in a container of every supported distribution, and fails if `ldd -r` can't resolve a library or symbol. It doesn't start the app. After a new Electron major, or to support a new distribution release, also start the app on each one and open a `wikistow://` link.

To build them yourself, with nfpm on your `PATH`, after the build in the README. CI gives the files the commit's time:

```sh
cd apps/desktop
SOURCE_DATE_EPOCH=$(git log -1 --format=%ct) scripts/linux-packages.sh "$(node ../../scripts/version.ts)" out/packages
```

CI pins nfpm's version and checksum in `linux-packages`.

## The Windows installers

`apps/desktop/scripts/windows-packages.sh` builds both on Linux, as the app has no native modules. For each architecture it downloads Electron's Windows build of the pinned version, checked against the checksums the `electron` package ships, renames `electron.exe` to `WikiStow.exe` and gives it the app's icon and name (`scripts/windows-exe.ts`, with [resedit](https://github.com/jet2jet/resedit-js)), adds `app.asar` and the [install source](desktop.md#how-it-was-installed), and packs it with [NSIS](https://nsis.sourceforge.io) from `apps/desktop/packaging/windows.nsi`. The installer is per-user, so it needs no administrator, and adds the Start menu entry, the `wikistow://` links and the uninstaller. Compressing takes a few minutes per architecture, so CI builds them in parallel jobs. Unlike the Linux packages, they don't come out byte for byte the same each time.

`windows-packages-check` runs `scripts/windows-check.ts` on GitHub's Windows x64 and Windows 11 Arm runners: a silent install, the app's sign-in page, DPAPI as its secret store, a second launch handing over a `wikistow://` link, and a silent uninstall that leaves nothing behind.

The installers aren't signed, so SmartScreen warns until people choose **More info → Run anyway** ([desktop](desktop.md#windows)). Signing them needs a code-signing certificate, kept outside this repository like the AUR key.

To build them yourself, with `makensis` on your `PATH` (`apt install nsis`, or `nsis` on Arch), after the build in the README:

```sh
cd apps/desktop
scripts/windows-packages.sh "$(node ../../scripts/version.ts)" out/windows-packages
```

## The Mac app

`apps/desktop/scripts/macos-app.sh` builds `WikiStow.app` for one kind of Mac, on a Mac, and zips it. It takes Electron's own darwin build at the version `apps/desktop/package.json` pins, checked against the checksums in its npm package, renames it WikiStow, puts the tested `app.asar` in its `Resources`, with `install-source` and the icon (`packaging/wikistow-desktop.icns`), and sets its `Info.plist`: its name, `io.github.skint007.wikistow`, the release's version, and the `wikistow` scheme. Changing the bundle breaks Electron's signature, and Apple silicon runs nothing unsigned, so it signs the app again ad hoc (`codesign --sign -`), which names nobody. There is no Apple Developer ID or notarization, so Gatekeeper asks the person to allow it ([desktop](desktop.md#the-first-time-it-opens)).

CI's `macos-app` job builds each on a Mac of its own kind, checks the binary's architecture, and starts the app it built with Playwright and no server (`MAC_APP`, `e2e/packed.spec.ts`): its pages, its menu bar, the Keychain as its secret store, and no window buttons of its own. It runs on every pull request, since nothing else starts the Mac app. The release publishes the two zips it made. Raising Electron raises the Mac app's too.

## The Homebrew cask

The tap `skint007/homebrew-wikistow` holds the cask, so `brew install --cask skint007/wikistow/wikistow` installs the app. Its source is `apps/desktop/packaging/homebrew/wikistow.rb`; change it through a pull request. Homebrew's own cask repository takes no app that Gatekeeper refuses, so the cask can't go there unsigned.

`.github/workflows/homebrew.yml` publishes it, once the release's files are up: it fills in the version and the two zips' checksums from the release's `SHA256SUMS`, checks Ruby parses it, and pushes it to the tap's `Casks/wikistow.rb` with the tap's deploy key, as `github-actions[bot]`. A push that would change nothing is skipped. Without the key it warns and publishes nothing, so a release never fails for it. To publish again, such as after a fix to the cask or once the tap exists, merge the fix, then run **Actions → Homebrew → Run workflow** on `main` with the release's version.

## The AUR packages

Two packages follow each stable release: `wikistow-desktop-bin` installs the desktop archive, and `wikistow-cli-bin` the CLI's Linux binary for its architecture, x86_64 or aarch64, with `LICENSE`. Their packaging sources are `aur/wikistow-desktop-bin/PKGBUILD` and `aur/wikistow-cli-bin/PKGBUILD`. Change them through a pull request like any other file. Their versions and checksums are only where publishing starts; it replaces them.

Their beta twins, `wikistow-desktop-beta-bin` and `wikistow-cli-beta-bin`, follow every release from `main` ([beta and stable](#beta-and-stable)). They have no sources of their own: publishing takes the same PKGBUILDs and renames the package, adds "(beta channel)" to its description, and sets `_channel=beta`. The desktop package writes `_channel` to its folder's `channel`, so the app offers betas. With `_channel=beta` it installs under the beta's names instead of the stable app's, so the two sit side by side; the app knows it is the beta from running in `/usr/lib/wikistow-desktop-beta` (`apps/desktop/src/install.ts`). Release archives have the beta's files from 0.23.0-beta.2 on, so publishing an older release to the beta channel again fails. The stable channel's job refuses a beta version.

`.github/workflows/aur.yml` publishes both, once the release's files are up, in a job for each. Each job sets its PKGBUILD's version, `pkgrel` and checksums from the release's `SHA256SUMS`, builds the package as a user who isn't root, checking what it downloads against them, and generates `.SRCINFO`. The runner is x86_64, so the build downloads only the x86_64 binary; the aarch64 checksum comes from `SHA256SUMS` alone. Then it pushes only those two files to `ssh://aur@aur.archlinux.org/<package>.git`, as `AUR_USERNAME` with `AUR_EMAIL`. A push that would change nothing is skipped. The AUR creates a package on its first push. One package failing doesn't stop the other.

To publish again without a new release, such as after a packaging fix, merge the fix, then run **Actions → AUR → Run workflow** on `main` with the release's version, the package (or both), the channel and the next `pkgrel`, such as `2`. Each package counts its own `pkgrel`, and the next release starts both again at 1.

## The server image

Run a release's version tag, or pin its digest, and change it on purpose to upgrade ([operations](operations.md#choose-an-image)). The image's labels name its version and source commit:

```sh
docker image inspect ghcr.io/skint007/wikistow:0.3.0 \
  --format '{{ index .Config.Labels "org.opencontainers.image.version" }} {{ index .Config.Labels "org.opencontainers.image.revision" }}'
```

## Repository settings

The workflows use the token GitHub gives each run, the AUR key and the tap's key. Set up the public repository once, as an administrator:

1. **Settings → Actions → General.** Keep the default workflow permissions at **Read repository contents and packages permissions**. The workflows ask for more only in the jobs that publish. Require approval before fork pull requests from outside contributors run workflows.
2. **Settings → Rules → Rulesets**, for `main`: require a pull request, require the status check **CI passed** from GitHub Actions, and block force pushes and deletion.
3. A tag ruleset for `v*`: restrict creation, updates and deletion to the maintainers in its bypass list. Anyone who can push such a tag can publish a release.
4. After the first push to `main` publishes the image, open the `wikistow` package from the repository's **Packages** and, under **Package settings**, change its visibility to **Public**. A new package is private until then. Its source label links it to this repository, so the repository's workflows keep write access.
5. **Settings → Environments → `aur`**: limit deployments to the `v*` tags and `main`, so pull requests and other branches never see what it holds. Give it:

   | Name | Kind | Value |
   | --- | --- | --- |
   | `AUR_SSH_PRIVATE_KEY` | Secret | A private key without a passphrase whose public half is on the maintainer's AUR account. Any key there can push to every package the account maintains |
   | `AUR_KNOWN_HOSTS` | Variable | `ssh-keyscan aur.archlinux.org`, checked against the fingerprints on the AUR's home page |
   | `AUR_USERNAME`, `AUR_EMAIL` | Variables | The name and email the AUR commits carry |

   Upload the key from the computer that holds it, so it never shows on screen: `gh secret set AUR_SSH_PRIVATE_KEY --env aur < <key file>`.
6. The tap: a public repository `skint007/homebrew-wikistow`, with a `Casks` folder. Make a key for it with `ssh-keygen -t ed25519 -N '' -f homebrew-tap`, and add `homebrew-tap.pub` under the tap's **Settings → Deploy keys**, with **Allow write access**. That key can push only to the tap. Then **Settings → Environments → `homebrew`** here, limited to the `v*` tags and `main`, with the private half as the secret `HOMEBREW_TAP_KEY`: `gh secret set HOMEBREW_TAP_KEY --env homebrew < homebrew-tap`. Delete both files after.

## Moving from the private repository

The public repository started from fresh history, with only `main`. Create `release/` branches and `v*` tags here, from that history. Don't import branches or tags from the private repository.

- Remove the public repository from Woodpecker, or delete its webhook. Its pull requests must not run on runners that can reach private networks or credentials.
- Private deployments that pulled images from a private registry can pull `ghcr.io/skint007/wikistow` tags instead. Keep their configuration, hostnames and credentials in your private deployment configuration, not here.
- Arch packages built from the old `release` branch are named `wikistow-desktop`. Installing `wikistow-desktop-bin` replaces them. The `release` branch is no longer used.
