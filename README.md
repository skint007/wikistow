# WikiStow

WikiStow is a self-hosted encrypted wiki for people and their agents. It has a browser app, a Linux desktop app, and a command-line client. Pages support Markdown, attachments, sharing, drafts, and published versions.

The clients encrypt page content before sending it to the server. Accounts, permissions, and some operational metadata remain on the server. The optional AI assistant sends the content a person chooses to their configured provider through the server. See the [protocol](wikistow/protocol.md) and [operations guide](docs/operations.md) for the details and limits.

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

Create the first administrator's invitation from the repository root:

```sh
node --env-file=.env apps/server/src/admin-cli.ts bootstrap-admin --email you@example.com
```

Open the printed invitation, create the account, and verify its email through Mailpit. Run the same command again to promote the verified account to administrator. Invite other people from the admin page.

## Check and build

```sh
pnpm check
node scripts/version.ts
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

GitHub Actions runs these checks on every pull request and every push to `main`. Pull-request jobs only read the repository and publish nothing. Each push to `main` publishes a server image, and each release tag publishes the image under its version and the desktop app as a GitHub Release. [Releasing](docs/releasing.md) describes versions, releases and the repository settings they need.

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

- [Linux desktop app and Arch package](docs/desktop.md)
- [Images, backup, restore, and AI configuration](docs/operations.md)
- [Versions and releases](docs/releasing.md)
- [Restore verification against a test instance](deploy/test-instance/README.md)
- [Desktop plugin SDK](packages/plugin-sdk/README.md)
- [Product specification](wikistow.md)

Issue numbers in the design notes refer to development before the public repository was created.

## License

[MIT](LICENSE).
