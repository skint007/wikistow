---
status: accepted
---

# Searching pages by meaning, on the device

Search finds a page only by its words: "trip to the coast" doesn't find a page about a beach holiday in Cornwall (#324). This ADR decides how search also finds pages by meaning, with a small embedding model that runs in the person's own app. It covers the model, where and how it runs and how it gets there, phones, the vectors and how they are kept, how results show in the search dialog, what the server learns, and who else uses it. Scott accepted every recommendation on 2026-11-13 (**Decided**, below).

In short:
- **A small English model, `bge-small-en-v1.5`** (MIT, 384 dimensions), in its 8-bit ONNX form: 34 MB, 23 MB with Brotli. In the spike it found the page meant first for 28 of 36 queries that today's word search can't match, and among the first three for 32. One query takes 13 ms and a short note about 40 ms, on one thread.
- **ONNX Runtime Web, on WebAssembly, in a worker of the app's own,** with Hugging Face's tokenizer library, not transformers.js. It runs under today's Content Security Policy unchanged: the spike served it with the app's exact headers and saw no violation.
- **The model comes from WikiStow, never from a third party.** The desktop app ships it. The browser fetches it from the WikiStow server the first time the person turns this on, and keeps it.
- **Where it runs:** on by default in the desktop app; in a computer's browser when the person turns it on, with **Keep for offline** on Every page; not on phones yet.
- **Vectors by section.** Each page is cut at its headings into passages of at most 256 tokens. Each passage becomes a vector of 384 bytes. They are kept beside the word index, sealed for the person in a file of their own, and dropped from memory when the vault locks. 1,000 pages take about 0.8 MB, 10,000 about 8 MB.
- **Word matches first, then "By meaning".** The search dialog lists word matches as today. Below them, a **By meaning** section lists up to five other pages close in meaning. `tag:` and property filters narrow both lists.
- **The server learns nothing new from the desktop app.** From a browser it learns that this person fetched the model, and when. It never sees queries, vectors or text.
- **Agents, the CLI, MCP and plugins** keep word search for now.

## What the code supports today

- **Word search, on the client.** `SearchIndex` (`packages/client/src/search.ts`) is an inverted index of each page's title and its text as `searchText` reduces it (one line per paragraph, a heading a paragraph of its own, at most 65,536 characters). Beside each page it keeps its properties and links, which filters and lookups read page by page. `parseSearch` splits a query into words and filters (`tag:soup`, `key:value`); quotes only make text count as words (`"10:30"`), not a phrase. A page must hold every word. Words rank the results; filters only narrow them. `PageIndex` (`packages/client/src/operations/search.ts`) adds lookups for query tables, folder tables and **Linked from**.
- **Which version.** The index holds each page in the version its viewer sees: the published version for readers, the draft for editors. It keeps each page by the revision ID it read. A version's content never changes, so what the index read from it stands in for it later.
- **Kept between sessions, sealed.** With **Keep for offline** on Every page, the index is kept: in the desktop app with a trusted keyring as the `search-index` file in its data folder, in the browser in IndexedDB (`searchIndexFile`, `packages/ui/src/data/index-file.ts`). `sealKept` seals it with `sealOnDevice` under a key derived from the person's identity key (`search-index-key/v1`), bound by `canonical('search-index/v1', [installationId, identityId, build])`. So the desktop's main process holds only bytes it can't read, and another build's file opens as nothing and every page is read again. With Pages I open, the index stays in memory and one kept before is deleted. Lock and logout clear it from memory, and logout deletes the kept file.
- **Updates.** The index updates when this person changes a page or the tree's stream says a space changed (`searchIndexChanged`, `updateIndex`). It opens only the versions it doesn't hold. A draft this person saves goes in as written.
- **The search dialog** (`shell/search-dialog.tsx`) lists results as you type: title, path and snippet, with the words matched marked. A plugin can draw a word search's results in place of the list (`search.results`, ADR 0011).
- **Who else searches.** The in-app chat assistant's `search` tool (`packages/client/src/agent-tools.ts`) builds an index afresh from the assistant's own trees on each call. `wikistow search` and MCP do the same from the CLI, a Node script (`apps/cli`). The plugin host's search builds one for the plugin's spaces (`plugins/pages.ts`).
- **The policy** (`packages/contracts/src/security.ts`) is `script-src 'self' 'wasm-unsafe-eval'`, `connect-src 'self'`, `worker-src 'self'`, sent by the server and by the desktop app's `app://` handler. `'wasm-unsafe-eval'` was added for libsodium. The headers include `Cross-Origin-Opener-Policy: same-origin` but no `Cross-Origin-Embedder-Policy`, so the app isn't cross-origin isolated and has no `SharedArrayBuffer`.
- **Static files** are served as they are on disk (`serveStatic` in `apps/server/src/http/static.ts`), with no compression, and `/assets/*` cached for good.
- **Large files served on demand.** Workshop's esbuild (`esbuild.wasm`) is a hashed file under `/assets/`, which the service worker leaves out of the files it keeps (`appShell`, `apps/web/vite.config.ts`), so only someone who opens Workshop downloads it. The desktop app serves the web build (`apps/web/dist`) from disk, unchanged.
- **Devices.** `useDevice` (`packages/ui/src/plugins/devices.tsx`, #405) tells the desktop app, a computer's browser and a phone apart, a phone being wherever the app shows its phone layout.
- **No embedding or vector code** anywhere in `packages/*` or `apps/*`.

## Decisions

### 1. The model

**`BAAI/bge-small-en-v1.5`**, in the 8-bit ONNX form `Xenova/bge-small-en-v1.5` publishes (`onnx/model_quantized.onnx`).

| | |
| --- | --- |
| Licence | MIT, on the model card |
| Size on disk | 34.0 MB, 23.3 MB with Brotli; its tokenizer 0.7 MB, 0.15 MB |
| In memory | about 170 MB more for the browser once loaded and in use, 233 MB just after loading (spike) |
| Languages | English |
| Output | 384 dimensions, from its first token (CLS); queries take the prefix `Represent this sentence for searching relevant passages: ` |
| Input | up to 512 tokens |
| Published quality | 51.68 on MTEB's 15 retrieval tasks, the card's own table |
| On short notes (spike) | the page meant first for 28 of 36 queries, among the first three for 32 |
| Time, one thread | a query 13 ms; a passage of 64 tokens 59 ms, 128 tokens 93 ms, 256 tokens 207 ms |

Among the small models, it has the highest published retrieval score, a licence with no conditions on use, and a size a browser can fetch once. On the spike's short notes it does as well as the others (table below). Quality on short notes was measured with 33 notes of the kind a family keeps (a holiday, a recipe, the boiler, the vet; three in French, German and Spanish), and 36 queries written in other words than the note each means. Today's word search (`SearchIndex`) finds the note meant for none of them, since a page must hold every word; two queries share a word with their note ("pasta bake dinner", "heating keeps losing pressure"), and others share only words like "the".

| Model | Licence | 8-bit size | Languages | First | First three | Time for 128 tokens |
| --- | --- | --- | --- | --- | --- | --- |
| `bge-small-en-v1.5` | MIT | 34 MB | English | 28 | 32 | 93 ms |
| `all-MiniLM-L6-v2` | Apache-2.0 | 23 MB | English | 29 | 32 | 48 ms |
| `snowflake-arctic-embed-xs` | Apache-2.0 | 23 MB | English | 27 | 30 | 49 ms |
| `multilingual-e5-small` | MIT | 118 MB, tokenizer 17 MB | about 100 | 28 | 35 | 101 ms |

- **`all-MiniLM-L6-v2`** is as good on these notes and twice as fast, with six layers to bge's twelve. Its card publishes no retrieval score, it was trained on 128 tokens, and it cuts input at 256 word pieces. It is the choice if indexing time matters more than retrieval on longer pages (Decide 1).
- **`snowflake-arctic-embed-xs`** is as fast as MiniLM and takes 512 tokens, with 50.15 on MTEB retrieval by its card, but did least well here.

Times are from the runtime's WebAssembly build. The e5 time was taken with its WebGPU build, whose WebAssembly path took up to a third longer on short texts and within 15% from 128 tokens up, for the other three, because later runs of e5 met other work on the machine (spike).
- **`multilingual-e5-small`** did best on the three notes in French, German and Spanish: of the five queries meant for them, two in French and German and three in English, it found four first, bge three, and MiniLM and arctic two. But it is more than three times the download (77 MB with Brotli, plus a 2.5 MB tokenizer), it took about 610 MB more memory, and its scores fall in a narrow band, which makes a cut-off for **By meaning** harder (spike). Decide 1.
- **Larger models**, such as `embeddinggemma-300m` (175 to 309 MB, and the Gemma terms of use, with conditions on use and a gated download) or `Qwen3-Embedding-0.6B` (568 MB at its smallest), are too big for a browser to fetch.
- **Static embeddings** (`static-retrieval-mrl-en-v1`, Apache-2.0, 31 MB at 8 bits) need no attention layers and no runtime, and so might suit phones, but their card puts them at 87.4% of `all-mpnet-base-v2` on NanoBEIR. Not measured here.

The model is named in the kept vectors (decision 4), so changing it later re-embeds every page in the background, with nothing lost.

### 2. The runtime

- **ONNX Runtime Web 1.31** (MIT), its WebAssembly build alone, in the form with its loader bundled in (`ort.wasm.bundle.min.mjs`, 77 KB) and `ort-wasm-simd-threaded.wasm` (14.8 MB, 2.4 MB with Brotli), which the app hands it as bytes (`env.wasm.wasmBinary`), with **`@huggingface/tokenizers` 0.2.0** (Apache-2.0, no dependencies, which transformers.js also uses). The app does the model's few steps around them itself: the query prefix, cutting input to 512 tokens, taking the first token's vector and normalizing it.
- **In a worker of the app's own**, a module worker from the app's origin, so typing and scrolling never wait on it. It takes text and gives back vectors, and keeps nothing on purpose: the vectors live with the word index (decision 4). The app starts it when there is something to embed or when the search dialog opens, keeps it while either lasts, and stops it a minute after, which gives its memory back. Starting it again costs about 0.35 s for the session and a first embedding, plus reading the model back from its cache, and the word matches don't wait for it (decision 6).
- **WebAssembly, one thread.** Threads need `SharedArrayBuffer`, which needs the app to be cross-origin isolated (`Cross-Origin-Embedder-Policy`). With four threads the spike ran nearly three times as fast, but isolation changes how the sandboxed plugin and diagram frames load, so it is later work. **WebGPU** is too: on this machine's GPU it ran 13 times as fast on a 256-token passage, but only with the model's 32-bit form (133 MB), since the 8-bit one ran slower there than on WebAssembly, and its 16-bit form needs a feature this GPU lacks. That would mean a second download, and the runtime's WebGPU build (`ort.webgpu.min.mjs`, whose WebAssembly file is 28.7 MB) in place of the WebAssembly one.
- **The policy doesn't change.** `'wasm-unsafe-eval'` lets the runtime compile its WebAssembly, as it lets libsodium. Its JavaScript loads from the app's own files (`script-src 'self'`), the worker from the app's origin (`worker-src 'self'`), and the model with `fetch` from the server (`connect-src 'self'`). The spike served all of this, with the WebAssembly build, under the app's exact headers, and Chromium reported no violation.
- **Not transformers.js.** Version 4.3.2 brings `onnxruntime-node` and `sharp` as dependencies, and by default fetches models from `https://huggingface.co/` (`allowRemoteModels: true`, `remoteHost`) and points its runtime's files at jsDelivr, and does far more than the app needs. The pieces it is made of, used directly, are smaller and do only what is asked.
- **The desktop app runs it the same way, in its pages.** A Node runtime (`onnxruntime-node`) in the main process would be faster, with threads, but would put decrypted text in the main process, which today holds only bytes it can't read (#3).

### 3. Getting the model there

- **Never from a third party.** The model and the runtime are files of the app's own build: hashed files under `/assets/`, served by the WikiStow server like any other. The build writes a Brotli copy of each beside it, and the server serves `/assets/*` with `serveStatic`'s `precompressed` option, which covers `application/wasm` and the model's `application/octet-stream`; today it compresses nothing, so the browser would otherwise fetch about 50 MB. The build fetches the model from Hugging Face at a pinned revision and checks its SHA-256, which the repository records, so a changed upload fails the build. Its licence goes into the app's third-party notices.
- **The desktop app ships it**, since it serves the web build from disk, without the Brotli copies, which packaging drops. That makes it about 50 MB larger before compression. Nothing is fetched.
- **The browser fetches it once,** when the person turns on search by meaning in that browser (decision 5): 23.3 MB for the model, 2.4 MB for the runtime's WebAssembly and 0.15 MB for the tokenizer, about 26 MB with Brotli. The service worker leaves those three out of the files it keeps, as it does Workshop's esbuild, and every Brotli copy too, so nobody downloads them who doesn't use them. The runtime's and the worker's JavaScript, about 80 KB, stay in the files it keeps, since only the service worker can answer a script's `import` offline. The embedding worker keeps the three in a cache of its own, named for the model's hash and not starting `wikistow-app-`, so a new build's service worker doesn't delete it, reads them from there, and hands the runtime its WebAssembly as bytes. Turning it off, or signing out, deletes that cache. Offline, a browser that has it runs as online. The spike ran the bundled build this way, under the app's policy.

### 4. Vectors

- **By section.** A page is cut at its headings, from its text as the word index reduces it (`searchText`), so code, links and syntax read as they do for words. A section longer than 256 tokens is cut again at paragraph breaks, and a paragraph longer than that at 256 tokens. Each passage starts with the page's title, and the heading it is under, so a section about "Method" knows it is a lasagne's. A short page is one passage. A page's first 65,536 characters of text are embedded, as much as the word index keeps. The reduction marks where each heading starts, which it doesn't today. Passages of 256 tokens rather than the model's 512 cost less (a 512-token passage takes 2.5 times as long as a 256-token one, not twice), match short queries better, and let a result point at its section.
- **Kept small.** Each vector is kept as 384 signed bytes with one scale, about 0.4 KB with its place in the page. In the spike that changed the rank of one query's page in 36, by one place.
- **Kept by version.** Vectors are kept by revision ID, as the word index keeps a page's text, and each passage's by a hash of its text. So a new version embeds only the passages whose text changed: an edit to one section embeds one passage again.
- **When.** In the background, after the word index is built: each page whose shown version has no vectors yet, one passage at a time, so a search or a page opening never waits behind a long run. On unlock, the kept vectors open with the vault, and only versions without them are embedded. A draft this person is typing is embedded once its saves have paused for 30 s, not on each autosave; until then the page keeps the vectors of the version before. A page that leaves the word index leaves the vectors at the same update. The search dialog's status line shows the progress ("By meaning: 340 of 1,200 pages so far").
- **How long.** On this laptop, on one thread, the spike embedded 837 KB of the spec's Markdown, cut into 1,074 passages of about 180 words, many of them past 256 tokens, in 226 s: about 4 KB a second. Passages as decided here are shorter, and the reduced text has less syntax in it, so this errs slow. At an assumed 1.5 KB a page, 1,000 pages take about 7 minutes the first time, and 10,000 over an hour, spread over as many sessions as it takes, since what is done is kept.
- **Sealed like the word index.** The vectors are kept in a file of their own: `meaning-index` beside `search-index` in the desktop's data folder, and an entry beside the index's in the browser's IndexedDB. It is sealed with `sealOnDevice` under a new key domain, `meaning-index-key/v1`, bound by `canonical('meaning-index/v1', [installationId, identityId, modelHash, passagesVersion])`. It is bound to the model and to how passages are cut, not to the app's build, so an app update doesn't embed every page again. It is kept exactly where the word index is, and goes when it goes: with **Keep for offline** on Every page, in the browser or the desktop app with a trusted keyring. Logout deletes it, as do a new sign-in in the desktop app and a sign-in to another account in the browser. It is written once embedding pauses, at least once a minute while it goes on, and at once after a page leaves.
- **Locking** drops the vectors from memory with the word index, and stops the worker, whose memory may still hold the last text it was given. Grant changes rebuild them from the fresh listing, as the word index is rebuilt, keeping the vectors of versions still shown.
- **Size.** About two passages a page at 1.5 KB a page:

  | Pages | Passages | Kept, and in memory | One search |
  | --- | --- | --- | --- |
  | 1,000 | about 2,000 | about 0.8 MB | under 1 ms |
  | 10,000 | about 20,000 | about 8 MB | about 7 ms |

  A search compares the query's vector with every passage's (spike: 10 ms for 30,000), so no approximate index, such as HNSW, is needed at these sizes.

### 5. Where it is on

| Device | Search by meaning |
| --- | --- |
| Desktop app with a trusted keyring and **Keep for offline** on Every page, its default | On by default; Settings can turn it off on this device |
| A computer's browser with **Keep for offline** on Every page | Off until the person turns it on in Settings, which says it downloads 26 MB once and indexes in the background |
| A browser with Pages I open, or the desktop app without a keyring | Not offered: the setting says it needs Every page, since vectors made each session would cost minutes each time |
| A phone (the phone layout) | Not offered yet |

- **Per device**, as **Keep for offline** is: a device setting, kept on the device, not synced, since the cost is the device's.
- **Phones are off** for now. The spike measured a laptop's processor; Chromium's CPU throttling doesn't reach a worker, so it says nothing about a phone. The 170 MB more memory, and minutes of a core in the background, are a lot for a phone's browser, which keeps only the pages opened on it unless the person turns on Every page. Vectors made on the person's computer won't help, since they never leave it. Building step 2 measures the model on a real phone before anything is offered there.
- **No switch for the administrator.** Nothing leaves the device, and the server only serves a file.

### 6. In the search dialog

```
┌─ Search ──────────────────────────────────────────────┐
│ 🔍 trip to the coast                                  │
│ 2 pages with these words · 3 more by meaning          │
│ ───────────────────────────────────────────────────── │
│ Coast path walk                                       │
│ Family › Walks                                        │
│ …the coast path from Zennor, a trip of 3 hours…       │
│ Ferry to the Isle of Wight                            │
│ Family › Trips                                        │
│ …our trip on the ferry, the coast at Ryde…            │
│ BY MEANING                                            │
│ Summer holiday in Cornwall                            │
│ Family › Holidays                                     │
│ We rented a cottage in St Ives for a week in August…  │
│ Flights to Lisbon                                     │
│ Packing for the beach                                 │
└───────────────────────────────────────────────────────┘
```

The last two rows have a path and snippet too, left out here.

- **Word matches stay as they are**, first, in today's order, with their words marked. A name, a code or a phrase someone types finds exactly what it did.
- **Then By meaning:** up to five pages not already listed, best first, each with its title, path, and as its snippet the start of the passage that matched best, with no marks, since no word matched. A page counts by its best passage. A page shows only when it is close enough: above a floor, and not far below the best, tuned on a set like the spike's. In the spike a page meant scored 0.46 to 0.75, while 95 of every 100 other pages scored under 0.54, so a floor alone can't separate them, and **By meaning** shows a few.
- **One list for the keyboard.** Up and Down move through both parts, and the section's label isn't a stop. A screen reader hears the label as the group's name. Where a plugin draws the word matches, **By meaning** is the app's own list below the plugin's, and the box's Up and Down move within it as they do today when there's no plugin.
- **When it runs.** Once typing pauses for 150 ms, for a query whose words hold at least three letters. It isn't run for filters alone. Quotes make no difference to it, as they make none to word matches but to keep text from reading as a filter. While the worker starts, about 0.35 s, the word matches show at once and the section follows.
- **Filters apply.** `tag:` and `key:value` narrow **By meaning** as they narrow word matches, with the same test of each page's properties, and the vectors are made from the words without the filters. So `tag:recipes something warming` lists recipes close in meaning to "something warming".
- **Everywhere else stays words.** **Linked from**, query tables, folder tables and `#search=` links are unchanged; a `#search=` link opens the dialog, which then shows **By meaning** too. A plugin drawing a word search's results (`search.results`) still gets the word matches only, and the app draws **By meaning** below it.
- **While indexing,** the section holds what is embedded so far, and the status line says how far it has got.

The alternative, one list ranked by both (reciprocal rank fusion, for one), finds more in benchmarks. But it moves word matches around, and puts pages with no word in common between them with no sign why. Decide 6.

### 7. What the server learns

- **From the desktop app, nothing new.** The model is in the package, and queries, vectors and passages stay in the app's memory and its sealed file.
- **From a browser,** that this person fetched the model files, and when: the request carries their session cookie, as every request for the app's files does. So the server can tell who has search by meaning on in some browser. It learns nothing else: no queries, no vectors, no counts of passages, and nothing of how often anyone searches. The protocol's A7 gains this line once accepted.
- **Vectors count as content.** Text can be largely recovered from its embedding (Morris et al., "Text Embeddings Reveal (Almost) As Much As Text", 2023). So vectors are never sent anywhere, are sealed like the word index, and go wherever decrypted content goes at lock and logout.
- **Served code** is as before (A9): a server that serves the app's JavaScript can read what the app reads, model or no model. Fetching the model from the WikiStow server, under a hash the build pins, adds no party to trust.

### 8. Agents, the CLI and plugins

- **The chat assistant** keeps word search in its `search` tool. It builds its index afresh from its own trees on each call, and making vectors for every page it can read, on each call, would take minutes. It could later use the person's kept vectors for versions both indexes hold, since they are kept by revision ID. A model that writes its own queries can also try several words.
- **The CLI and MCP** keep word search. The CLI builds its index afresh for each command and keeps no index, so it would have to embed every page each time, and ship the model too. An agent's own model can search with several words.
- **Plugins** keep the host's word search, unchanged.

### 9. Out of scope

- phones, and a smaller model for them;
- WebGPU, and threads with cross-origin isolation;
- a model for other languages, or several models to choose from;
- meaning search for the chat assistant, the CLI, MCP and plugins;
- **Linked from**, related pages, query tables or folder tables by meaning;
- embeddings made by the administrator's AI provider, which would send each page's text to it, and so would need to be opt-in with a disclosure like the chat assistant's;
- attachments' text, such as PDFs and images;
- a second model that re-ranks results, and answers to questions.

## Spike evidence (2026-11-13)

A throwaway spike (`~/.cache/wikistow-tmp/adr-semantic-search/spike/`, not committed) used ONNX Runtime Web 1.31.1 and `@huggingface/tokenizers` 0.2.0 in a module worker in Chromium 153 (Chrome for Testing, through Playwright), on an Intel Core Ultra 9 185H with 93 GB of memory, served by a small Node server with the app's exact security headers. Every model was the 8-bit ONNX form from Hugging Face, on WebAssembly, on one thread (the page wasn't cross-origin isolated), with the runtime's WebAssembly build (`ort.wasm.min.mjs`), unless noted. The first round ran with its WebGPU build (`ort.webgpu.min.mjs`), which also runs WebAssembly; on the same models its times were up to a third longer on short texts and within 15% from 128 tokens up, its sessions took twice as long to make, and the pages found were the same. Runs while other work loaded the machine (a load average near 10) were up to twice as slow, and their times are left out, but for `multilingual-e5-small`'s load; its load and memory below come from such a run, which slows time, not memory.

- **The policy held.** With the app's Content Security Policy, the worker loaded each build of the runtime (WebGPU, WebAssembly, and the bundled WebAssembly one with its `.wasm` passed as bytes), compiled its WebAssembly and fetched the model with no violation reported, in the page or the worker.
- **Load.** Making the runtime's session took 0.26 to 0.29 s for the 23 to 34 MB models, and 0.64 s for `multilingual-e5-small`, in a run under load, after a local fetch; the first embedding then took about 40 ms more.
- **Memory**, the resident size summed over the browser's processes, against about 970 MB before, read once just after loading (a first embedding included) and once after embedding the spec; a sum counts pages the processes share more than once:

  | Model | Just after loading | After embedding the spec |
  | --- | --- | --- |
  | `all-MiniLM-L6-v2` | +195 MB | +173 MB |
  | `bge-small-en-v1.5` | +233 MB | +170 MB |
  | `snowflake-arctic-embed-xs` | +198 MB | +177 MB |
  | `multilingual-e5-small` | +733 MB | +612 MB |

- **Time to embed one text, by its length in tokens,** median of seven:

  | Model | 32 | 64 | 128 | 256 | 512 |
  | --- | --- | --- | --- | --- | --- |
  | `all-MiniLM-L6-v2` | 12 ms | 24 ms | 48 ms | 107 ms | (cut at 256) |
  | `bge-small-en-v1.5` | 30 ms | 59 ms | 93 ms | 207 ms | 519 ms |
  | `snowflake-arctic-embed-xs` | 12 ms | 24 ms | 49 ms | 111 ms | 273 ms |
  | `multilingual-e5-small`, WebGPU build | 26 ms | 49 ms | 101 ms | 223 ms | 571 ms |
  | `bge-small-en-v1.5`, four threads, cross-origin isolated, WebGPU build | 10 ms | 18 ms | 37 ms | 79 ms | 173 ms |
  | `bge-small-en-v1.5`, 32-bit, WebGPU on a GTX 1080 | 11 ms | | 12 ms | 16 ms | 23 ms |
  | `bge-small-en-v1.5`, 8-bit, WebGPU on a GTX 1080 | 196 ms | | 314 ms | 452 ms | 728 ms |

  A query took 13 ms with bge (median of 36), 4 ms with MiniLM. With the WebGPU build, the 32-bit bge on WebAssembly took 1.5 times as long as the 8-bit one, and found one page more first (29). WebGPU ran under Xvfb; headless Chromium offered only SwiftShader, a software GPU. The 16-bit form failed there: Pascal GPUs lack `shader-f16`.
- **Throughput**, with the WebGPU build. The spec's own Markdown (`wikistow.md`, `ui-design.md`, `CONTEXT.md` and the ADRs, 837 KB), cut at headings and then at paragraphs into 1,074 passages of about 180 words, embedded one at a time: bge in 226 s (median 217 ms a passage; 388 passages were past 256 tokens, up to its 512), MiniLM in 124 s (with 399 passages cut at its 256). Cut only at headings, 316 sections, 137 of them cut at 512 tokens: bge 127 s, and 118 s with the WebAssembly build.
- **Quality on short notes**, 36 queries, each meaning one of 33 notes and written in other words, so that today's `SearchIndex` finds the note meant for none: the table in decision 1. Three notes are in French, German and Spanish, and two of the five queries for them in French and German; `multilingual-e5-small` found four of the five first, bge three, MiniLM and arctic two. Keeping vectors as 8-bit integers with one scale each changed one query's rank by one place, for bge, and none for MiniLM.
- **Scores.** With bge, the page meant scored 0.46 to 0.75 (median 0.60), and the other pages a median of 0.44, 0.54 at the 95th percentile and 0.67 at most. With MiniLM, 0.08 to 0.66 against a median of 0.05 and 0.21 at the 95th. With e5, everything fell between about 0.75 and 0.87.
- **Not measured:** a phone. Chromium's CPU throttling (`Emulation.setCPUThrottlingRate`, 4×) left the worker's times unchanged, so it can't stand in for one.
- **Brute force** over 30,000 vectors of 384 signed bytes, in Node 26: 10 ms; over 3,000, 1 ms.

## Measured in step 2 (2026-11-13)

Step 2 put the model in the build (#430) and measured the built app: the worker as the build emits it, under the app's policy as the server and the desktop app send it, with the model's files as the build carries them. The figures are from its browser tests (`apps/web/e2e/meaning.spec.ts` and the packed app's in `apps/desktop/e2e/packed.spec.ts`), which record them beside their results, run five times each on the spike's laptop (Intel Core Ultra 9 185H) at a load average of 2.6 to 3.6, median of the five; each run's query and passage times are themselves the median of seven. Chromium is Playwright's 153 (headless), the desktop app the packed `app.asar` on Electron 44 (Chromium 152) under Xvfb. The passage is 248 tokens, near the 256 a passage may have (decision 4).

| Where | Load | First embedding after | A query | A passage of 248 tokens |
| --- | --- | --- | --- | --- |
| Chromium, the files from the server | 0.74 s | 52 ms | 14 ms | 211 ms |
| Chromium, the files from the worker's cache | 0.33 s | 45 ms | 14 ms | 215 ms |
| The desktop app, the files from its package | 0.37 s | 46 ms | 14 ms | 289 ms |

- **Load** is fetching or reading the three files and making the runtime's session; from the server, it includes checking the model's and tokenizer's hashes before they are kept. That was over loopback, so it leaves out the download itself: 25.8 MB with Brotli (the model 23.3 MB, the runtime's WebAssembly 2.4 MB, the tokenizer 0.15 MB), about 4 s at 50 Mbit/s.
- **The desktop app** embeds a passage about 40% slower than Chromium on the same machine, from the same files; a query takes as long. Electron's Chromium is a version older, and its window is a real one under Xvfb, not a headless page. At 289 ms a passage, 1,000 pages at two passages each take about 10 minutes the first time, not the 7 decision 4 assumed.
- **Offline**, in Chromium, a worker started after the page reloaded from the service worker read the files from its cache and gave the same vectors.
- **The policy held.** In Chromium the worker's script came with the app's exact policy, from the server; the desktop app's `app://` handler sends the same one. Loading, compiling and embedding raised no error under it in either.
- **Sizes.** The desktop package grows by 49.7 MB (the model 34.0 MB, the runtime's WebAssembly 14.8 MB, the tokenizer 0.7 MB, the worker's script 0.1 MB), and the server image by 75.4 MB, the Brotli copies included.
- **Not measured: a phone.** No real phone could be reached from this machine, and an emulated one says nothing about a phone's processor, as the spike found. The phone row of decision 5 stays as it is, not offered, until a real phone's browser is measured; that waits on someone with one. Memory wasn't measured again either; the spike's figures (decision 1) stand.

How the build turned out, where this ADR didn't say:

- **The runtime's WebAssembly** is `/assets/ort-wasm-simd-threaded-<hash>.wasm`, the name the build gives the file the runtime itself names, which the worker imports too, so the build has one copy. The model and its tokenizer are under `/assets/meaning/`, named by their pinned hashes. The tokenizer's settings, 366 bytes, are in the worker's script.
- **Brotli copies** are made only for those three files, at the highest quality, and kept between builds by hash, as making them takes about a minute (`apps/web/meaning.ts`). The rest of the build has none yet.
- **The service worker** fails the build if it would keep a file over 4 MB, so no large file gets into the shell by mistake.
- **Until the app embeds** (step 4), the embedder is an entry of the build of its own, so the build has its worker; the tests start the worker directly.
- **The worker's cache** holds the three files under their paths, each kept only once it checks out: the model and its tokenizer by their pinned SHA-256, the runtime's WebAssembly by its magic number, so a wrong answer, such as a proxy's page, is never kept. Loading deletes other models' caches and any file of its own this build doesn't name, such as an older runtime's. The desktop app keeps no cache: it reads its files from its package. Where there is no Cache Storage, as on a page not served over HTTPS, or it refuses, as with site data blocked or no room left, the worker fetches the files each time it starts, and the browser's HTTP cache answers, as the files are cached for good, so the server still learns only that they were fetched, not how often anyone searches (decision 7). That HTTP cache may hold a copy beside the worker's cache in any browser, as it does any of the app's files. Forgetting the model can't delete it, but it holds nothing of the person's, and the browser lets it go when it needs the room. A load that fails stops the worker, as the runtime keeps a failed start for the worker's life, and the next load starts another.
- **The server** says `Vary: Accept-Encoding` on every file with a Brotli copy, sent compressed or not, so a shared cache never keeps one form for every browser.
- **The licences** are in `/third-party-notices.txt`: the model's MIT licence, from BAAI's FlagEmbedding, and the runtime's and the tokenizer library's, as the build drops their notices from the scripts. ONNX Runtime's own notices for what its WebAssembly includes (protobuf, Abseil, Eigen and more) are beside it, unchanged, in `/third-party-notices-onnxruntime.txt`, 330 KB, which the service worker doesn't keep.

## Considered options

- **Embeddings from the administrator's AI provider.** No model on the device, and better models. But it sends every page's text, and every query, to the provider through the server, which #324 rules out. It could come later as an opt-in with a disclosure like the chat assistant's.
- **Vectors computed on the server.** The server can't read pages.
- **transformers.js.** The easiest start, but it defaults to fetching from Hugging Face and jsDelivr, brings native Node dependencies, and is much more code than the few steps needed (decision 2).
- **WebGPU first.** 13 times as fast on a 256-token passage where it works, but a 133 MB model, a runtime build twice the size, and GPUs without `shader-f16` or WebGPU at all need the WebAssembly path anyway (decision 2).
- **Cross-origin isolation for threads.** Nearly three times as fast, but `Cross-Origin-Embedder-Policy` changes how frames load, and the sandboxed plugin and diagram frames would need it too. The desktop app could isolate its own `app://` origin more easily. Later.
- **Running the model in the desktop's main process** with `onnxruntime-node`. Faster, but it puts decrypted text in the main process (decision 2).
- **Fetching the model from Hugging Face.** The policy refuses it, and it would tell a third party who uses WikiStow and when.
- **Whole pages as one vector.** Fewer vectors, but a long page's meaning blurs, its end is cut off at 512 tokens, and a result can't point at its section.
- **Vectors in the word index's file.** One file to keep, but that file is bound to the app's build, so every update would embed every page again.
- **One ranked list** of words and meaning together (decision 6).
- **A model for many languages first** (`multilingual-e5-small`, decision 1).

## Consequences

- **Now, with this ADR:** `wikistow.md`'s line on later work points here.
- **Once accepted:**
  - `wikistow.md` line 23 and its search paragraph (under **Import**) say what search by meaning does, where it is on, and how its vectors are kept; the Offline section says the vector file is kept with the index.
  - `ui-design.md`'s search dialog row gains **By meaning**, and Settings gains its switch.
  - The protocol's A7 gains what a browser's fetch of the model tells the server. The vector file's domains, `meaning-index-key/v1` and `meaning-index/v1`, are recorded here, as ADR 0009 recorded `kept-key/v1`; the protocol's registry (section 3.5) lists no device-sealed domain.
  - `CONTEXT.md` gains **Search by meaning**.
- **Code:**
  - The web build gains the model and the runtime as hashed files with Brotli copies, fetched and checked at a pinned hash; the service worker's shell leaves out the model, tokenizer, `.wasm` and every `.br`, and the desktop package the `.br` copies; the server serves `/assets/*` precompressed; the desktop package grows by about 50 MB.
  - `packages/client` gains a `meaning` module: passages, vectors, the scan and the sealed file.
  - `packages/ui` gains the embedding worker, the background queue, the setting and the dialog's section.
  - The desktop bridge gains `meaningIndex`, `keepMeaningIndex` and `dropMeaningIndex`, as for `search-index`.
  - `onnxruntime-web` and `@huggingface/tokenizers` become dependencies of `packages/ui`, loaded only by the worker.

## Implementation, in pull requests

1. **This ADR.**
2. **The model in the build, and a measurement** (#430; see **Measured in step 2**, which measured no phone). Fetch and check the model at its pinned hash, emit it and the runtime as hashed files with Brotli copies, serve `/assets/*` precompressed, leave the large files and the copies out of the service worker's shell and the copies out of the desktop package, add the licence. The worker and its model cache, with a browser test that embeds a text under the app's policy, offline too. Measure load, a query and a passage in Chromium and the desktop app, and in a real phone's browser, so the phone row of decision 5 rests on numbers.
3. **Passages and vectors** in `packages/client`: cutting a page's reduced text at its headings and paragraphs, 8-bit vectors, the scan, and sealing and opening the kept file, with tests.
4. **Indexing in the background.** The queue, kept vectors on unlock, updates when pages change, the 30 s pause for drafts, lock and logout, the desktop bridge's file, and the setting with its rules per device.
5. **By meaning in the search dialog**, with filters, the status line, the keyboard and screen reader, and an e2e: a page about a beach holiday is found by "trip to the coast".
6. **The spec,** marked built.

Steps 2 and 3 can run in parallel. Step 4 needs both, and step 5 needs step 4.

## Decided (2026-11-13)

Scott accepted every recommendation below on 2026-11-13.

1. **The model: `bge-small-en-v1.5`, English only, for now?** Recommended: yes (decision 1). It has the best published retrieval score of the small models, a licence with no conditions, and a 23 MB download with Brotli. `all-MiniLM-L6-v2` did as well on short notes at half the time, and is the choice if indexing time matters more. `multilingual-e5-small` is the choice if the family writes in other languages, at more than three times the download and the memory.
2. **ONNX Runtime Web on WebAssembly, one thread, in a worker of the app's own, without transformers.js?** Recommended: yes (decision 2). It runs under today's policy unchanged. WebGPU and threads are faster but need a larger model or cross-origin isolation, and can come later.
3. **The model from WikiStow only: in the desktop package, and fetched once by a browser from the WikiStow server?** Recommended: yes (decision 3). A third party never learns who uses it, and the build pins the file by its hash.
4. **On by default in the desktop app, opt-in in a computer's browser with Every page kept, and not on phones yet?** Recommended: yes (decision 5). The desktop has the model and keeps every page already. A browser needs a 26 MB download and background work, which the person should choose. A phone needs measuring first.
5. **Vectors by section, of at most 256 tokens, kept as 8-bit integers in a sealed file of their own, bound to the model and not the build?** Recommended: yes (decision 4). About 8 MB for 10,000 pages, an edit embeds only its section again, and an app update doesn't embed every page again.
6. **Word matches first as today, then a By meaning section of up to five other pages, with `tag:` and property filters narrowing both?** Recommended: yes (decision 6). Word results stay exact and explained. One list ranked by both would find more, but would move familiar results around.
7. **Agents, the CLI, MCP and plugins keep word search for now?** Recommended: yes (decision 8). Each builds its index afresh per call, so it would embed every page each time. The chat assistant could later use the person's kept vectors.
8. **The server learns only that a browser fetched the model?** Recommended: yes, and A7 says so (decision 7). The desktop app tells it nothing new.
