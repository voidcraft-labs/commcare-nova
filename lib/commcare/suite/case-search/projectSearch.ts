import type { Uuid } from "@/lib/domain";
import type { DatumRef, Expression } from "@/lib/domain/expression/types";
import type { OrdinaryCaseSearchConfig } from "@/lib/domain/modules";
import type { RewriteControl } from "../../emissionRewrites";
import type { ModuleExpressionContexts } from "../../expressionContext";
import {
	isProjectSearchId,
	isProjectSearchParameter,
} from "../../hq/projectSearch";
import type { LookupWireNaming } from "../../lookup/naming";
import { w } from "../../xpath/wire/builders";
import { toWire } from "../../xpath/wire/fromExpression";
import { resultsInstance } from "../../xpath/wire/instances";

type ProjectSearch = NonNullable<OrdinaryCaseSearchConfig["projectSearch"]>;

/** Bound by the destination, or observed directly in a source application. */
export function requiredProjectSearchId(id: number | undefined): number {
	if (!isProjectSearchId(id))
		throw new Error(
			"Choose a project space and connect its search before preparing this app.",
		);
	return id;
}

export function projectSearchValue(
	value: Expression,
	parameterUuid: Uuid,
	expressions: ModuleExpressionContexts,
	lookupNaming: LookupWireNaming | undefined,
	searchInputInstanceId: `search-input:${string}` | undefined,
	datumId?: (ref: DatumRef) => string | undefined,
	rewrites?: RewriteControl,
) {
	return toWire(value, {
		target: "suite",
		types: expressions({
			slot: "project_search_parameter",
			member: { parameterUuid },
		}),
		bindings: {
			datumId,
			searchInputInstanceId,
			...(lookupNaming && {
				lookup: { naming: lookupNaming, instanceScope: "suite" },
			}),
		},
		rewrites,
	});
}

/** HQ sends these request values unchanged to the selected service. The
 * device evaluates each XPath even when its name happens to be _xpath_query. */
export function projectSearchValues(
	search: ProjectSearch,
	expressions: ModuleExpressionContexts,
	lookupNaming: LookupWireNaming | undefined,
	searchInputInstanceId: `search-input:${string}` | undefined,
	datumId?: (ref: DatumRef) => string | undefined,
	rewrites?: (uuid: Uuid) => RewriteControl | undefined,
) {
	return search.defaults.map(({ uuid, name, value }) => {
		if (!isProjectSearchParameter(name))
			throw new Error(
				"Choose a parameter name that the project space passes to its search.",
			);
		return {
			name,
			value: projectSearchValue(
				value,
				uuid,
				expressions,
				lookupNaming,
				searchInputInstanceId,
				datumId,
				rewrites?.(uuid),
			),
		};
	});
}

/** Every returned element is eligible here. An inline route can narrow these
 * rows after this step when it joins them to the worker's parent selection. */
export function projectSearchResults(
	storageInstance: "results" | `results:${string}`,
) {
	return w.instance(resultsInstance(storageInstance), [
		w.step("results"),
		w.step("case"),
	]);
}
