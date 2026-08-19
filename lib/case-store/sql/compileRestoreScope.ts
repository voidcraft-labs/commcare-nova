// lib/case-store/sql/compileRestoreScope.ts
//
// Restore scope — the cases a worker's device would actually hold.
//
// CommCare does not filter a restore by ownership; it takes a FIXPOINT.
// Ownership only seeds it, and extension chains then pull in cases nobody
// owns. The rules are `casexml/apps/phone/data_providers/case/livequery.py::
// get_live_case_ids_and_indices` (its `classify`, `enliven`,
// `has_live_extension`, and `is_extension` closures — `do_livequery` is only
// the caller that seeds them):
//
// - a case is AVAILABLE if it is open and not an extension case, or open and
//   the extension of an available case. A case that is both a child and an
//   extension counts as NOT an extension, so it is available on the first arm.
// - a case is LIVE if it is owned and available; liveness then propagates
//   through three edge kinds at once (`enliven`) — a live case makes its
//   extensions, its hosts, and its parents live.
//
// Two consequences are easy to get backwards, and both are pinned by HQ's own
// `case_relationship_tests.json` fixtures:
//
// - A CLOSED case can be in the result. `classify`'s owned arm calls
//   `enliven(ref_id)` unconditionally and closed cases are excluded from
//   `open_ids` rather than from the graph, so an owned child pulls in its
//   closed parent (`Live_Dependence`), which then pulls in its own open
//   extensions (`Closed_Extension_With_Children`).
// - A closed HOST kills its extension chain (`Delegate_Closure`), because
//   availability walks upward only while each subordinate is open.
//
// The `livequery.py` module docstring is NOT the oracle — its eighth example
// claims `a(closed) <--ext-- b <--chi-- c(owned) >> []`, while the pinned
// fixture of exactly that shape, `open_child_of_closed_extension`, expects
// `["a","b","c"]`. `test_extension_indexes.py` runs the fixture file.
//
// ## One deliberate divergence
//
// HQ evaluates `classify`'s first branch when an edge is first SEEN, so for an
// extension edge whose subordinate is closed — otherwise ignored — whether it
// propagates depends on batch order. HQ is genuinely order-dependent there.
// This formulation is HQ's monotone completion: it agrees exactly on all 45
// pinned fixtures, and where HQ's own answer moves under permutation it
// returns the union rather than one arbitrary run. It is never SMALLER than
// HQ, which is the direction that matters — a restore Nova shows must not omit
// a case the device would hold.

import type { AliasableExpression, Expression, Kysely } from "kysely";
import type { Database } from "./database";

export interface RestoreScopeArgs {
	/** First half of `(app_id, project_id)`. */
	readonly appId: string;
	/** Second half — the bound Project (tenant). */
	readonly projectId: string;
	/**
	 * The worker's owner ids: their own id plus one per case-sharing group
	 * (`lib/organization/ownerSets.ts`). Seeds the fixpoint and nothing else —
	 * ownership is not a filter on the result.
	 */
	readonly ownerIds: readonly string[];
}

/**
 * A statement carrying the closure, plus the membership test that reads it.
 *
 * Both halves come from ONE precisely typed builder chain; the two casts here
 * are the same type-erasure the multi-hop relation loop uses
 * (`compileRelationPath.ts`'s `DynamicQuery`), and for the same reason — the
 * CTE names are not part of the persisted `Database`, and letting them leak
 * into it would make `live` addressable from every unrelated query.
 */
export interface RestoreScopeQuery {
	/**
	 * The same database, with the two CTEs attached to the next statement built
	 * from it. Every existing filter, sort key, and join stays where it is.
	 */
	readonly creator: Kysely<Database>;
	/** `SELECT case_id FROM live` — pair with `where(<caseIdColumn>, "in", …)`. */
	readonly membership: Expression<string>;
}

/**
 * The one place a case's openness is decided.
 *
 * `cases.status` is nullable with no database default and the insert shape
 * makes it optional, so a great many rows carry NULL. `status = 'open'` would
 * silently erase every one of them from restore scope, which is why this is
 * `is distinct from 'closed'` — absent means open, exactly as it does
 * wherever else a case's lifecycle is read.
 */
const CLOSED = "closed";

/**
 * Build the restore-scope fixpoint for one worker.
 *
 * **Tenancy is reached only by joining `cases`.** `case_indices` carries no
 * `app_id` or `project_id` and no foreign key to `cases`, so every hop joins
 * both endpoints on `(app_id, project_id)` — the discipline
 * `compileRelationPath` applies per hop. A dangling or cross-tenant edge then
 * drops out for free rather than needing its own guard.
 *
 * **The closure crosses case types deliberately.** An owned patient pulling in
 * its household parent is the point, so nothing here filters `case_type`; the
 * caller's own `case_type` filter still chooses which live cases it lists.
 *
 * **The hold is an outer filter, not a graph filter.** A case parked by
 * `parked_case_values` stays out of the returned list but still relays
 * liveness, because restore membership is a fact about the device and parking
 * one property value must not drop a whole extension subtree from view.
 */
export function buildRestoreScope(
	db: Kysely<Database>,
	args: RestoreScopeArgs,
): RestoreScopeQuery {
	const { appId, projectId, ownerIds } = args;

	if (ownerIds.length === 0) {
		// Not a state a caller can reach honestly: `personaOwnerIds` always
		// leads with the persona's own uuid and `memberOwnerIds` with the
		// member's user id, exactly as `CouchUser.get_owner_ids` always leads
		// with the user's own id. An empty set means the derivation upstream
		// broke, and answering it with an empty restore would hide that behind
		// a believable "this worker holds no cases".
		throw new Error(
			"Tried to build a restore scope for a worker with no owner ids. " +
				"Every worker owns at least their own id, so an empty set means " +
				"the owner set was never derived. Check the caller that produced " +
				"it — `personaOwnerIds` for a persona, `memberOwnerIds` for the " +
				"signed-in member.",
		);
	}

	const scoped = db
		.withRecursive("avail(case_id, is_open)", (qb) =>
			qb
				// Seed: the worker's own open cases. `owner_id` seeds the fixpoint;
				// it is not a filter on the result.
				.selectFrom("cases as seed")
				.select((eb) => ["seed.case_id", eb.lit<boolean>(true).as("is_open")])
				.where("seed.app_id", "=", appId)
				.where("seed.project_id", "=", projectId)
				.where("seed.status", "is distinct from", CLOSED)
				.where("seed.owner_id", "in", ownerIds)
				// Walk UP extension edges toward the host, carrying whether each
				// host is itself open. The walk continues only FROM an open row,
				// which is what makes a closed host terminate the chain rather than
				// relay availability past itself.
				//
				// `union`, never `unionAll`: two hosts of one extension make the
				// graph a diamond, and only the distinct union terminates.
				.union((eb) =>
					eb
						.selectFrom("avail")
						.innerJoin("case_indices as ci", (join) =>
							join
								.onRef("ci.case_id", "=", "avail.case_id")
								.on("ci.depth", "=", 1)
								.on("ci.relationship", "=", "extension"),
						)
						.innerJoin("cases as host", (join) =>
							join
								.onRef("host.case_id", "=", "ci.ancestor_id")
								.on("host.app_id", "=", appId)
								.on("host.project_id", "=", projectId),
						)
						.select((inner) => [
							"host.case_id",
							inner("host.status", "is distinct from", CLOSED)
								.$castTo<boolean>()
								.as("is_open"),
						])
						.where("avail.is_open", "=", true),
				),
		)
		.withRecursive("live(case_id)", (qb) =>
			qb
				// Seed: available cases that are open and NOT extension cases —
				// HQ's `enliven open roots` pass, both of its loops at once. An
				// owned case with any child edge is already not-an-extension, and a
				// host reached at one or more hops is precisely
				// `has_live_extension`.
				.selectFrom("avail")
				.select("avail.case_id")
				.where("avail.is_open", "=", true)
				.where((eb) =>
					eb.not(
						eb.exists(
							// `is_extension` is "has an extension edge AND no child
							// edge", so a case is NOT an extension exactly when this
							// aggregate finds no row: `bool_and` over zero edges is
							// NULL (a case with no index is not an extension), false
							// as soon as one edge is a child, and true only when
							// every edge is an extension.
							//
							// **The aggregate is load-bearing, not a style choice.**
							// Written as two plain `EXISTS` probes the same rule reads
							// more directly, and Postgres then lifts each one into a
							// hashed semi-join over the WHOLE tenant's `case_indices`
							// ⋈ `cases` — measured at ~110 ms of a ~210 ms statement
							// on a 50k-case tenant whose restore held 54 cases, and
							// flat in the size of the restore. A subquery carrying an
							// aggregate cannot be pulled up, so this one stays a
							// correlated probe: a handful of index rows per available
							// case.
							//
							// The join to `cases` is what makes a dangling or
							// cross-tenant edge unable to answer the question.
							eb
								.selectFrom("case_indices as probe")
								.innerJoin("cases as probe_far", (join) =>
									join
										.onRef("probe_far.case_id", "=", "probe.ancestor_id")
										.on("probe_far.app_id", "=", appId)
										.on("probe_far.project_id", "=", projectId),
								)
								.select((probe) => probe.lit(1).as("is_extension_case"))
								.whereRef("probe.case_id", "=", "avail.case_id")
								.where("probe.depth", "=", 1)
								.having((probe) =>
									probe.fn
										.agg<boolean>("bool_and", [
											probe("probe.relationship", "=", "extension"),
										])
										.$castTo<boolean>(),
								),
						),
					),
				)
				// Propagation. ONE join over `case_indices` with an OR rather than a
				// union of three arms: Postgres allows the recursive name exactly
				// once in the recursive term, and this shape also lets the planner
				// reach the edge table through a bitmap OR of its two indexes, which
				// is what keeps the walk proportional to the live set instead of the
				// tenant's edge count.
				.union((eb) =>
					eb
						.selectFrom("live")
						.innerJoin("case_indices as ci", (join) =>
							join.on("ci.depth", "=", 1).on((on) =>
								on.or([
									// live is the subordinate: step up to its parent or
									// host, whatever the relationship and whatever the
									// ancestor's status.
									on(on.ref("ci.case_id"), "=", on.ref("live.case_id")),
									// live is the host: step down to its extension.
									on.and([
										on(on.ref("ci.ancestor_id"), "=", on.ref("live.case_id")),
										on("ci.relationship", "=", "extension"),
									]),
								]),
							),
						)
						.innerJoin("cases as nxt", (join) =>
							join
								.on((on) => on(on.ref("nxt.case_id"), "=", nextCaseId(on)))
								.on("nxt.app_id", "=", appId)
								.on("nxt.project_id", "=", projectId),
						)
						.select((inner) => nextCaseId(inner).as("case_id"))
						.where((inner) =>
							inner.or([
								// Upward is unconditional: a live child pulls in its
								// parent and a live extension pulls in its host even when
								// that ancestor is closed.
								inner(inner.ref("ci.case_id"), "=", inner.ref("live.case_id")),
								// Downward requires the extension itself to be open —
								// HQ's `extensions_by_host` only ever holds open ones.
								inner("nxt.status", "is distinct from", CLOSED),
							]),
						),
				),
		);

	return {
		creator: scoped as unknown as Kysely<Database>,
		membership: scoped
			.selectFrom("live")
			.select("live.case_id") as unknown as Expression<string>,
	};
}

/**
 * The next case in a propagation hop: the ancestor when the live case is the
 * subordinate, the subordinate when the live case is the host. The join
 * condition and the projection must agree exactly, so both call this.
 *
 * Typed structurally for the same reason `compileRelationPath`'s `DynamicQuery`
 * is: the join callback and the select callback hand out expression builders
 * over different table sets, and the expression itself is identical.
 */
interface CaseHopBuilder {
	ref: (reference: string) => unknown;
	case: () => {
		when: (
			lhs: unknown,
			op: "=",
			rhs: unknown,
		) => {
			then: (value: unknown) => {
				else: (value: unknown) => { end: () => unknown };
			};
		};
	};
}

function nextCaseId(eb: CaseHopBuilder): AliasableExpression<string> {
	return eb
		.case()
		.when(eb.ref("ci.case_id"), "=", eb.ref("live.case_id"))
		.then(eb.ref("ci.ancestor_id"))
		.else(eb.ref("ci.case_id"))
		.end() as AliasableExpression<string>;
}
