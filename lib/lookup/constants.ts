/**
 * Stable lookup-table limits shared by parsing, persistence, and routes.
 *
 * None of them bounds a table. The rows, columns and bytes below bound ONE
 * inline change: a request, a batch, an import, or a copy of CommCare HQ's
 * table taken in one transaction. A table grows past every one of them by
 * later changes, and a copy too large for one transaction is read in pages
 * into a staged generation (`lib/lookup/generations`). The cell and row
 * sizes bound a value and a row stored inline; a larger value is stored
 * outside the row (`lib/lookup/largeValues`). The Project's physical storage
 * budget (`lookup_storage_budgets`) is the only total.
 */

export const LOOKUP_MAX_ROWS = 5_000;
export const LOOKUP_MAX_COLUMNS = 250;
export const LOOKUP_MAX_CELL_BYTES = 64 * 1_024;
export const LOOKUP_MAX_ROW_BYTES = 256 * 1_024;
/** The bytes one inline change writes: a request body, a batch, or one inline copy. */
export const LOOKUP_MAX_CHANGE_BYTES = 8 * 1_024 * 1_024;
export const LOOKUP_MAX_CSV_BYTES = 8 * 1_024 * 1_024;
export const LOOKUP_MAX_VALIDATION_DETAILS = 100;

export const LOOKUP_MAX_TABLE_NAME_LENGTH = 120;
export const LOOKUP_MAX_COLUMN_LABEL_LENGTH = 120;
/**
 * The longest export tag Nova lets a table take: the length CommCare HQ's
 * `fixtures/models.py::LookupTable.tag` column stores. HQ's upload checks no
 * length, takes a 32-character tag and fails on a longer one with a server
 * error rather than a refusal, so Nova holds the cap itself. The lane's
 * `proof/views/test_lookup_upload.py::test_hqs_upload_reads_a_table_whose_tag_holds_32_characters_and_fails_on_33`
 * proves both halves against HQ's own view; a change here is a reviewed
 * change against that column, and the `lookup_tables` check holds the same
 * number.
 */
export const LOOKUP_MAX_TAG_LENGTH = 32;
export const LOOKUP_MAX_WIRE_NAME_LENGTH = 255;

export const LOOKUP_INT4_MIN = -2_147_483_648;
export const LOOKUP_INT4_MAX = 2_147_483_647;
export const LOOKUP_REVISION_MAX = BigInt("9223372036854775807");

export const LOOKUP_DATA_TYPES = [
	"text",
	"int",
	"decimal",
	"date",
	"time",
	"datetime",
] as const;

/** A namespace-free XML 1.0 (fifth edition) Name. The unqualified
 * spelling must survive as one element in the fixture. XPath has a
 * narrower portable alphabet, checked where a worker reads that name. */
const XML_NAME_START =
	"A-Z_a-z\\u00c0-\\u00d6\\u00d8-\\u00f6\\u00f8-\\u02ff\\u0370-\\u037d\\u037f-\\u1fff\\u200c-\\u200d\\u2070-\\u218f\\u2c00-\\u2fef\\u3001-\\ud7ff\\uf900-\\ufdcf\\ufdf0-\\ufffd\\u{10000}-\\u{effff}";
const XML_NAME_CONTINUATION = ".0-9\\u00b7\\u0300-\\u036f\\u203f-\\u2040-";
export const LOOKUP_WIRE_IDENTIFIER_PATTERN = new RegExp(
	`^[${XML_NAME_START}][${XML_NAME_START}${XML_NAME_CONTINUATION}]*$`,
	"u",
);
/** CommCare HQ refuses a name that starts with lowercase `xml`, and only that
 * (`fixtures/utils.py::is_identifier_invalid`). */
export const LOOKUP_XML_PREFIX_PATTERN = /^xml/;

/**
 * The two words a tag may not contain anywhere, in the order the runtime
 * tests them.
 *
 * commcare-core `CommCareInstanceInitializer::generateRoot` picks a form
 * instance's data by `String.contains` over its reference: `ledgerdb` first,
 * then `casedb`, then `fixture`. A lookup instance's reference always contains
 * `fixture`, so a tag holding either earlier word is handed the ledger or the
 * case database instead of its table, and every select over it lists nothing.
 * `contains` is case-sensitive, so the rule is too: `CaseDB` reads its table.
 */
const RESERVED_INSTANCE_TAG_WORDS = ["ledgerdb", "casedb"] as const;

export type ReservedInstanceTagWord =
	(typeof RESERVED_INSTANCE_TAG_WORDS)[number];

/**
 * The names of `Object.prototype`'s own members. CommCare HQ's form builder
 * (Vellum) indexes a form's lookup data in plain JavaScript objects keyed by
 * names a table's tag supplies, and calls each object's own
 * `hasOwnProperty` (`datasources.js::getNode`, `form.js::updateKnownInstances`),
 * so a table tagged with one of these names leaves a form that reads it
 * unable to open there ("t2.hasOwnProperty is not a function", observed on
 * `targeted-lookup-reserved-tags`).
 */
export const FORM_EDITOR_RESERVED_TAGS: ReadonlySet<string> = new Set([
	"__proto__",
	"__defineGetter__",
	"__defineSetter__",
	"__lookupGetter__",
	"__lookupSetter__",
	"constructor",
	"hasOwnProperty",
	"isPrototypeOf",
	"propertyIsEnumerable",
	"toLocaleString",
	"toString",
	"valueOf",
]);

/** Why a tag is reserved: the whole name, a word it contains, or a name the
 * form builder keeps for its own JavaScript. */
export type ReservedInstanceTagCause =
	| { readonly kind: "name" }
	| { readonly kind: "contains"; readonly word: ReservedInstanceTagWord }
	| { readonly kind: "form-editor" };

/** A tag in place of one the form builder keeps for itself. */
export function formEditorTagSuggestion(tag: string): string {
	const stem = tag.replace(/^_+|_+$/g, "");
	return `${stem === "" ? "table" : stem}_table`;
}

/**
 * Why CommCare would read `tag` as its own data, or null when it reads the
 * table, or why the form builder could not open a form that reads it. A
 * whole reserved name wins; otherwise the first word of
 * `RESERVED_INSTANCE_TAG_WORDS` the tag contains as written.
 */
export function reservedInstanceTagCause(
	tag: string,
): ReservedInstanceTagCause | null {
	if (tag === "casedb" || tag === "ledgerdb") return { kind: "name" };
	if (FORM_EDITOR_RESERVED_TAGS.has(tag)) return { kind: "form-editor" };
	const word = RESERVED_INSTANCE_TAG_WORDS.find((reserved) =>
		tag.includes(reserved),
	);
	return word === undefined ? null : { kind: "contains", word };
}

export function isReservedInstanceTag(tag: string): boolean {
	return reservedInstanceTagCause(tag) !== null;
}

/** How a tag holding a reserved word can be written so CommCare reads it. */
export const RESERVED_INSTANCE_TAG_WORD_SPELLING: Readonly<
	Record<ReservedInstanceTagWord, string>
> = { casedb: "case_db", ledgerdb: "ledger_db" };
