# Sharing-cost benchmark

Protocol section 17, Q8, asked PR 3 to measure what sharing costs on a library of family size, and to decide whether making a share needs a split upload. This page reports the run at the end of Milestone 2, with the first run's figures beside it.

## What was measured

A family library: 5 spaces, 2,000 pages (400 per space, in 8 folders each), 20 versions per page (15 drafts and 5 publications), 500 attachments (one on every fourth page, carried in the page payloads), and 10 people besides the owner.

The pages are seeded straight into the database as the owner's app would have written them over time: real v2 records, each sealed to the owner in a v2 envelope. Everything timed afterwards goes through the client operations and the real server, in process, over the HTTP routes:

| Step | Operation | What it does |
|---|---|---|
| Share | `shareFolder`, whole space, 9 people (3 readers, 6 editors) | scans the space's 8,009 records, opens each content key through the owner's envelope and checks it, wraps it under version 1, seals version 1 to the owner and the 9 people, and sends it all in one request |
| Add member | `addMember`, the 10th person as an editor | seals version 1 to them |
| Remove | `removeMember`, one editor | fetches version 1's envelopes, verifies them, works out who remains, seals version 2 to the 9 who stay |
| Add co-owner | `addCoOwner` on the fifth space, before it is shared | opens all 8,009 owner-region content keys and seals each to the new owner in a v2 envelope |
| Publish elsewhere | `previewPublication` and `publishToSpace`, one page of each space into the next, after all are shared | opens one published version, checks who can read it there, opens the destination, and sends one copy wrapped under the destination share's published key |

The benchmark is `apps/server/bench/sharing-cost.ts`, in the `bench` project, which CI doesn't run. It needs the test Postgres, as the integration tests do. To run it:

```
WIKISTOW_BENCH=/path/to/results.json pnpm exec vp test --project bench \
  apps/server/bench/sharing-cost.ts
```

## Results

2026-10-07, at the end of Milestone 2, on the same host: an AMD EPYC 7401P (8 threads available to the run, with other work keeping the load average near 10), 23 GB of RAM, Node 26.10, and Postgres 17 in Docker. Request size is the JSON body the client sent.

| Space | Records | Share | Share request | Add member | Remove (rotate) | Publish elsewhere |
|---|---|---|---|---|---|---|
| 1 | 8,009 | 13.7 s | 2.1 MB | 0.19 s | 0.22 s | 0.34 s, 4.3 kB |
| 2 | 8,009 | 13.2 s | 2.1 MB | 0.12 s | 0.22 s | 0.27 s, 4.3 kB |
| 3 | 8,009 | 13.5 s | 2.1 MB | 0.15 s | 0.22 s | 0.27 s, 4.3 kB |
| 4 | 8,009 | 13.2 s | 2.1 MB | 0.13 s | 0.19 s | 0.27 s, 4.3 kB |
| 5 | 8,009 | 13.5 s | 2.1 MB | 0.13 s | 0.26 s | 0.21 s, 4.3 kB |
| **All five** | 40,045 | **67.1 s** | 10.5 MB | 0.72 s | 1.1 s | 1.4 s |

Adding a co-owner to the fifth space while its 8,009 records were all in the owner region took **16.4 s**, with a 3.2 MB request. Seeding the library took 154 s.

The first run, on 2026-10-06 (PR 3, 12 threads, a quieter host), took 58.7 s to share all five spaces (10.9 to 13.5 s each, 2.1 MB each), 0.67 s to add a member to each, 2.0 s to remove one from each, and 17.4 s to add the co-owner. Making a share costs about 1.7 ms per record now against 1.5 ms then, which the busier host can account for. Removals were faster this time (1.1 s against 2.0 s for all five).

## What it shows

- **Making a share is the one expensive step**, and its cost grows with the records it covers: about 1.5 to 1.7 ms per record, for the client's opening, checking and wrapping of each content key and the server's checks and inserts together (this run didn't split the two). A whole family library shares in about a minute, one space at a time. That is acceptable for an action an owner takes once per folder, behind a confirmation dialog.
- **The upload stays small enough for one request.** Each wrap is about 260 bytes of JSON, so a space of 8,000 records sends about 2 MB, well inside the 64 MiB limit the share, rotation and co-owner routes allow. Q8's split upload under an open operation isn't needed at this size. A single space of about 250,000 records would reach the limit; that is far beyond a family library, so the split is left for a later milestone if anyone gets near it.
- **Adding and removing people doesn't depend on the library's size.** Adding a member seals one envelope per key version; a removal seals one per remaining person. Neither touches the records, so both take a fraction of a second.
- **Publishing a page into another space costs the same in any library**: one version opened, checked and sealed again, and one small request, about a quarter of a second here. It touches no other record, and its attachments are each one download and one upload.
- **Adding a co-owner costs like a share** of the owner-region records, about 2 ms per record, because each content key is sealed to them individually. Records already in shares cost one envelope per key version instead.
