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
 * `CaseInstanceTreeElement` compares its own name case-insensitively, so the
 * check below is case-insensitive too. Nova's emitter vocabulary is the other
 * half of this set; `lib/commcare/__tests__` pins that every id
 * `instanceSourceFor` can emit is either reserved here or unrepresentable as a
 * tag, so the two cannot drift apart.
 */
export const RESERVED_INSTANCE_TAGS = [
	"casedb",
	"commcaresession",
	"ledgerdb",
	"locations",
	"results",
	"input",
] as const;

export function isReservedInstanceTag(tag: string): boolean {
	const lowered = tag.toLowerCase();
	return RESERVED_INSTANCE_TAGS.some((reserved) => reserved === lowered);
}
