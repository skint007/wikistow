# Operations

How to run a WikiStow server so it stays up, connect an AI provider, back up the installation, restore it, and prove the restore works.

## Choose an image

Releases publish the server image as `ghcr.io/skint007/wikistow:<version>`, such as `0.2.0`. Run a version tag, or pin its digest, and change it on purpose to upgrade. Take a backup first: the server migrates the database when it starts. `<major>.<minor>` tags, such as `0.2`, move to that line's newest release, and `latest` moves to the newest stable release from `main`. `sha-<commit>` tags are builds of `main` commits for testing, not releases. Every image's labels name its version and source commit ([releasing](releasing.md)).

## Run the server under a restart policy

Always run the server under a restart policy, such as Compose's `restart: unless-stopped` or systemd's `Restart=always`. The server stops, with status 1, whenever it can't be sure no restore is under way: when it starts while a restore runs, and whenever it loses its lock on the database, which any Postgres restart or failover causes (see [Restoring](#restoring)). It never waits for Postgres to come back. Only a restart policy starts it again, once Postgres is up and no restore runs. Without one, every Postgres restart leaves WikiStow down until you start it by hand.

## Idle connections

The server closes a connection that sends and takes nothing for 60 seconds, such as a client that stopped reading a large file. A reverse proxy in front of it needs a read timeout of at least 15 seconds, the longest an AI reply goes without sending anything; proxy defaults, such as nginx's 60 seconds, are longer.

## Connect an AI provider

The AI assistant is off until you configure one provider in the server's environment. People's apps send their conversations to your server, which adds the key and forwards them to the provider. The key never leaves the server. Turning AI on means the content people choose to send passes through your server to that provider, and the app tells them so.

| Variable | Meaning |
| --- | --- |
| `AI_API_STYLE` | `openai` for the OpenAI-compatible Chat Completions API, or `anthropic` for the Anthropic Messages API. |
| `AI_BASE_URL` | The provider's base URL, as its SDK takes it: the server adds `/chat/completions` (OpenAI style) or `/v1/messages` (Anthropic style). |
| `AI_API_KEY` | The provider's key. Optional, for local servers that take none. |
| `AI_MODEL` | The model every request uses. |
| `AI_MAX_OUTPUT_TOKENS` | The longest reply, in tokens. Default 4096. Clients can't ask for more. |
| `AI_REQUESTS_PER_MINUTE` | AI requests a minute for one account. Each tool step is a request. Default 30. |

AI is on once `AI_API_STYLE`, `AI_BASE_URL` and `AI_MODEL` are set. Setting only some of them stops the server at start with a message naming the rest. Some examples:

| Provider | `AI_API_STYLE` | `AI_BASE_URL` |
| --- | --- | --- |
| OpenAI | `openai` | `https://api.openai.com/v1` |
| Anthropic | `anthropic` | `https://api.anthropic.com` |
| Ollama | `openai` | `http://127.0.0.1:11434/v1` |
| LM Studio | `openai` | `http://127.0.0.1:1234/v1` |

The model must support tool calls. For the OpenAI style the server limits replies with `max_completion_tokens`, which some local servers ignore.

Check the connection under **Settings → AI assistant → Check connection**. It sends the provider a request of a few tokens and says whether the key and model work.

The server keeps no prompt or reply. It doesn't store them, and its log has one `ai-provider-failed` line for each failed provider request, with only the failure's code and HTTP status. A conversation lives in the person's app and is gone when they close it, lock their vault or sign out. Each request has a 1 MiB body limit, and a provider request that runs over 10 minutes is cut off. While the provider is quiet, as a reasoning model can be for minutes before it answers, the server sends a blank line every 15 seconds to keep the reply open. When a person stops a reply, the server cancels the provider's request too.

## What to back up

Two things, taken together by `scripts/backup.sh`:

- The PostgreSQL database at `DATABASE_URL`. It holds accounts and their avatars, encrypted pages, everyone's wrapped keys and the installation ID.
- The attachment files in `BLOB_DIR/objects`. `BLOB_DIR` is `/data/blobs` in the image. These are encrypted bytes only.

Keep one more thing yourself, because the backup doesn't hold it: the server's `BETTER_AUTH_SECRET`. Better Auth encrypts what it stores with it, such as two-factor keys, so a restored server needs the same value. Keep it with your other secrets.

Treat every backup as private. Page content is encrypted, but the dump also holds email addresses, password hashes and sessions. The scripts write backups readable only by the user who ran them. Encrypt any copy you send off the machine.

## Database first, then files

`backup.sh` dumps the database, then copies the files. The order matters. The server writes an attachment's file just before the database row that lists it. Taken in this order, a file saved during the backup is at worst an extra file, and the server deletes it after a restore. The other order could miss the file for a page saved a moment later, and that page would come back with a broken attachment.

The order can't cover deletions. Deleting a page removes its files at once, so a page deleted while the files were being copied would come back without them. So the script then checks that every file the dump lists made it into the copy, and fails if not. Run it again. The same check catches a `BLOB_DIR` that points at the wrong place.

If the same files stay missing run after run, they're gone from `BLOB_DIR` itself, through disk damage or someone deleting them. The error names them. Copy them back from an older backup's `blobs.tar` (`tar -xf blobs.tar objects/<first two characters>/<name>`, into `BLOB_DIR`, owned by the server's user), and backups work again. If no backup has them, those attachments are lost, and downloading them already fails. Let backups run again by deleting their rows in `psql`, with `delete from blobs where hash in ('<name>', ...);`.

The copy leaves out `BLOB_DIR/staging`, which only holds uploads in progress.

## Taking a backup

The app image has no Postgres tools. Run the scripts from a one-off container of the same Postgres image as your database, so `pg_dump` always matches the server's version. Put the settings in a file only root can read. Give the password as `PGPASSWORD`, not in the URL, so it stays out of your shell history and the process list:

```sh
# /etc/wikistow/backup.env
DATABASE_URL=postgres://wikistow@db:5432/wikistow
PGPASSWORD=<password>
BLOB_DIR=/data/blobs
```

```sh
docker run --rm --network <wikistow network> --env-file /etc/wikistow/backup.env \
  -v <wikistow data volume>:/data:ro \
  -v /srv/backups/wikistow:/backups \
  -v /path/to/wikistow/scripts:/scripts:ro \
  postgres:17-alpine sh /scripts/backup.sh /backups
```

The server keeps running. The script writes `/backups/wikistow-<UTC time>/`, holding `database.dump`, `blobs.tar` and their checksums in `SHA256SUMS`, and prints its path. Copy all three off the machine. It builds the backup as `.wikistow-<time>.partial` and renames it once it's complete. A failed backup removes its partial copy. One that was killed may leave it behind. Delete those.

Outside Docker, run `scripts/backup.sh` with the same settings in its environment. It needs `pg_dump` and `pg_restore` at the database's major version, `tar` and `sha256sum`.

## Schedule and retention

Back up daily and keep the last 14 days of backups, both here and off the machine. Make sure a failed run reaches you. Prune only after a backup succeeds, so failing backups never prune away the last good ones. In the container above, run this instead of the bare `backup.sh`:

```sh
sh -c 'sh /scripts/backup.sh /backups &&
  find /backups -mindepth 1 -maxdepth 1 -name "wikistow-*" -mtime +13 -exec rm -rf {} +'
```

Prune the off-machine copies the same way. Deleting an account doesn't reach into backups. Its data stays in every backup taken before the deletion until that backup is pruned, so for 14 days under this policy.

## Restoring

1. Stop the WikiStow server. Leave Postgres running. On a new host, don't start the server before you restore. Start only Postgres, so the restore goes into its empty database. Set up the data volume without starting the server with `docker run --rm -v <wikistow data volume>:/data <wikistow image> true`. Outside Docker, create `BLOB_DIR` yourself, owned by the user the server runs as.
2. Run `restore.sh` with `--server-stopped` and the backup's directory. It refuses to run without the flag, while the server runs, or while anything else is connected to the database.

   ```sh
   docker run --rm --network <wikistow network> --env-file /etc/wikistow/backup.env \
     -v <wikistow data volume>:/data \
     -v /srv/backups/wikistow:/backups:ro \
     -v /path/to/wikistow/scripts:/scripts:ro \
     postgres:17-alpine sh /scripts/restore.sh --server-stopped /backups/wikistow-<time>
   ```

3. Start the server with the same `BETTER_AUTH_SECRET` as before. It applies any migrations newer than the backup before it serves.

The script refuses if `BLOB_DIR` doesn't exist, or if the backup's files don't match `SHA256SUMS`, as when a copy was cut short. Outside Docker, it needs `psql` and `pg_restore` at the database's major version. It unpacks the files beside the live ones first, so a bad archive stops it before anything changes. Then it restores the database in one transaction. If that fails, the database stays as it was. Last, it swaps in the restored `objects/`. Run as root, it gives the files to whoever owns `BLOB_DIR`. If it fails at any step, fix the cause and run it again before you start the server. Running it again is safe. Stopped with Ctrl-C or SIGTERM, it stops `pg_restore`, whose transaction then rolls back, and removes what it unpacked. Once the database is restored, anything that stops it before the files are swapped in ends with "The database is restored, but the files aren't." Keep the server stopped and run it again.

A lock keeps the server and a restore apart. For as long as it runs, the server holds a Postgres advisory lock (key `8604526663720791927`, "wikistow" in ASCII) on a connection of its own. Its pooled connections are replaced once they reach their maximum lifetime; this one never is, whatever the environment or `DATABASE_URL` says of timeouts. It shows in `pg_stat_activity` as `wikistow-lock`. The server applies pending migrations in that same session before it serves, so a restore can't come between the two. `migrate.mjs` and `admin.mjs` hold the lock too while they run. They all share it, so a second server isn't refused by it. Migrations also take a second advisory lock (key `8604526663619405682`, "wikimigr") while they apply, so a server and `migrate.mjs` started together take turns and apply each migration once; a restore leaves it alone. The script takes the database lock alone, once it has checked `SHA256SUMS` and unpacked the files, and keeps it until it ends. So:

- While a server runs, even an idle one, the script refuses with "The WikiStow server, its migrations or another restore is using the database. Stop the server, then restore." Two restores can't run at once either.
- A server started once the script holds the lock exits with status 1 before it touches the database. It logs `database-locked` with "A restore is using the database. Start WikiStow again once it finishes." `migrate.mjs` and `admin.mjs` refuse the same way. Under a restart policy the container tries again until the restore ends, then starts normally. Without one, start it yourself once the script ends. A server started earlier, while the script checks and unpacks the backup, takes the lock first, and the script refuses as above.
- The script also refuses while other sessions are connected, with "N other connection(s) to the database are open". This catches clients that take no lock, such as `psql` or a server from before WikiStow took one. If it counts connections you can't place, look them up in `pg_stat_activity`.
- If the script's own lock session ends while it restores, as when Postgres restarts, a server may have started on the restored database. So before it swaps in the files, the script checks that it still holds the lock. If not, it stops with "The database is restored, but the files aren't: the restore lost its lock on the database". Stop any server, then run the restore again.

If the server loses its lock's connection, as when Postgres restarts, it logs `database-lock-lost` and exits with status 1, since a restore may have started meanwhile. Its restart policy brings it back, taking the lock first. An `idle_session_timeout` set for WikiStow's database or role would close either lock session while it sits idle, the server's or the script's, so both turn it off for themselves.

Always restore the original database. Never set up a fresh installation and copy content into it. A new installation gets a new installation ID, every signature and ciphertext is bound to the old one, and the apps refuse a server whose ID changed.

Restoring over the server's existing database works when it was last migrated by the same WikiStow version as the backup. If a newer version has migrated it since, drop and recreate the database first, then restore into the empty one.

## What a restore undoes

A restore puts everything back as it was at the backup, including changes made on purpose since. Sessions and agent credentials you revoked work again. Passwords people changed go back to the old ones. People removed from a share get back what they could read then. Deleted accounts return. Redo those changes afterward.

The CLI remembers the newest records it has seen, so it can catch a server that serves older ones. A restore of an older backup looks the same, so an agent may refuse with a rollback error afterward. A restore may need fresh enrollment of affected agents.

## Checking a restore

- `https://<your host>/api/installation` shows the same `installationId` as before. Write yours down now so you can compare.
- You can sign in with your password.
- You can unlock your vault with your passphrase.
- You can open a page with an attachment, and the attachment.
- Someone you share with can open a shared page.

## The restore drill

Run it every few months, and after any change to how you deploy. Restore the latest backup into a scratch database and an empty blob directory on a test instance, never the live one. Start a server on them with the same `BETTER_AUTH_SECRET`, and do the checks above. The test instance holds real accounts and sessions, so keep it off the internet, point its `SMTP_URL` somewhere that sends nothing, and delete it when you're done.

CI runs an automated drill on every change, in `apps/server/test/m4-restore.integration.test.ts`. It backs up a running installation and writes more. Then it restores onto another installation and starts the server on it. It checks that the installation ID is unchanged and that people sign in and decrypt their pages and attachments with their own keys. Last, it restores over the original installation and checks that nothing written after the backup came back. Beside it, `apps/server/test/restore-lock.integration.test.ts` starts the real server to check the lock: the script refuses while an idle server holds it, a server or migrations started mid-restore refuse to start, a restore stopped mid-restore cleans up and lets go, and one whose `pg_restore` fails leaves the database as it was. Locally both need `pg_dump`, `pg_restore` and `psql` 17 on your `PATH`, from `postgresql-client-17` on Debian and Ubuntu.
