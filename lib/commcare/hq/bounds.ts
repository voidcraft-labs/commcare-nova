/**
 * The most bytes Nova reads of every answer CommCare HQ gives, each with its
 * reason. One table: a read's bound is never a default, an option left out or
 * a number written at the call, so every body Nova takes from CommCare HQ is
 * named here, the acknowledgements of its writes included.
 *
 * A body past its bound is cancelled at the stream and nothing past the bound
 * is read (`http.ts::HqAnswer.read`). What that means is the read's: a data
 * read answers `too-large`, a list `past-limit`, and an acknowledgement takes
 * its write's arm for an answer Nova cannot read, which says the write may
 * have landed.
 *
 * Client-safe: numbers only.
 */

const KiB = 1024;
const MiB = 1024 * KiB;

/**
 * The largest bound any read may take. Every bound below is under it, and the
 * reader refuses a larger one as a programmer's error, so no body Nova holds
 * nears V8's limits on one typed array or one string.
 */
export const HQ_BODY_BOUND_CEILING = 256 * MiB;

// ---------------------------------------------------------------------------
// Refusals, of reads and writes alike
// ---------------------------------------------------------------------------

/**
 * A refused answer's body: enough to tell the edge's page from CommCare HQ's
 * own refusal and to keep its sentence. Its first `HQ_REFUSED_BODY_MAX_CHARS`
 * characters are all any caller keeps.
 */
export const HQ_REFUSED_BODY_READ_MAX_BYTES = 64 * KiB;

// ---------------------------------------------------------------------------
// Reads of one answer
// ---------------------------------------------------------------------------

/** `views/cli.py::list_apps`: an id, a name and a counter per app. */
export const HQ_APP_LIST_MAX_BYTES = 4 * MiB;

/** The lookup table list asked for one row, to learn API access. */
export const HQ_API_ACCESS_PROBE_MAX_BYTES = 1 * MiB;

/**
 * The application resource and the app source for a status check or a
 * publish: the server's memory against a body of any length, not fitted to an
 * app's size.
 */
export const HQ_APPLICATION_MAX_BYTES = 64 * MiB;
export const HQ_APP_SOURCE_MAX_BYTES = 64 * MiB;

/**
 * The two app bodies of a bring-in. A longer one is refused unparsed.
 *
 * Set by what one request at the cap holds, measured, against the bring-ins'
 * share of the serving instance's heap (`memoryMeter.ts::processMemoryBounds`,
 * about 512 MiB on the 2 GiB instance): a changes review, the largest of the
 * four requests, is charged 37 bytes of heap a byte of its larger source and
 * 3 of its smaller (`READING_HEAP_PER_SOURCE_BYTE`,
 * `SECOND_READING_HEAP_PER_SOURCE_BYTE`), 40 a byte over two sources at the
 * cap, so the cap is at most 512 / 40 = 12.8 MiB, rounded down to whole
 * mebibytes: 12 MiB charges 480 MiB.
 */
export const HQ_BRING_IN_APP_MAX_BYTES = 12 * MiB;

// ---------------------------------------------------------------------------
// What a body's XML builds
// ---------------------------------------------------------------------------
//
// A byte bound bounds no parse: `<a/>` is a node in four characters, and a
// namespace declaration costs every declaring element under it a copy. Every
// parse counts what it builds before it builds it (`xmlParse.ts::XmlLimits`).
// The numbers are fitted, with headroom, to a measurement of the retained
// corpus of apps made in CommCare HQ (`proof/hq-apps`, `proof/hq-reads`: 286
// forms of 90 sources) and of the source at the byte cap the cap tests build
// (`lib/deployment/reading/__tests__/cap.test.ts`, built at 16 MiB when it was
// measured). Measured: the largest form holds 1,938 nodes, the deepest nests 13
// elements, the most declarations in a form is 14, the largest source's forms
// hold 10,292 nodes together, and the 16 MiB source 121,500.

/**
 * The most nodes one document's parse builds: each element, attribute, text,
 * comment and processing instruction. Over a hundred times the largest form
 * measured, so a form Nova emits for a large app parses too; and a quarter of
 * a reading's total, so one parse is one short piece of a request.
 */
export const XML_DOCUMENT_MAX_NODES = 250_000;

/**
 * The deepest one document's elements nest. Twenty times the deepest form
 * measured; every walk of a parsed tree recurses at most this deep.
 */
export const XML_DOCUMENT_MAX_DEPTH = 256;

/**
 * The most namespace declarations one document holds. Each declaring element
 * copies the declarations in scope (`xmlNamespaces.ts::scopeOf`), so a
 * document holds at most this number's square of scope entries. Over thirty
 * times the most measured.
 */
export const XML_DOCUMENT_MAX_NAMESPACE_DECLARATIONS = 512;

/**
 * The most nodes the forms of one app source hold together, counted before
 * the reader reads any (`lib/deployment/reading/gather.ts::formsWithinReading`).
 * An app past it is `too-large`, as one past the byte cap is. Eight times the
 * 16 MiB source measured, and nearly a hundred times the largest source of the
 * corpus.
 */
export const HQ_BRING_IN_READING_MAX_XML_NODES = 1_000_000;

/** `views/releases.py::current_app_version`: three numbers. */
export const HQ_APP_VERSIONS_MAX_BYTES = 64 * KiB;

/**
 * `api/bulk-user/v1/` for a handful of usernames, each row its id and
 * username, at four rows a name asked.
 */
export const HQ_WORKER_SEARCH_MAX_BYTES = 1 * MiB;

/** A build's `profile.ccpr` or `suite.xml`. */
export const HQ_BUILD_RESOURCE_MAX_BYTES = 20_000_000;

// ---------------------------------------------------------------------------
// Lists, across every page of one pass
// ---------------------------------------------------------------------------

/**
 * `api/user_domains/v1/`: every project space a key reaches, a name and a
 * title each, in one page (`DoesNothingPaginator`).
 */
export const HQ_PROJECT_SPACE_LIST_MAX_BYTES = 4 * MiB;
/** The project spaces Nova reads of one key. */
export const HQ_PROJECT_SPACE_LIST_MAX_ROWS = 5_000;

/** `LookupTableResource`: each table's definition, no rows. */
export const HQ_LOOKUP_TABLE_LIST_MAX_BYTES = 16 * MiB;
/** The tables Nova reads of one project space. */
export const HQ_LOOKUP_TABLE_LIST_MAX_ROWS = 20_000;

/**
 * `FixtureResource` filtered to one table: its rows, each repeating its
 * fields' names. A table past it is a table past Nova's caps, whatever its
 * rows hold.
 */
export const HQ_LOOKUP_TABLE_ROWS_MAX_BYTES = 64 * MiB;

/**
 * The rows of every lookup table one bring-in request reads, together. A
 * request whose tables pass it reads more lookup data than Nova brings in.
 */
export const HQ_LOOKUP_ROWS_REQUEST_MAX_BYTES = 128 * MiB;

/** `LocationTypeResource`: the project space's levels. */
export const HQ_LOCATION_TYPE_LIST_MAX_BYTES = 4 * MiB;
/** The levels Nova reads of one project space. */
export const HQ_LOCATION_TYPE_LIST_MAX_ROWS = 10_000;

/**
 * `LocationResource`: every active place with its whole `location_data`. A
 * publish reads the whole inventory to tell a free site code from a taken one.
 */
export const HQ_LOCATION_LIST_MAX_BYTES = 128 * MiB;
/** The places a publish's inventory reads of one project space. */
export const HQ_LOCATION_INVENTORY_MAX_ROWS = 100_000;

// ---------------------------------------------------------------------------
// Acknowledgements of writes
// ---------------------------------------------------------------------------

/** `app_import_api.py::import_app_api`: a verdict, an id, a version and warnings. */
export const HQ_IMPORT_ACK_MAX_BYTES = 1 * MiB;

/** The media bundle's start, which names a processing id. */
export const HQ_MEDIA_BUNDLE_ACK_MAX_BYTES = 1 * MiB;

/**
 * A status report includes every matched file. HQ's get_media_info writes
 * its path twice (path and original_path), and Django JsonResponse escapes a
 * supplementary character in twelve ASCII bytes. At the 500-file export
 * limit, 255 code points per held path take up to 3,060,000 bytes for those
 * two copies. The remaining room covers HQ's per-file metadata and envelope.
 */
export const HQ_MEDIA_BUNDLE_STATUS_MAX_BYTES = 4 * MiB;

/** `fixtures/views.py::upload_fixture_api`: a code and HQ's message. */
export const HQ_LOOKUP_UPLOAD_ACK_MAX_BYTES = 1 * MiB;

/** `LocationResource.patch_list`: a bare array of at most 100 ids. */
export const HQ_LOCATION_PATCH_ACK_MAX_BYTES = 64 * KiB;

/** `CommCareUserResource` with `always_return_data`: the worker as HQ holds them. */
export const HQ_WORKER_WRITE_ACK_MAX_BYTES = 1 * MiB;

// ---------------------------------------------------------------------------
// Media files
// ---------------------------------------------------------------------------

/**
 * The most the media files in flight at once may sum to, each counted at its
 * kind's limit (`lib/domain/multimedia.ts`), which is each file's own bound.
 */
export const HQ_MEDIA_IN_FLIGHT_MAX_BYTES = 64 * MiB;
