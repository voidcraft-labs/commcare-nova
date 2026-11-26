/** The service id in an HQ app is the primary key of CaseSearchEndpoint
 * (case_search/migrations/0017, Django AutoField). An id says nothing about
 * the service's database, query, current version, or available columns. */
export function isProjectSearchId(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isInteger(value) &&
		value > 0 &&
		value <= 2147483647
	);
}

/** extract_search_request_config removes these keys before dispatching to
 * either service. The remaining keys, including _xpath_query and owner
 * exclusions, reach the endpoint as parameters. */
const CONFIGURATION_KEYS = new Set([
	"case_type",
	"x_commcare_data_registry",
	"x_commcare_custom_related_case_property",
	"x_commcare_include_all_related_cases",
	"commcare_sort",
	"x_commcare_endpoint_id",
	"x_commcare_tag_module_name",
]);
export function isProjectSearchParameter(name: string): boolean {
	return name.length > 0 && !CONFIGURATION_KEYS.has(name);
}

/** HQ appends these keys when the selected route supplies them. They are part
 * of the external service contract even though the author did not name them. */
export function projectSearchRequestParameters(use: {
	parameters: readonly string[];
	excludesOwners: boolean;
	sendsParent: boolean;
}) {
	return [
		...use.parameters,
		...(use.excludesOwners ? ["commcare_blacklisted_owner_ids"] : []),
		...(use.sendsParent ? ["_xpath_query"] : []),
	];
}
