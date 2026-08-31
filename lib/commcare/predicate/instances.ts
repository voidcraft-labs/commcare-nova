// lib/commcare/predicate/instances.ts
//
// Accumulate CCHQ wire instance ids reachable from a Predicate or
// ValueExpression AST. The accumulated set tells the suite-XML
// orchestrators (`<remote-request>`, case-loading `<entry>`,
// `<query>`-scoped data slots) which `<instance>` declarations to
// emit. Every XPath the wire interpolates must be paired with a
// matching `<instance>` declaration on the enclosing block — without
// it, the runtime cannot resolve the `instance('...')` reference at
// evaluation time. CCHQ's server-side suite generator catches the
// gap via `InstancesHelper.add_entry_instances`; Nova's local
// suite emission has no equivalent post-process pass, so the
// accumulation runs at compose time.
//
// The mapping from Term kind to instance id is fixed by CCHQ's wire
// vocabulary:
//
//   - `prop` → `casedb` (Nova always declares this on entries that
//     load cases; the wire emitter never emits a `prop` Term outside
//     a casedb context).
//   - `input` → `search-input:results` (CCHQ exposes the in-flight
//     search input values at this instance during `<remote-request>`
//     evaluation).
//   - `session-user` and `session-context` → `commcaresession` (CCHQ
//     exposes the bound user + framework metadata on this instance).
//   - `literal` → no instance (literals carry no runtime resolution).
//   - `table-column` and the `table-lookup` expression node → the current
//     table tag in XForms or `item-list:<tag>` in suite XML; both declarations
//     use `jr://fixture/item-list:<tag>` as their source.
//
// The `jr://` source URLs that pair with each id are CCHQ's
// canonical vocabulary; `instanceSourceFor` maps the scoped accumulated id
// to the `<instance src="...">` value the wire layer emits.

import type { LookupTableId } from "@/lib/domain/lookupIds";
import {
	type Predicate,
	type Term,
	type ValueExpression,
	walkExpressionNodes,
	walkExpressionTerms,
	walkPredicateExpressionNodes,
	walkTerms,
} from "@/lib/domain/predicate";
import { CASE_TYPE_REGEX } from "../constants";
import { type LookupWireNaming, lookupFixtureSrc } from "../lookup/naming";

/**
 * Whether `instanceId` is one of Nova's collection-valued case selectors.
 *
 * HQ recognizes any id containing `selected_cases`, but Nova generates a
 * deliberately smaller closed family: the ordinary id, Search's exact id,
 * zero or more parent-select prefixes, and the optional validated case-type
 * suffix root alignment adds when two child datums would otherwise collide.
 * Keeping that grammar explicit admits every generated name without turning
 * an arbitrary caller-controlled substring into a virtual-instance source.
 */
function isSelectedCasesInstanceId(instanceId: string): boolean {
	if (instanceId === "search_selected_cases") return true;
	const withoutParentPrefixes = instanceId.replace(/^(?:parent_)*/, "");
	if (withoutParentPrefixes === "selected_cases") return true;
	const renamedPrefix = "selected_cases_";
	return (
		withoutParentPrefixes.startsWith(renamedPrefix) &&
		CASE_TYPE_REGEX.test(withoutParentPrefixes.slice(renamedPrefix.length))
	);
}

/**
 * Map a CCHQ wire instance id to its `jr://` source URL. The single
 * source of truth across every suite-XML surface that emits
 * `<instance id="..." src="...">` declarations (the
 * `<remote-request>` orchestrator, the case-loading `<entry>`
 * derivation, future `<query>`-scoped slots). Lookup naming distinguishes an
 * XForm-local tag from a suite fixture id; both map to a source ending in the
 * exact fixture id. Other unknown ids throw — the AST
 * walker and the suite-XML emitters share the same closed id set, so
 * an unexpected id always indicates an upstream bug.
 */
export function instanceSourceFor(
	instanceId: string,
	lookup?: LookupWireNaming,
): string {
	switch (instanceId) {
		case "casedb":
			return "jr://instance/casedb";
		case "commcaresession":
			return "jr://instance/session";
		case "results":
			return "jr://instance/remote/results";
		case "results:inline":
			return "jr://instance/remote/results:inline";
		case "search-input:results":
			return "jr://instance/search-input/results";
		case "locations":
			return "jr://fixture/locations";
		default: {
			// CCHQ's selected-cases factory resolves this virtual source family.
			if (isSelectedCasesInstanceId(instanceId)) {
				return `jr://instance/selected-entities/${instanceId}`;
			}
			const table = lookup?.tables.find(
				(candidate) =>
					candidate.xformInstanceId === instanceId ||
					candidate.fixtureId === instanceId,
			);
			if (table !== undefined) return lookupFixtureSrc(table.fixtureId);
			throw new Error(
				`Unknown instance id '${instanceId}' reached the suite-XML instance source helper. ` +
					"The instance accumulator surfaced an id with no known jr:// source. Verify the accumulator and this helper agree on the closed id set.",
			);
		}
	}
}

/**
 * Collect every CCHQ wire instance id reachable from a Predicate.
 * The returned set is the union of per-Term instance refs plus one scoped
 * lookup instance id per referenced table; an empty
 * predicate (or one composed entirely of literals) returns the empty
 * set. Lookup carriers resolve through `lookup` naming — a carrier
 * reaching a surface with no naming is a wiring bug, because only the
 * local-CCZ compile path emits carriers and it always supplies the
 * validated snapshot's naming.
 */
export function collectPredicateInstances(
	predicate: Predicate,
	lookup?: LookupWireNaming,
	instanceScope: "xform" | "suite" = "suite",
): Set<string> {
	const instances = new Set<string>();
	walkPredicateExpressionNodes(predicate, (node) =>
		addTableLookupInstance(node, instances, lookup, instanceScope),
	);
	walkTerms(predicate, (term) =>
		addTermInstance(term, instances, lookup, instanceScope),
	);
	return instances;
}

/**
 * Collect every CCHQ wire instance id reachable from a
 * ValueExpression. Same contract as `collectPredicateInstances`,
 * rooted at a value expression instead.
 */
export function collectExpressionInstances(
	expression: ValueExpression,
	lookup?: LookupWireNaming,
	instanceScope: "xform" | "suite" = "suite",
): Set<string> {
	const instances = new Set<string>();
	walkExpressionNodes(expression, (node) =>
		addTableLookupInstance(node, instances, lookup, instanceScope),
	);
	walkExpressionTerms(expression, (term) =>
		addTermInstance(term, instances, lookup, instanceScope),
	);
	return instances;
}

function lookupInstanceId(
	tableId: LookupTableId,
	lookup: LookupWireNaming | undefined,
	instanceScope: "xform" | "suite",
): string {
	if (lookup === undefined) {
		throw new Error(
			"collectAstInstances: a lookup carrier reached suite instance collection with no lookup wire naming. The local-CCZ compile boundary supplies naming; every other surface should reject lookup carriers before instance collection.",
		);
	}
	const table = lookup.tableFor(tableId);
	return instanceScope === "xform" ? table.xformInstanceId : table.fixtureId;
}

function addTableLookupInstance(
	expression: ValueExpression,
	instances: Set<string>,
	lookup: LookupWireNaming | undefined,
	instanceScope: "xform" | "suite",
): void {
	if (expression.kind !== "table-lookup") return;
	instances.add(lookupInstanceId(expression.tableId, lookup, instanceScope));
}

function addTermInstance(
	term: Term,
	instances: Set<string>,
	lookup: LookupWireNaming | undefined,
	instanceScope: "xform" | "suite",
): void {
	switch (term.kind) {
		case "prop":
			instances.add("casedb");
			return;
		case "input":
			instances.add("search-input:results");
			return;
		case "session-user":
		case "session-user-property":
		case "session-context":
			instances.add("commcaresession");
			return;
		case "literal":
		case "field":
		case "fixed-location":
			return;
		case "owner-location-at-level":
			instances.add("locations");
			instances.add("casedb");
			return;
		case "table-column":
			instances.add(lookupInstanceId(term.tableId, lookup, instanceScope));
			return;
		default: {
			const _exhaustive: never = term;
			throw new Error(
				`collectAstInstances: unhandled term kind ${String(_exhaustive)}`,
			);
		}
	}
}
