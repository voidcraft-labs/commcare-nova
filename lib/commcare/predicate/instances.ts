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
//   - `table-column` and the `table-lookup` expression node →
//     `item-list:<tag>` resolved from the validated lookup naming; the
//     paired src is `jr://fixture/item-list:<tag>`.
//
// The `jr://` source URLs that pair with each id are CCHQ's
// canonical vocabulary; `instanceSourceFor` maps the accumulated id
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
import {
	LOOKUP_FIXTURE_ID_PREFIX,
	type LookupWireNaming,
	lookupFixtureInstanceSrc,
} from "../lookup/naming";

/**
 * Map a CCHQ wire instance id to its `jr://` source URL. The single
 * source of truth across every suite-XML surface that emits
 * `<instance id="..." src="...">` declarations (the
 * `<remote-request>` orchestrator, the case-loading `<entry>`
 * derivation, future `<query>`-scoped slots). Lookup fixtures use the
 * open `item-list:<tag>` scheme, whose `jr://fixture/...` source must
 * end with the exact fixture id. Other unknown ids throw — the AST
 * walker and the suite-XML emitters share the same closed id set, so
 * an unexpected id always indicates an upstream bug.
 */
export function instanceSourceFor(instanceId: string): string {
	if (instanceId.startsWith(LOOKUP_FIXTURE_ID_PREFIX)) {
		return lookupFixtureInstanceSrc(instanceId);
	}
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
		default:
			throw new Error(
				`Unknown instance id '${instanceId}' reached the suite-XML instance source helper. ` +
					"The instance accumulator surfaced an id with no known jr:// source — verify the accumulator and this helper agree on the closed id set.",
			);
	}
}

/**
 * Collect every CCHQ wire instance id reachable from a Predicate.
 * The returned set is the union of per-Term instance refs plus one
 * `item-list:<tag>` id per referenced lookup table; an empty
 * predicate (or one composed entirely of literals) returns the empty
 * set. Lookup carriers resolve through `lookup` naming — a carrier
 * reaching a surface with no naming is a wiring bug, because only the
 * local-CCZ compile path emits carriers and it always supplies the
 * validated snapshot's naming.
 */
export function collectPredicateInstances(
	predicate: Predicate,
	lookup?: LookupWireNaming,
): Set<string> {
	const instances = new Set<string>();
	walkPredicateExpressionNodes(predicate, (node) =>
		addTableLookupInstance(node, instances, lookup),
	);
	walkTerms(predicate, (term) => addTermInstance(term, instances, lookup));
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
): Set<string> {
	const instances = new Set<string>();
	walkExpressionNodes(expression, (node) =>
		addTableLookupInstance(node, instances, lookup),
	);
	walkExpressionTerms(expression, (term) =>
		addTermInstance(term, instances, lookup),
	);
	return instances;
}

function lookupInstanceId(
	tableId: LookupTableId,
	lookup: LookupWireNaming | undefined,
): string {
	if (lookup === undefined) {
		throw new Error(
			"collectAstInstances: a lookup carrier reached suite instance collection with no lookup wire naming. The local-CCZ compile boundary supplies naming; every other surface should reject lookup carriers before instance collection.",
		);
	}
	return lookup.tableFor(tableId).instanceId;
}

function addTableLookupInstance(
	expression: ValueExpression,
	instances: Set<string>,
	lookup: LookupWireNaming | undefined,
): void {
	if (expression.kind !== "table-lookup") return;
	instances.add(lookupInstanceId(expression.tableId, lookup));
}

function addTermInstance(
	term: Term,
	instances: Set<string>,
	lookup: LookupWireNaming | undefined,
): void {
	switch (term.kind) {
		case "prop":
			instances.add("casedb");
			return;
		case "input":
			instances.add("search-input:results");
			return;
		case "session-user":
		case "session-context":
			instances.add("commcaresession");
			return;
		case "literal":
		case "field":
			return;
		case "table-column":
			instances.add(lookupInstanceId(term.tableId, lookup));
			return;
		default: {
			const _exhaustive: never = term;
			throw new Error(
				`collectAstInstances: unhandled term kind ${String(_exhaustive)}`,
			);
		}
	}
}
