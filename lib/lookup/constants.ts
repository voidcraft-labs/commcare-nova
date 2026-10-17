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

/** ASCII identifiers accepted by the lookup wire boundary. */
export const LOOKUP_WIRE_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const LOOKUP_XML_PREFIX_PATTERN = /^xml/i;

/**
 * Instance ids the CommCare runtime owns, which a table tag may therefore never
 * take.
 *
 * A form's fixture is registered under the table's bare tag, and
 * `FormDef::addNonMainInstance` is an unconditional map put — so a table tagged
 * `casedb` REPLACES the case database for every form that uses it. The failure
 * is silent and total: case preloads, case-block `relevant` expressions, and the
 * `case_id` calculation all resolve against the fixture, evaluate to an empty
 * node-set, and the worker completes a form that writes nothing at all. That is
 * data loss with no signal, so the collision has to be unconstructible rather
 * than caught downstream.
 *
 * Verified in the runtime source rather than recalled:
 *   `casedb`   — commcare-core `CaseInstanceTreeElement::MODEL_NAME`
 *   `ledgerdb` — commcare-core `LedgerInstanceTreeElement::MODEL_NAME`
 *   `results`  — commcare-core `VirtualInstances::SELCTED_CASES_INSTANCE_ROOT_NAME`
 *   `input`    — commcare-core `VirtualInstances::SEARCH_INSTANCE_ROOT_NAME`
 *   `commcaresession`, `locations`
 *              — formplayer `InstanceAutocompletableItem` (`SESSION_INSTANCE`,
 *                `LOCATION_INSTANCE`)
 *
 * Nova also emits selected-case virtual instances: selected_cases, optionally
 * followed by a case type and prefixed by parent_ for each ancestor, plus
 * search_selected_cases. Table tags share their instance namespace.
 *
 * `CaseInstanceTreeElement` compares its own name case-insensitively, so the
 * whole-name check below is case-insensitive too. The reserved-instance corpus
 * covers fixed names and the dynamic selected-case family. Native Core proof
 * shows that a colliding lookup instance is silently replaced during form
 * setup; shared reference validation refuses historical collisions before
 * emission.
 */
export const RESERVED_INSTANCE_TAGS = [
	"casedb",
	"commcaresession",
	"ledgerdb",
	"locations",
	"results",
	"input",
] as const;

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
export const RESERVED_INSTANCE_TAG_WORDS = ["ledgerdb", "casedb"] as const;

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
	const lowered = tag.toLowerCase();
	if (
		RESERVED_INSTANCE_TAGS.some((reserved) => reserved === lowered) ||
		lowered === "search_selected_cases" ||
		/^(?:parent_)*selected_cases(?:_[a-z][a-z0-9_-]*)?$/.test(lowered)
	)
		return { kind: "name" };
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
