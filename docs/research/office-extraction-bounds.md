# Office extraction: supported conversion and resource limits

Issues #632 and #721 share the bytes-to-model-input boundary. The old ZIP
preflight checked declared sizes but left Mammoth and SheetJS on the request
thread. Mammoth's deprecated Markdown writer also flattened Word tables into
paragraphs. Neither an upload-byte cap nor a promise timeout bounded that work.

## Facilities evaluated

- [Mammoth](https://github.com/mwilliamson/mammoth.js#api) supports HTML conversion
  and custom image handlers; its Markdown conversion is deprecated. Use the
  package's own types and `convertToHtml`, with external-file access disabled.
  Errors reported in `result.messages` fail conversion; warnings accompany the
  source as limitations. An unreadable or unsupported image retains its marker
  and explicit omission reason under the existing figure policy.
- [Turndown](https://github.com/mixmark-io/turndown) offers custom rules and a GFM
  plugin, but table conversion needs special attention to headerless Word tables.
  [rehype-remark](https://github.com/rehypejs/rehype-remark) uses a typed document
  tree, handles headerless tables with an empty header, and supports a direct
  image-node handler. With `remark-gfm` and `remark-stringify`, the synthetic
  fixture preserves cells, nested lists, Unicode, URLs and figure alt text.
  This is a maintained converter pipeline, not a Nova general-purpose converter.
- [Node worker limits](https://nodejs.org/api/worker_threads.html) explicitly
  exclude external data such as ArrayBuffers. A worker thread alone cannot
  isolate native allocation exhaustion from the application process. A separate
  Node child confines V8 fatal errors, supports forced cancellation, and permits
  the Linux kernel to apply
  [RLIMIT_DATA](https://man7.org/linux/man-pages/man2/getrlimit.2.html) before
  parsing. Linux applies this limit to anonymous allocations as well as the heap.

## Enforced boundary

`officeLimits.ts` is the authority: 10 MiB input, 5,000 ZIP entries, 64 MiB decoded
bytes, 4 MiB converted text, 34 MiB serialized result, 256 MiB V8 old heap,
768 MiB Linux data allocation, and a 15-second wall deadline. One child runs per
Node process with at most four pending callers; their wait consumes the same
deadline. The process-wide owner survives separate server module instances and
development reloads. On macOS the data-limit operation is unavailable; local
runs enforce heap, byte, queue and time limits, while Linux tests and the image
check prove the native allocation refusal. RLIMIT_DATA is an allocation budget,
not an exact RSS ceiling: code mappings and stacks are separate.

The fixed shell launcher disables core dumps and `exec`s Node, preserving its
PID. Uploaded bytes travel through stdin, never command text. The child receives
only its runtime environment, no application credentials. Timeout, cancellation,
output overflow and pipe errors kill the child, and the promise settles only
after `close` joins it and its pipes. The queue permit and deadline timer are
released in `finally`. There are no per-document temporary files or reusable
parser heaps. A failed conversion reaches no model call.

Inside the child, AdmZip decodes every entry using the installed release's
bounded inflater and CRC validation. Actual decoded lengths must match declared
lengths and the cumulative budget. Duplicate or ambiguous names refuse. The
admitted bytes are repackaged into a fresh ZIP; downstream parsers never see the
untrusted original directory. This closes parser-disagreement gaps rather than
assuming that one parser's preflight governs another's interpretation. The
process budgets still cover reparsing, XML complexity and Markdown conversion.

DOCX figure identities travel as HTML image attributes into a tree handler, which
emits the marker directly and verifies one-to-one coverage. Alt text is escaped
once as an attribute; it is never a replacement pattern. Spreadsheet table and
formula bounds remain unchanged. `EXTRACTOR_VERSION` advances from 8 to 9 for
future preparation. #429's immutable conversation sources remain unchanged;
`resolveAttachments.test.ts` exercises retained revisions without consulting
current extraction. The plugin already describes prepared extracts, limitations
and failed preparation; its tools and guidance require no companion change.

## Synthetic evidence and measurements

Measured on 2026-11-09 with Node 24.21.0 Alpine in local Docker, using the bundled
production parser/supervisor and no model call. Each row starts a fresh child;
latency includes startup and serialization. These are observed samples, not
latency guarantees or production load tests. RSS is the child's reported
`process.resourceUsage().maxRSS` in KiB.

| Input | Compressed bytes | Time (ms) | Peak RSS (KiB) | Result |
| --- | ---: | ---: | ---: | --- |
| Heading and paragraph DOCX | 1,398 | 108.8 | 83,884 | 20 text bytes |
| Table, nested list, Unicode, URL, figure DOCX | 2,263 | 110.9 | 90,908 | 506 text bytes |
| DOCX with 10,000 additional paragraphs | 4,697 | 552.2 | 194,840 | 640,020 text bytes |
| XLSX with 2,000 rows and 10 columns | 174,087 | 197.8 | 113,920 | 392,975 text bytes |
| Under-declared ZIP entry | 1,398 | 86.9 | Not reported | Refused |
| DOCX with 30,000 nested tags | 3,097 | 158.2 | Not reported | Refused |
| Child attempts 1 GiB native buffer | N/A | 18.4 | Not reported | Refused |

The structured fixture is `__tests__/fixtures/officeDocuments.ts`. The long input
adds 10,000 paragraphs containing “Review the referral criteria and follow the
recorded decision.” The workbook cells contain `Row N Column M`, and the deep
input wraps one paragraph in 30,000 `w:smartTag` elements. The under-declared
fixture changes the first central-directory uncompressed size to one byte.

The old Mammoth Markdown conversion turns the fixture's four table cells into
four paragraphs. The supported pipeline emits a two-column table, retains the
nested bullet, and preserves the URL and the figure's `$&`, brackets, quotes,
Unicode and XML metacharacters. Existing figure ordering, sniffing, omission and
budget tests continue through the subprocess extraction entry point.

`officeProcess.test.ts` uses actual children to prove queue refusal, queued
cancellation, synchronous-loop termination, child reaping, heap exhaustion,
output overflow and Linux native-buffer refusal. Repeated malformed and
excessively deep documents are followed by a successful ordinary document.
`documentExtraction.test.ts` proves parser failure starts no model call.
The standalone-image verifier runs both DOCX and XLSX through the packaged
supervisor and tests a native allocation refusal, catching missing artifacts or
loader dependencies before readiness.
