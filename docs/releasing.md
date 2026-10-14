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

After a push to `main` passes, the `image` job publishes the server image from the same build as `ghcr.io/skint007/wikistow:sha-<commit>`, with the commit's first 8 characters. Each commit gets its own tag, and the tag never moves.

Only that job can write packages, and only that job and the release's `desktop` job can write anything.

## Versions

WikiStow has one version, such as `0.2.0`. Every `package.json` in the workspace carries it:

```sh
node scripts/version.ts         # prints it, and fails if any disagree
node scripts/version.ts 0.3.0   # sets it everywhere
```

A release build shows the version alone in the account menu, as `0.2.0`. Any other build adds the commit it was built from, as `0.2.0+5b9e5ec4`, the same 8 characters as its image's `sha-` tag. The desktop app's `app.asar`, the CLI's `wikistow --version`, the image's `org.opencontainers.image.version` label and the AUR package all carry the same version.

Versions follow [semantic versioning](https://semver.org). A version with a suffix, such as `0.3.0-rc.1`, is a prerelease. Its GitHub Release is marked as one, its image gets only its own tag, and the AUR package doesn't take it.

## Cut a release

1. Open a pull request that runs `node scripts/version.ts <version>` and commits the result. Merge it once CI passes.
2. Tag the merged commit and push the tag:

   ```sh
   git tag -a v0.3.0 -m 'WikiStow 0.3.0' <commit>
   git push origin v0.3.0
   ```

3. `.github/workflows/release.yml` then runs on the tag:
   1. `verify` checks that the tag names the version in the source, and that the commit is on `main` or a `release/` branch.
   2. `ci` runs every CI job on the tagged commit. With the release's build, `image` publishes `ghcr.io/skint007/wikistow:0.3.0` and `:0.3`, and `:latest` for a stable release from `main`.
   3. `desktop` publishes a GitHub Release named after the version, with notes listing the merged pull requests. It holds `wikistow-desktop-0.3.0.tar.gz` and `SHA256SUMS`.
   4. For a stable release from `main`, `aur` publishes `wikistow-desktop-bin` to the AUR ([below](#the-aur-package)).

If `verify` fails, nothing was published. Delete the tag, fix the cause, and tag again. If a later job fails, use **Re-run failed jobs** on the same run, which keeps the build it made. Never move a tag that published anything: release a new version instead.

To fix an older release while `main` has moved on, branch `release/<major>.<minor>` from its tag, merge the fix and the version change into that branch through a pull request, and tag there. Its image gets its version and `<major>.<minor>` tags, but not `latest`. Its GitHub Release isn't marked as the latest, and the AUR package stays on the newest release. Only `main` builds get `sha-` images.

## The desktop download

`wikistow-desktop-<version>.tar.gz` holds what the Arch package installs, from the tested build:

| File | Installed as |
| --- | --- |
| `app.asar` | `/usr/lib/wikistow-desktop/app.asar` |
| `wikistow-desktop` | `/usr/bin/wikistow-desktop`, which runs the app on the system `electron44` |
| `wikistow-desktop.desktop` | `/usr/share/applications/wikistow-desktop.desktop` |
| `wikistow-desktop.svg`, `wikistow-desktop.png` | The app's icons |
| `LICENSE` | `/usr/share/licenses/wikistow-desktop/LICENSE` |

The archive is built the same way every time, from the commit's files and time. Check a download before you use it:

```sh
sha256sum -c SHA256SUMS
```

Distribution packages install this archive, as the AUR package does.

## The AUR package

The packaging source is `aur/wikistow-desktop-bin/PKGBUILD`. Change it through a pull request like any other file. Its version and checksum are the release it was last checked against; publishing replaces them.

`.github/workflows/aur.yml` publishes it, once the release's archive is downloadable. It sets the PKGBUILD's version, `pkgrel` and checksum from the release, builds the package as a user who isn't root, checking the downloaded archive against the release's `SHA256SUMS`, and generates `.SRCINFO`. Then it pushes only those two files to `ssh://aur@aur.archlinux.org/wikistow-desktop-bin.git`, as `AUR_USERNAME` with `AUR_EMAIL`. A push that would change nothing is skipped.

To publish again without a new release, such as after a packaging fix, merge the fix, then run **Actions → AUR → Run workflow** on `main` with the release's version and the next `pkgrel`, such as `2`. The next release starts again at `pkgrel` 1.

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
