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
 * How a table tag collides with an id CommCare HQ's form builder already
 * holds. HQ's form designer hands the builder (Vellum) the session, the case
 * database, a registry's cases and then every table of the project space
 * under its bare tag (`views/formdesigner.py::get_form_data_schema`,
 * `fixtures/fixturegenerators.py::item_lists_by_domain`). Vellum indexes them
 * by id, a later source taking an earlier one's place
 * (`datasources.js`: `_.indexBy(sources, "id")`), and records each id among
 * the instances it knows (`form.js::updateKnownInstances`), the map from which
 * it declares an instance a form reads (`form.js::parseInstanceRefs`). The
 * comparison is a JavaScript object key: the whole tag, case and all.
 *
 * So the table reaches every form made in CommCare HQ in that project space,
 * read or not, at its next save there; each kind is observed by
 * `proof/editors/test_project_space_table_tags.py` with a table sorting after
 * it, beside the names just outside each, which keep the form:
 * - `stops-every-form`: `hasOwnProperty` shadows the method the builder calls
 *   on that map, so no form there opens ("t2.hasOwnProperty is not a function").
 * - `takes-the-session`: the save drops the form's `#case/` references and
 *   CommCare HQ refuses the form.
 * - `takes-registry-cases`: the save points a `#registry_case/` read at the
 *   table, so it reads nothing.
 * - `takes-a-build-instance`: the save declares the table under an instance id
 *   CommCare HQ's build gives a form that reads it undeclared
 *   (`suite_xml/post_process/instances.py`), and the form reads the table.
 *
 * Nova's own forms read a table under `item-list:<tag>` where its tag
 * collides (`lib/commcare/lookup/naming.ts`), and the builder keeps them. The
 * harm is to forms made in CommCare HQ, so Nova refuses only the acts by which
 * it would put such a table into a project space: making or renaming a table
 * it manages, taking one over from CommCare HQ, and publishing one. A table
 * CommCare HQ manages under one of these tags comes in as it is, except
 * `hasOwnProperty`, where no form opens at all.
 */
export type FormBuilderTagCollision =
	| { readonly kind: "stops-every-form" }
	| { readonly kind: "takes-the-session" }
	| { readonly kind: "takes-registry-cases" }
	| { readonly kind: "takes-a-build-instance"; readonly reads: string };

export const FORM_BUILDER_COLLIDING_TAGS: ReadonlyMap<
	string,
	FormBuilderTagCollision
> = new Map<string, FormBuilderTagCollision>([
	["hasOwnProperty", { kind: "stops-every-form" }],
	["commcaresession", { kind: "takes-the-session" }],
	["registry", { kind: "takes-registry-cases" }],
	["groups", { kind: "takes-a-build-instance", reads: "the worker's groups" }],
	["reports", { kind: "takes-a-build-instance", reads: "mobile reports" }],
	["locations", { kind: "takes-a-build-instance", reads: "locations" }],
	["results", { kind: "takes-a-build-instance", reads: "case search results" }],
	[
		"search-input",
		{ kind: "takes-a-build-instance", reads: "what a worker searched for" },
	],
	[
		"selected_cases",
		{ kind: "takes-a-build-instance", reads: "the cases a worker selected" },
	],
	[
		"case-search-fixture",
		{ kind: "takes-a-build-instance", reads: "the case search fixture" },
	],
]);

/** What a table under a colliding tag does to forms made in CommCare HQ, one
 * sentence per mechanism. */
export function formBuilderTagCollisionSentence(
	collision: FormBuilderTagCollision,
): string {
	switch (collision.kind) {
		case "stops-every-form":
			return "CommCare HQ's form builder stops opening every form in a project space that holds a table with this name.";
		case "takes-the-session":
			return "In CommCare HQ's form builder the table takes the place of the session's case data, so a form made there loses its case references when it's next saved.";
		case "takes-registry-cases":
			return "In CommCare HQ's form builder the table takes the place of a registry's cases, so a form made there that reads a registry case reads nothing once it's next saved.";
		case "takes-a-build-instance":
			return `A form made in CommCare HQ that reads ${collision.reads} reads this table instead once it's next saved in CommCare HQ's form builder.`;
	}
}

/** A tag in place of one that collides with the form builder's own ids. */
export function formBuilderTagSuggestion(tag: string): string {
	return `${tag.replaceAll("-", "_")}_table`;
}

/** Why a tag is reserved: the whole name, a word it contains, or an id
 * CommCare HQ's form builder already holds. */
export type ReservedInstanceTagCause =
	| { readonly kind: "name" }
	| { readonly kind: "contains"; readonly word: ReservedInstanceTagWord }
	| {
			readonly kind: "form-builder";
			readonly collision: FormBuilderTagCollision;
	  };

/**
 * Why a table Nova manages can't carry `tag`: CommCare would read it as its
 * own data, or it collides with an id HQ's form builder holds. A whole
 * reserved name wins; otherwise the first word of
 * `RESERVED_INSTANCE_TAG_WORDS` the tag contains as written.
 */
export function reservedInstanceTagCause(
	tag: string,
): ReservedInstanceTagCause | null {
	if (tag === "casedb" || tag === "ledgerdb") return { kind: "name" };
	const collision = FORM_BUILDER_COLLIDING_TAGS.get(tag);
	if (collision !== undefined) return { kind: "form-builder", collision };
	const word = RESERVED_INSTANCE_TAG_WORDS.find((reserved) =>
		tag.includes(reserved),
	);
	return word === undefined ? null : { kind: "contains", word };
}

/**
 * Why a table CommCare HQ manages can't come in under `tag`, or null. Nova
 * never writes such a table, so a collision HQ's editors already live with
 * comes in, except one under which no form in the project space opens.
 */
export function hqManagedTagRefusal(
	tag: string,
): ReservedInstanceTagCause | null {
	const cause = reservedInstanceTagCause(tag);
	if (cause?.kind !== "form-builder") return cause;
	return cause.collision.kind === "stops-every-form" ? cause : null;
}

export function isReservedInstanceTag(tag: string): boolean {
	return reservedInstanceTagCause(tag) !== null;
}

/** How a tag holding a reserved word can be written so CommCare reads it. */
export const RESERVED_INSTANCE_TAG_WORD_SPELLING: Readonly<
	Record<ReservedInstanceTagWord, string>
> = { casedb: "case_db", ledgerdb: "ledger_db" };

/** Limits for one worker fixture snapshot in Preview and app checks. */
export const DEVICE_FIXTURE_MAX_TABLES = 500;
export const DEVICE_FIXTURE_BYTES = 32 * 1024 * 1024;
