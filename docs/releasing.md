# Releasing WikiStow

GitHub Actions checks every change and publishes the server image and the desktop app. A release is a tag, `v` and the version, on a commit of `main`. Everything it publishes comes from that commit's build, after its checks pass.

## What CI does

`.github/workflows/ci.yml` runs on every pull request and every push to `main`, on GitHub-hosted runners:

| Job | What it checks |
| --- | --- |
| `check` | Formatting, lint and types (`vp check`), and that every package carries the same version |
| `test` | The client and unit tests |
| `test-integration` | The integration tests against a Postgres 17 service, including the backup and restore drill |
| `test-browser` | The protocol vectors and editor surfaces in Chromium |
| `build` | The server, CLI, web and desktop bundles and the desktop `app.asar`. The committed route tree must not change |
| `smoke` | The server and CLI bundles, run outside the workspace as the image runs them |
| `e2e` | The web app's browser tests against the built pages |
| `e2e-desktop` | The desktop app's tests under a virtual display, with GNOME Keyring |
| `CI passed` | Passes only when every job above passed. Require this one check on `main` |

Pull-request jobs, forks' included, get a token that can only read the repository, and no secrets. They publish nothing.

A push to `main` or a release tag also runs two more jobs, which pull requests skip for time:

| Job | What it does |
| --- | --- |
| `linux-packages` | Builds the `.deb` and `.rpm` from the build ([below](#the-deb-and-rpm)) |
| `linux-packages-check` | Installs them on each supported distribution, and checks every library resolves |

After a push to `main` passes, the `image` job publishes the server image from the same build as `ghcr.io/skint007/wikistow:sha-<commit>`, with the commit's first 8 characters. Each commit gets its own tag, and the tag never moves. It waits for the packages too, so a release whose packages fail publishes nothing.

Only that job can write packages, and only that job and the release's `github-release` job can write to the repository. The Electron patch check can only read the repository and open issues. Only the release's `aur` job, or a run of the AUR workflow by hand, can use the AUR key, which can push to every AUR package its account maintains.

## Versions

WikiStow has one version, such as `0.2.0`. Every `package.json` in the workspace carries it:

```sh
node scripts/version.ts         # prints it, and fails if any disagree
node scripts/version.ts 0.3.0   # sets it everywhere
```

A release build shows the version alone in the account menu, as `0.2.0`. Any other build adds the commit it was built from, as `0.2.0+5b9e5ec4`, the same 8 characters as its image's `sha-` tag. The desktop app's `app.asar`, the CLI's `wikistow --version`, the image's `org.opencontainers.image.version` label and the desktop packages all carry the same version.

Versions follow [semantic versioning](https://semver.org). A version with a suffix, such as `0.3.0-rc.1`, is a prerelease. Its GitHub Release is marked as one, its image gets only its own tag, and the AUR packages don't take it. Its `.deb` and `.rpm` carry `0.3.0~rc.1`, which apt and dnf sort before `0.3.0`.

## Cut a release

1. Open a pull request that runs `node scripts/version.ts <version>` and commits the result. If Electron has a newer patch of the major in `apps/desktop/package.json`, raise it in the same pull request ([below](#the-deb-and-rpm)). Merge it once CI passes.
2. Wait for CI on the merged commit of `main`, which also builds and checks the desktop packages. Then tag that commit and push the tag:

   ```sh
   git tag -a v0.3.0 -m 'WikiStow 0.3.0' <commit>
   git push origin v0.3.0
   ```

3. `.github/workflows/release.yml` then runs on the tag:
   1. `verify` checks that the tag names the version in the source, that the commit is on `main` or a `release/` branch, and that Electron is its major's newest patch.
   2. `ci` runs every CI job on the tagged commit, including the desktop packages. With the release's build, `image` publishes `ghcr.io/skint007/wikistow:0.3.0` and `:0.3`, and `:latest` for a stable release from `main`.
   3. `github-release` publishes a GitHub Release named after the version, with notes listing the merged pull requests. It holds the [desktop downloads](#the-desktop-downloads), the [CLI download](#the-cli-download) and their `SHA256SUMS`.
   4. For a stable release from `main`, `aur` publishes `wikistow-desktop-bin` and `wikistow-cli-bin` to the AUR ([below](#the-aur-packages)).

If `verify` fails, or a CI job before `image` does, nothing was published. Delete the tag, fix the cause, and tag again. If a job fails by chance, or a later job fails, use **Re-run failed jobs** on the same run, which keeps the build it made. Never move a tag that published anything: release a new version instead.

To fix an older release while `main` has moved on, branch `release/<major>.<minor>` from its tag, merge the fix and the version change into that branch through a pull request, and tag there. Its image gets its version and `<major>.<minor>` tags, but not `latest`. Its GitHub Release isn't marked as the latest, and the AUR packages stay on the newest release. Only `main` builds get `sha-` images.

## The desktop downloads

Each release has the desktop app, for x86_64, from the tested build:

| File | For |
| --- | --- |
| `wikistow-desktop-<version>.tar.gz` | The AUR package, which runs it on Arch's `electron44` |
| `wikistow-desktop-<version>-amd64.deb` | Debian 13, Ubuntu 24.04 and Ubuntu 26.04 |
| `wikistow-desktop-<version>-x86_64.rpm` | Fedora 43 and 44 |
| `SHA256SUMS` | The checksums of the three, and of the [CLI's archive](#the-cli-download) |

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
| `LICENSE` | `/usr/share/licenses/wikistow-desktop-bin/LICENSE` |

The archive is built the same way every time, from the commit's files and time.

## The CLI download

Each release also has the `wikistow` command-line client as `wikistow-cli-<version>.tar.gz`. It is the one-file bundle CI built and ran in its `smoke` job, and needs nothing but Node.js 26 or newer, on any system. It holds what the Arch package installs:

| File | Installed as |
| --- | --- |
| `wikistow.mjs` | `/usr/lib/wikistow-cli/wikistow.mjs` |
| `wikistow` | `/usr/bin/wikistow`, which runs it on the system Node |
| `LICENSE` | `/usr/share/licenses/wikistow-cli-bin/LICENSE` |

Without the package, run it as `node wikistow.mjs`. Before publishing, the release unpacks the archive outside the workspace and checks that `node wikistow.mjs --version` prints the release's version. Like the desktop archive, it comes out the same every time from the same commit.

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

## The AUR packages

Two packages follow each stable release: `wikistow-desktop-bin` installs the desktop archive, and `wikistow-cli-bin` the CLI's. Their packaging sources are `aur/wikistow-desktop-bin/PKGBUILD` and `aur/wikistow-cli-bin/PKGBUILD`. Change them through a pull request like any other file. Their versions and checksums are only where publishing starts; it replaces them.

`.github/workflows/aur.yml` publishes both, once the release's archives are downloadable, in a job for each. Each job sets its PKGBUILD's version, `pkgrel` and checksum from the release, builds the package as a user who isn't root, checking the downloaded archive against the release's `SHA256SUMS`, and generates `.SRCINFO`. Then it pushes only those two files to `ssh://aur@aur.archlinux.org/<package>.git`, as `AUR_USERNAME` with `AUR_EMAIL`. A push that would change nothing is skipped. The AUR creates a package on its first push. One package failing doesn't stop the other.

To publish again without a new release, such as after a packaging fix, merge the fix, then run **Actions → AUR → Run workflow** on `main` with the release's version, the package (or both) and the next `pkgrel`, such as `2`. Each package counts its own `pkgrel`, and the next release starts both again at 1.

## The server image

Run a release's version tag, or pin its digest, and change it on purpose to upgrade ([operations](operations.md#choose-an-image)). The image's labels name its version and source commit:

```sh
docker image inspect ghcr.io/skint007/wikistow:0.3.0 \
  --format '{{ index .Config.Labels "org.opencontainers.image.version" }} {{ index .Config.Labels "org.opencontainers.image.revision" }}'
```

## Repository settings

The workflows use the token GitHub gives each run, and the AUR key. Set up the public repository once, as an administrator:

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

## Moving from the private repository

The public repository started from fresh history, with only `main`. Create `release/` branches and `v*` tags here, from that history. Don't import branches or tags from the private repository.

- Remove the public repository from Woodpecker, or delete its webhook. Its pull requests must not run on runners that can reach private networks or credentials.
- Private deployments that pulled images from a private registry can pull `ghcr.io/skint007/wikistow` tags instead. Keep their configuration, hostnames and credentials in your private deployment configuration, not here.
- Arch packages built from the old `release` branch are named `wikistow-desktop`. Installing `wikistow-desktop-bin` replaces them. The `release` branch is no longer used.
