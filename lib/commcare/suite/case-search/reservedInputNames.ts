// lib/commcare/suite/case-search/reservedInputNames.ts
//
// The request keys CommCare HQ reads as part of a search request rather than
// as a case property. A prompt sent under one of these keys never searches the
// property it names: HQ takes it out of the request as a setting
// (`corehq/apps/case_search/models.py::CONFIG_KEYS_MAPPING`,
// `CASE_SEARCH_TAGS_MAPPING`), ignores it (`UNSEARCHABLE_KEYS`), filters by
// owner or project space with it, compiles it as a query (`_xpath_query`), or
// searches a case index with it (`CASE_SEARCH_INDEX_KEY_PREFIX`), as
// `corehq/apps/case_search/utils.py::CaseSearchQueryBuilder._apply_filter`
// dispatches.
//
// The set is the generated surface's `csql-key` family minus `case_id` and
// `owner_id`, which HQ searches as the case's id and its owner: exactly what an
// exact Search question on them means. It is a checked constant rather than a
// runtime read of `surface.json`, since server code carries the gate entries
// alone; `lib/commcare/surface/__tests__/reservedInputNames.test.ts` holds it
// equal to the surface's family, so a key HQ adds fails the weekly pin update.

/** Every exact request key HQ reads as part of the search request. */
export const RESERVED_SEARCH_INPUT_NAMES: readonly string[] = [
	"_xpath_query",
	"case_type",
	"case_types",
	"commcare_blacklisted_owner_ids",
	"commcare_project",
	"commcare_sort",
	"custom_related_case_property",
	"data_registry",
	"endpoint_id",
	"include_all_related_cases",
	"include_closed",
	"x_commcare_custom_related_case_property",
	"x_commcare_data_registry",
	"x_commcare_endpoint_id",
	"x_commcare_include_all_related_cases",
	"x_commcare_tag_module_name",
];

/**
 * Every request key prefix HQ reads as part of the search request. A Search
 * question's name cannot hold a dot (`XML_ELEMENT_NAME_PATTERN`), so no stored
 * name meets it; it is carried so the set equals the surface's family.
 */
export const RESERVED_SEARCH_INPUT_NAME_PREFIXES: readonly string[] = [
	"indices.",
];

const RESERVED_NAMES: ReadonlySet<string> = new Set(
	RESERVED_SEARCH_INPUT_NAMES,
);

/** Whether HQ reads a request key of this name as part of the search
 *  request, never as a case property. */
export function isReservedSearchInputName(name: string): boolean {
	return (
		RESERVED_NAMES.has(name) ||
		RESERVED_SEARCH_INPUT_NAME_PREFIXES.some((prefix) =>
			name.startsWith(prefix),
		)
	);
}

/** The name HQ's Case List page reserves for a menu's default filters. Nova
 *  writes every default filter as an `_xpath_query` row, and the page refuses
 *  a prompt named like one of them. */
export const DEFAULT_FILTER_REQUEST_KEY = "_xpath_query";
