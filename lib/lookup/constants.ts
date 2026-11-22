/** Stable lookup-table limits shared by parsing, persistence, and routes. */

export const LOOKUP_MAX_ROWS = 5_000;
export const LOOKUP_MAX_COLUMNS = 250;
export const LOOKUP_MAX_CELL_BYTES = 64 * 1_024;
export const LOOKUP_MAX_ROW_BYTES = 256 * 1_024;
export const LOOKUP_MAX_TABLE_BYTES = 8 * 1_024 * 1_024;
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

/** A tag's or a column's wire name: an unaccented letter or underscore, then
 * letters, digits, underscores or hyphens. A period is left out: CommCare
 * HQ's build reads an unquoted period in a case list filter and a display
 * condition as the current case (`xpath.py::dot_interpolate`). */
export const LOOKUP_WIRE_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;
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

/** Why a tag is reserved: the whole name, or a word it contains. */
export type ReservedInstanceTagCause =
	| { readonly kind: "name" }
	| { readonly kind: "contains"; readonly word: ReservedInstanceTagWord };

/**
 * Why CommCare would read `tag` as its own data, or null when it reads the
 * table. A whole reserved name wins; otherwise the first word of
 * `RESERVED_INSTANCE_TAG_WORDS` the tag contains as written.
 */
export function reservedInstanceTagCause(
	tag: string,
): ReservedInstanceTagCause | null {
	if (tag === "casedb" || tag === "ledgerdb") return { kind: "name" };
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
