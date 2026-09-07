# Native Node multipart diagnostics

Native multipart `fetch` reproduces the upload test's `PROMISE` and `BLOBREADER`
async-hooks diagnostics outside MCP, Vitest, Postgres and Nova. Both a controlled
Undici dispatcher and a real loopback HTTP socket retain these allocations after
request/file/response consumption and transport closure. This finding identifies
these particular diagnostics; it does not establish that every SDK diagnostic is
harmless or that the full test suite is leak-free.

## Reproduce

From the repository root after installing dependencies:

```sh
mise exec -- node docs/research/test-suite-audit/native-node/mock-multipart.mjs
mise exec -- node docs/research/test-suite-audit/native-node/socket-multipart.mjs
```

The captured runs used Node **v24.18.1**, its bundled Undici **7.29.0**, and the
repository's dispatcher package **8.10.0**. Both exited naturally with status zero.
[Mock dispatcher output](mock-result.json) and [socket output](socket-result.json)
each show one unresolved `PROMISE` and two `BLOBREADER` resources at `beforeExit`.
Allocation ids and garbage-collection timing can vary between runs.

Both scripts send native `FormData` containing a real `Blob`. The peer consumes
all request bytes, awaits `Response.formData()` and `File.text()`, and returns a
JSON response that the client consumes before closing its dispatcher. The socket
variant also awaits HTTP server closure. The hook records ids, types, creation
stacks and completion flags, never the resource objects themselves. It observes
only the two investigated resource types; its output is not a complete resource
inventory or a replacement for Vitest's diagnostics. Repository paths in captured
stacks are normalized to `<repo>/`. Neither script uses sleeps, forced GC, mocked
fetch, prototype changes or test-diagnostic suppression.

## Resource ownership

The unresolved promise originates in `InternalReadableByteStream`, through
`readableByteStreamTee`, `ReadableStream.tee`, `cloneBody`, `cloneRequest` and
`httpNetworkOrCacheFetch`. Native Undici clones the upload body, retaining the
original stream branch while consuming the clone. With the `fetch(url, { body:
formData })` invocation used here, that internal retained branch is not exposed
to the caller. The same stack survives the real HTTP exchange, ruling out
MockAgent or MCP cleanup as its cause. See the pinned
[request clone](https://github.com/nodejs/node/blob/v24.18.1/deps/undici/undici.js#L13540-L13553)
and [body tee](https://github.com/nodejs/node/blob/v24.18.1/deps/undici/undici.js#L6961-L6970).

The two Blob readers originate in multipart `File.stream()` and the peer's
awaited `File.text()`. Node creates `Blob::Reader` as an `AsyncWrap` with
`PROVIDER_BLOBREADER` and makes it weak. Its exposed methods are `pull` and
`setWakeup`; end-of-stream marks `eos_` and completes the callback without an
explicit async-hooks destroy event. `AsyncWrap` emits that event from its
GC-driven destructor. A fully consumed reader can therefore remain in the
async-hooks inventory until GC; there is no reader close operation for the
application to await. See the pinned
[reader construction and methods](https://github.com/nodejs/node/blob/v24.18.1/src/node_blob.cc#L301-L328),
[EOF handling](https://github.com/nodejs/node/blob/v24.18.1/src/node_blob.cc#L342-L412),
and [destructor](https://github.com/nodejs/node/blob/v24.18.1/src/async_wrap.cc#L559-L562).

The original focused MCP upload run passed its publish/update assertions and
reported both diagnostic categories. Its displayed `Server._onrequest` frame
was an async ancestor, rather than the native resource creation site recovered
here. No application or test transport change follows from this evidence, and
these diagnostics remain reported rather than suppressed.

## Source verification

SHA-256 of the complete upstream files at the pinned Node release; source
snapshots are not vendored in this directory:

| Source | SHA-256 |
| --- | --- |
| [`src/node_blob.cc`](https://raw.githubusercontent.com/nodejs/node/v24.18.1/src/node_blob.cc) | `2f0370fcdbbfe6a7d5a39c515bec7ea41939f14f8a7041becc21ef8c5b747d14` |
| [`src/async_wrap.cc`](https://raw.githubusercontent.com/nodejs/node/v24.18.1/src/async_wrap.cc) | `fd65099014346507b322ec221917c504045ba7a5e5bbb5a8b473588879eef294` |
| [`deps/undici/undici.js`](https://raw.githubusercontent.com/nodejs/node/v24.18.1/deps/undici/undici.js) | `19e00833036e7d25f20da1bc70dd4b19dd3081c051bfc9eea8f70d026534cad4` |

The downloaded Undici source hash also matches the running binary's
`process.binding('natives')['internal/deps/undici/undici']` text. That internal
inspection was used only to verify source provenance, not in the reproductions.
