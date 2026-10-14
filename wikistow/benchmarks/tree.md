# Tree-load benchmark

Issue #16 asked for titles without downloading every draft on each tree load. Milestone 3's first PR keeps opened revisions in session memory. This measures what a cold load still costs, for an owner, an editor and a reader, and the saves that used to download the whole space again.

## What was measured

Spaces of 200 and 2,000 pages. Each page has a draft and its publication, both with the same 4,180 bytes of Markdown. The benchmark seeds real v2 records sealed to the owner. It then runs the shared client against the real server's HTTP routes in process.

1. The owner loads the tree cold (cache cleared) and warm.
2. The owner autosaves: it passes the base region already opened, writes one new draft with a changed title and body, then reloads the entire tree. The timing includes the write and the reload. The editor normally patches the tree locally, so most browser saves do less work than this.
3. The owner shares the whole space with an editor and a reader. Each then loads the tree cold and warm. The editor's titles come from drafts and the reader's from publications.

Each load is timed three ways, and each figure is the median of three runs:

- **Cold**: the whole load, as the app does it.
- **Server**: the revision batch route alone, called directly in batches of 200, one after another, for the same heads.
- **Client**: the same load with every revision answered at once from a recording of the cold load. This covers the tree route, pinning authors, and verifying and decrypting each head.

The server and client share one Node thread here, so the two can't overlap the way they would over a network. Cold is roughly server plus client, and the parallel batches mostly overlap Postgres work.

The benchmark is `apps/server/bench/tree-cost.ts`, in the `bench` project, which CI doesn't run. It needs the test Postgres, as the integration tests do. To run it:

```
WIKISTOW_BENCH=/path/to/tree.json pnpm exec vp test --project bench \
  apps/server/bench/tree-cost.ts
```

## Results

2026-10-07, AMD EPYC 7401P (8 threads), Node 26.10, Postgres 17 in Docker at port 5433. Other agents kept the load average between 8 and 16, so single figures move by up to a third between runs. "Before" is the branch as first reviewed (ec18cdd). "After" adds the batched access check on the server and three batches in flight on the client. The two were run alternately, twice each; the tables give both runs.

### 2,000 pages

| Who | Cold before | Cold after | Server before | Server after | Client before | Client after | Warm after |
|---|---|---|---|---|---|---|---|
| Owner | 10.5 s, 14.7 s | 4.5 s, 4.7 s | 8.0 s, 10.6 s | 1.1 s, 0.95 s | 2.7 s, 3.2 s | 3.1 s, 3.1 s | 0.20 s, 0.23 s |
| Editor | 17.3 s, 22.1 s | 3.5 s, 4.0 s | 15.7 s, 18.2 s | 0.98 s, 1.0 s | 1.9 s, 2.1 s | 2.1 s, 2.9 s | 0.20 s, 0.27 s |
| Reader | 21.4 s, 22.2 s | 3.5 s, 3.7 s | 20.0 s, 32.3 s | 0.93 s, 0.85 s | 2.1 s, 2.0 s | 1.9 s, 2.4 s | 0.19 s, 0.19 s |

### 200 pages

| Who | Cold before | Cold after | Server before | Server after | Client after | Warm after |
|---|---|---|---|---|---|---|
| Owner | 1.0 s, 2.0 s | 0.67 s, 0.69 s | 0.84 s, 1.3 s | 0.09 s, 0.13 s | 0.38 s, 0.46 s | 0.08 s, 0.07 s |
| Editor | 1.9 s, 1.9 s | 0.51 s, 0.38 s | 1.6 s, 1.9 s | 0.07 s, 0.09 s | 0.27 s, 0.23 s | 0.06 s, 0.04 s |
| Reader | 1.9 s, 2.5 s | 0.39 s, 0.39 s | 1.6 s, 2.1 s | 0.10 s, 0.10 s | 0.25 s, 0.30 s | 0.06 s, 0.05 s |

Every cold load fetched all its heads: 200 in one request, or 2,000 in ten. Every warm load and every autosave fetched none. Autosave with a full tree reload took 0.18 to 0.54 s.

The revision responses were 1.4 MB for 200 pages and 13.96 to 14.38 MB for 2,000, counting encrypted payloads and key material. The owner's are a little larger: each head carries an envelope instead of a key wrap. The cache holds about 19 MB for 2,000 of these heads, inside its 32 MiB limit. No decrypted content is stored on disk.

## What changed

- **The server checked access page by page.** For each page in a batch, it found the share holding it, checked ownership and membership, and, for readers, read the reader history: two to five queries per page, one after another. That was most of a cold load, and readers paid the most. It now works out a whole batch in a fixed handful of queries. One query gets the nodes on the pages' paths up, and the space's shares, the caller's memberships or grants, and the reader histories each come in one more. They all read one snapshot, in a read-only transaction that takes no locks, so a move or unshare landing between two of them can't mix two trees. It walks the tree the way the tree route already does. A test compares the result with the old per-page check over random spaces with every role. The route now costs about 0.5 ms per head for everyone, against 4 to 16 ms before.
- **The client asked for one batch at a time.** It now keeps up to three batches out at once and opens each as it arrives. Each answer still counts only for the batch that asked, and only its own deferred revisions are asked for again. The gain is small in process, where server and client share a thread. Over a real network, opening one batch overlaps downloading the next.

## What it costs now

At 2,000 pages a cold load takes about 3.5 to 4.7 s on this host, against 10 to 22 s before. What's left is mostly the client: 2 to 3 s to verify and decrypt 2,000 heads on one thread. The owner's heads cost more to open because each comes through its own envelope. Warm loads take about 0.2 s, and saving fetches nothing.

The bytes haven't changed, and a browser must still download every visible head once per session: 14 MB at 2,000 pages. That is about 2.3 s at 50 Mbps and 11.5 s at 10 Mbps, before any of the work above. On a slow connection, then, the download is the larger part of a cold load. Only a smaller record can fix it: the approved fallback, a signed per-revision summary in revision-record v3, would carry the title without the body. That change is the owner's decision; this PR makes no protocol change. The client's time, unlike the download, has protocol-free options left: verifying and opening heads in a pool of Web Workers, and opening the heads in collapsed folders only after the first paint.

Locking permanently closes the session's cache. Access refresh clears it and rejects late entries from the earlier generation. Content reads use cached immutable payloads. Writes that need a region or key version fetch fresh records, because sharing and moving can rewrap an unchanged revision ID.
