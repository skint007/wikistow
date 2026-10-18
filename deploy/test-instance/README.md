# Restore verification on a test instance

The Playwright runs in `apps/web/drill` seed a fresh installation and verify a restored copy. They do not start or deploy a server and do not run in CI or the ordinary test suite. Keep the test instance private and send its mail to Mailpit, which delivers nothing.

Actual hostnames, proxy routes, deployment files, and secret files belong in your private deployment configuration. Follow [operations](../../docs/operations.md) to create and restore backups.

## Seed a fresh installation

Point `WIKISTOW_URL` at an empty test installation and `MAILPIT_URL` at its Mailpit inbox:

```sh
export WIKISTOW_URL=https://wiki-test.example.com
export MAILPIT_URL=https://mail-test.example.com
pnpm -C apps/web drill:seed
```

If Mailpit requires a login, set `MAILPIT_AUTH` to `user:password` through your credential tooling, or save it in `~/.config/wikistow-drill/mailpit-auth`, mode 600. Keep its directory mode 700.

The seed creates the administrator on the installation's **Set up WikiStow** page, so it stops on a server that already has accounts. It creates two test accounts with random passwords, passphrases and recovery keys. It creates shared and private published pages with an attachment, and enables two-factor on the second account. Its private state file records everything needed to verify the restore, including account secrets. An existing state file prevents a new seed from running.

## Check a restore

Use your deployment tooling to restore the backup into a separate database and attachment directory. Start that restored server with the original `BETTER_AUTH_SECRET`, an SMTP endpoint that sends nothing, and a private test URL. Then run:

```sh
WIKISTOW_URL=https://wiki-restored.example.com pnpm -C apps/web drill:check
```

The check compares the installation ID, signs in and unlocks with the recorded credentials, verifies shared and private page access, and checks the attachment's bytes. A successful two-factor sign-in also proves that the original server secret can decrypt its stored key. Remove the restored deployment when finished.

## Configuration

| Variable | Default and purpose |
| --- | --- |
| `WIKISTOW_URL` | `http://localhost:3000`, the server being seeded or checked |
| `MAILPIT_URL` | `http://127.0.0.1:8025`, used only by the seed |
| `MAILPIT_AUTH` | Mailpit login, otherwise read from `~/.config/wikistow-drill/mailpit-auth` |
| `DRILL_STATE` | `~/.config/wikistow-drill/state.json`, written mode 600 |
| `DRILL_FORCE` | `1` permits overwriting the existing state file |
| `DRILL_RESUME` | `1` resumes steps not recorded as complete in the state file |

For a partial seed, resume only after checking whether its failed step already changed the server. The state file's `done` list and the `State` type in `apps/web/drill/drill.ts` describe what each completed step records.

Keep the state file with the same care as a backup. The runs keep no screenshots, videos or traces. Failure messages replace recorded secrets, but Playwright's page snapshots do not. Snapshots go in a private `drill-output` directory beside the state file, outside this repository by default.
