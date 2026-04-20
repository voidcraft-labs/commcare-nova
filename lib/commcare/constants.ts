/** CommCare platform constants — single source of truth. */

/**
 * Case property names that HQ rejects in update_case / case_preload blocks.
 * Matches commcare-hq/corehq/apps/app_manager/static/app_manager/json/case-reserved-words.json
 * (38 entries), plus `name` and
 * `owner_id` which HQ also rejects in update blocks.
 */
export const RESERVED_CASE_PROPERTIES: ReadonlySet<string> = new Set([
	// From case-reserved-words.json
	"actions",
	"case_id",
	"case_name",
	"case_type",
	"case_type_id",
	"closed",
	"closed_by",
	"closed_on",
	"commtrack",
	"create",
	"computed_",
	"computed_modified_on_",
	"date",
	"date_modified",
	"date-opened",
	"date_opened",
	"doc_type",
	"domain",
	"external-id",
	"index",
	"indices",
	"initial_processing_complete",
	"last_modified",
	"modified_by",
	"modified_on",
	"opened_by",
	"opened_on",
	"parent",
	"referrals",
	"server_modified_on",
	"server_opened_on",
	"status",
	"type",
	"user_id",
	"userid",
	"version",
	"xform_id",
	"xform_ids",
	// Additional — HQ rejects these in update blocks
	"name",
	"owner_id",
]);

/** Safe rename targets for reserved property names the LLM might generate. */
export const RESERVED_RENAME_MAP: Readonly<Record<string, string>> = {
	date: "visit_date",
	status: "case_status",
	type: "case_category",
	parent: "parent_case",
	index: "case_index",
	version: "form_version",
	domain: "case_domain",
	closed: "is_closed",
	actions: "case_actions",
	create: "create_info",
};

/** Field kinds that produce binary/media uploads — cannot be saved as case properties. */
export const MEDIA_FIELD_KINDS: ReadonlySet<string> = new Set([
	"image",
	"audio",
	"video",
	"signature",
]);

/**
 * Field kinds that accept user input and therefore support validation
 * (constraint + constraintMsg) on the wire. Structural kinds
 * (group / repeat / label) have no value to check; hidden is a computed
 * value the user can't correct, so validation there is a category error.
 * Used by the XForm builder to gate constraint emission.
 */
const VALIDATABLE_KINDS: ReadonlySet<string> = new Set([
	"text",
	"int",
	"decimal",
	"date",
	"time",
	"datetime",
	"single_select",
	"multi_select",
]);

export function supportsValidation(kind: string): boolean {
	return VALIDATABLE_KINDS.has(kind);
}

/** Standard create-block properties (not user case properties). */
export const STANDARD_CREATE_PROPS: ReadonlySet<string> = new Set([
	"case_type",
	"case_name",
	"owner_id",
]);

/** Valid case property name: starts with a letter, then letters/digits/underscores/hyphens. */
export const CASE_PROPERTY_REGEX = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

/** Valid case type identifier: same rules as case property names. */
export const CASE_TYPE_REGEX = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

/** Valid XML element name for XForm property elements (no hyphens — XML spec). */
export const XML_ELEMENT_NAME_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** Valid XForm data path (e.g. /data/name, /data/group/question). */
export const XFORM_PATH_REGEX = /^\/data\/[a-zA-Z0-9_/]+$/;

/** Maximum length for case type names (CommCare Core CaseXmlParser constraint). */
export const MAX_CASE_TYPE_LENGTH = 255;

/** Maximum length for case property names (CommCare Core CaseXmlParser constraint). */
export const MAX_CASE_PROPERTY_LENGTH = 255;

/**
 * Case properties that are always available in case list columns
 * without needing to be explicitly created by forms.
 * Source: commcare-hq/corehq/apps/app_manager/detail_screen.py CASE_PROPERTY_MAP
 * + modules.py default properties.
 */
export const STANDARD_CASE_LIST_PROPERTIES: ReadonlySet<string> = new Set([
	"case_name", // the display name
	"name", // alias for case_name
	"date_opened", // when the case was created
	"date-opened", // HQ alias
	"last_modified", // timestamp of last modification
	"owner_id", // user/group ID owning the case
	"external_id", // external identifier
	"external-id", // HQ alias
	"status", // open/closed
]);
