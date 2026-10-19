# WikiStow

WikiStow is a self-hosted encrypted wiki for people and their agents. It has a browser app, a Linux desktop app, and a command-line client. Pages support Markdown, attachments, sharing, drafts, and published versions.

The clients encrypt page content before sending it to the server. Accounts, permissions, and some operational metadata remain on the server. The optional AI assistant sends the content a person chooses to their configured provider through the server. See the [protocol](wikistow/protocol.md) and [operations guide](docs/operations.md) for the details and limits.

## Install the desktop app

The desktop app runs on Linux on x86_64. On Arch Linux, install `wikistow-desktop-bin` from the AUR. On Debian 13, Ubuntu 24.04 and 26.04, and Fedora 43 and 44, install the `.deb` or `.rpm` from the [latest release](https://github.com/skint007/wikistow/releases/latest), from 0.3.0 on. A downloaded package doesn't add a repository, so `apt upgrade` and `dnf upgrade` won't update it. Install each new release's package instead. [docs/desktop.md](docs/desktop.md) covers installing, updating and removing it.

## Install the command-line client

The `wikistow` command is how an agent reads and writes the pages shared with it, once enrolled with `wikistow agent enroll`. Run `wikistow --help` for the rest. `wikistow skill` prints a skill that teaches an agent to use it, to save wherever its harness reads skills.

It's one file, with nothing else to install. On Linux (x86_64 or arm64, with glibc) and macOS:

```sh
curl -fsSL https://github.com/skint007/wikistow/releases/latest/download/install.sh | sh
```

That puts `wikistow` in `~/.local/bin`, and adds that folder to `PATH` in your shell's startup file if it isn't there. Run it again to update. On Arch Linux, you can install `wikistow-cli-bin` from the AUR instead. Either installs beside the desktop app, whose command is `wikistow-desktop`.

On Windows, in PowerShell:

```powershell
irm https://github.com/skint007/wikistow/releases/latest/download/install.ps1 | iex
```

That installs it in `%LOCALAPPDATA%\Programs\wikistow` and adds that folder to your `PATH`. On Windows the CLI keeps its files in `%APPDATA%\wikistow`, and the passphrase unlocks it: it can't use a secret store there yet.

You can also download your system's binary from the [latest release](https://github.com/skint007/wikistow/releases/latest) and check it against `SHA256SUMS`. On a Mac, a binary downloaded in a browser won't run until you run `xattr -d com.apple.quarantine` on it; the install script doesn't need that. Systems without glibc, such as Alpine, can run `node wikistow.mjs` from the release's `wikistow-cli-<version>.tar.gz` on Node.js 26 or newer.

## Run locally

Install Node.js 26 or newer, pnpm 10.34.5, and Docker Compose.

```sh
pnpm install --frozen-lockfile
docker compose up -d
cp .env.example .env
```

Set `BETTER_AUTH_SECRET` in `.env` to a fresh value from `openssl rand -base64 48`. The other defaults connect to the local Postgres and Mailpit services. These credentials are for local development only.

Start the server and web app in separate terminals:

```sh
pnpm --filter @wikistow/server-app dev
```

```sh
pnpm --filter @wikistow/web dev
```

Open `http://localhost:5173`. The server applies database migrations when it starts. Mailpit shows verification emails at `http://127.0.0.1:8025`.

On a fresh database the app opens **Set up WikiStow**. The account you create there is the administrator. It signs in at once, without a verification email. Invite other people from the admin page.

## Check and build

```sh
pnpm check
node scripts/version.ts
node scripts/changelog.ts
pnpm exec vp test --project client --project unit
pnpm exec vp test --project integration
pnpm exec vp test --project client-browser --project ui-browser
pnpm exec vp -C apps/server pack
pnpm exec vp -C apps/cli pack
pnpm exec vp -C apps/web build
pnpm exec vp -C apps/desktop pack
node apps/desktop/scripts/asar.ts
```

Integration tests use the local Postgres service. The backup and restore tests also need Postgres 17's `pg_dump`, `pg_restore`, and `psql`. Browser tests need Playwright's Chromium, installed with `pnpm --filter @wikistow/web exec playwright install chromium`.

Run the web workflow checks with `pnpm --filter @wikistow/web e2e`. Desktop setup and checks are in [docs/desktop.md](docs/desktop.md).

GitHub Actions runs these checks on every pull request and every push to `main`. Pull-request jobs only read the repository and publish nothing. Each push to `main` publishes a server image, and each release tag publishes the image under its version, and the desktop app and the CLI as a GitHub Release. [Releasing](docs/releasing.md) describes versions, releases and the repository settings they need. A pull request that changes what ships adds a line to [`CHANGELOG.md`](CHANGELOG.md), as [Releasing](docs/releasing.md#the-changelog) describes.

## Deploy and operate

Releases publish the server image as `ghcr.io/skint007/wikistow:<version>`:

```sh
docker pull ghcr.io/skint007/wikistow:0.2.0
```

To build it yourself, build the bundles above, then the runtime image:

```sh
docker build -f docker/Dockerfile -t wikistow:local .
```

The root Compose file runs development services only. For a server, configure the environment described in [.env.example](.env.example), provide Postgres and persistent attachment storage, and follow [docs/operations.md](docs/operations.md). Keep real environment files and deployment configuration outside this repository.

To set up the first administrator, start the server, open its address, and create the account on the **Set up WikiStow** page. Until then anyone who can reach the server can claim it, so do this before you share the address ([details](docs/operations.md#first-administrator)).

- [Linux desktop app and its packages](docs/desktop.md)
- [Images, first administrator, backup, restore, and AI configuration](docs/operations.md)
- [Versions and releases](docs/releasing.md)
- [Restore verification against a test instance](deploy/test-instance/README.md)
- [Desktop plugin SDK](packages/plugin-sdk/README.md)
- [Product specification](wikistow.md)

Issue numbers in the design notes refer to development before the public repository was created.

## License

[MIT](LICENSE).
