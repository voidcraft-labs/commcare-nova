// lib/case-store/postgres/__tests__/restoreScope.test.ts
//
// `QueryArgs.restoreScope` through the real store: the outer scan, the count
// that has to agree with it, the hold's independence from the graph, and the
// relation walks — which are where scoping is easiest to get half-right.
//
// The closure's own rules are pinned against CommCare HQ's 45-graph
// acceptance table in `lib/case-store/sql/__tests__/compileRestoreScope.harness`.
// Nothing here re-tests liveness; these are the store's contracts.

import { Kysely, PostgresDialect, type PostgresPool } from "kysely";
import { beforeEach, describe, expect, it } from "vitest";
import type { CaseType } from "@/lib/domain";
import {
	ancestorPath,
	and,
	anyRelationPath,
	count as countOf,
	exists,
	gt,
	literal,
	relationStep,
	subcasePath,
} from "@/lib/domain/predicate/builders";
import type { RelationPath } from "@/lib/domain/predicate/types";
import { proseText } from "@/lib/domain/prose";
import { runCaseStoreMigrations } from "../../migrate";
import { HeuristicCaseGenerator } from "../../sample/heuristic";
import { setupPerTestDatabase } from "../../sql/__tests__/perTestDatabase";
import type { Database } from "../../sql/database";
import { PostgresCaseStore } from "../store";

const h = setupPerTestDatabase({ databaseNamePrefix: "restore_store_" });

const APP_ID = "restore-scope-app";
const PROJECT_ID = "restore-scope-project";
/** The worker previewing. Their device holds the closure of what they own. */
const WORKER = "worker-a";
/** A colleague. Their cases are in the tenant and not on this worker's device. */
const OTHER = "worker-b";

const schemas = new Map<string, CaseType>([
	[
		"household",
		{
			name: "household",
			label: proseText("Household"),
			properties: [],
		} as unknown as CaseType,
	],
	[
		"patient",
		{
			name: "patient",
			label: proseText("Patient"),
			properties: [],
		} as unknown as CaseType,
	],
]);

beforeEach(async () => {
	await runCaseStoreMigrations(h.db);
	await h.pool.query(
		`INSERT INTO apps (id, owner, project_id, app_name, app_name_lower)
		 VALUES ($1, 'member', $2, 'Restore', 'restore')`,
		[APP_ID, PROJECT_ID],
	);
});

function store() {
	return new PostgresCaseStore({
		projectId: PROJECT_ID,
		actorUserId: "member",
		ownerId: WORKER,
		db: h.db as unknown as Kysely<Database>,
		sampleGenerator: new HeuristicCaseGenerator(),
	});
}

async function addCase(args: {
	id: string;
	caseType: string;
	owner: string;
	status?: string | null;
}): Promise<void> {
	await h.pool.query(
		`INSERT INTO cases
		 (case_id, app_id, project_id, owner_id, case_type, case_name, status, properties)
		 VALUES ($1, $2, $3, $4, $5, $1, $6, '{}'::jsonb)`,
		[
			args.id,
			APP_ID,
			PROJECT_ID,
			args.owner,
			args.caseType,
			args.status ?? "open",
		],
	);
}

async function addEdge(args: {
	caseId: string;
	ancestorId: string;
	identifier: string;
	relationship: "child" | "extension";
}): Promise<void> {
	await h.pool.query(
		`INSERT INTO case_indices (case_id, ancestor_id, target_case_type, identifier, relationship, depth)
		 VALUES ($1, $2, 'test', $3, $4, 1)`,
		[args.caseId, args.ancestorId, args.identifier, args.relationship],
	);
}

const RESTORE = { ownerIds: [WORKER] } as const;

describe("the outer scan", () => {
	it("shows the worker's own cases and nothing else, and counts what it shows", async () => {
		await addCase({ id: "mine-1", caseType: "patient", owner: WORKER });
		await addCase({ id: "mine-2", caseType: "patient", owner: WORKER });
		await addCase({ id: "theirs", caseType: "patient", owner: OTHER });

		const rows = await store().query({
			appId: APP_ID,
			caseType: "patient",
			restoreScope: RESTORE,
		});
		expect(rows.map((row) => row.case_id).sort()).toEqual(["mine-1", "mine-2"]);

		// `count` and `query` compile the closure independently. A divergence
		// would reach the worker as a list of two under a heading that says
		// three, so the agreement is the contract, not an implementation detail.
		await expect(
			store().count({
				appId: APP_ID,
				caseType: "patient",
				restoreScope: RESTORE,
			}),
		).resolves.toBe(2);
	});

	it("leaves every authoring surface reading the whole tenant", async () => {
		await addCase({ id: "mine", caseType: "patient", owner: WORKER });
		await addCase({ id: "theirs", caseType: "patient", owner: OTHER });

		// No `restoreScope` is not a weaker restore — it is a different
		// question. The case workspace, sample data, and the rename preflight
		// are not standing at a device.
		const rows = await store().query({ appId: APP_ID, caseType: "patient" });
		expect(rows.map((row) => row.case_id).sort()).toEqual(["mine", "theirs"]);
	});

	it("pages the restricted population, each row exactly once", async () => {
		for (let i = 0; i < 5; i += 1) {
			await addCase({ id: `mine-${i}`, caseType: "patient", owner: WORKER });
			await addCase({ id: `theirs-${i}`, caseType: "patient", owner: OTHER });
		}

		const page = async (offset: number) =>
			(
				await store().query({
					appId: APP_ID,
					caseType: "patient",
					restoreScope: RESTORE,
					limit: 2,
					offset,
				})
			).map((row) => row.case_id);

		// LIMIT/OFFSET must see the restricted population. Filtering after the
		// page is cut would hand back short pages and skip rows entirely.
		const seen = [...(await page(0)), ...(await page(2)), ...(await page(4))];
		expect(seen.length).toBe(5);
		expect(new Set(seen).size).toBe(5);
	});

	it("crosses case types on the way in, then lists the type asked for", async () => {
		await addCase({ id: "household", caseType: "household", owner: OTHER });
		await addCase({ id: "patient", caseType: "patient", owner: WORKER });
		await addEdge({
			caseId: "patient",
			ancestorId: "household",
			identifier: "parent",
			relationship: "child",
		});

		// The household is nobody's owned case, and the device holds it anyway
		// because its child is owned — that is the whole point of a closure.
		const households = await store().query({
			appId: APP_ID,
			caseType: "household",
			restoreScope: RESTORE,
		});
		expect(households.map((row) => row.case_id)).toEqual(["household"]);
	});
});

describe("the grouped read", () => {
	it("groups only the cases the device holds", async () => {
		// Two households, one visit each. The worker owns one visit; the other
		// household's visit belongs to a colleague.
		await addCase({ id: "hh-mine", caseType: "household", owner: OTHER });
		await addCase({ id: "hh-theirs", caseType: "household", owner: OTHER });
		await addCase({ id: "visit-mine", caseType: "patient", owner: WORKER });
		await addCase({ id: "visit-theirs", caseType: "patient", owner: OTHER });
		for (const [visit, household] of [
			["visit-mine", "hh-mine"],
			["visit-theirs", "hh-theirs"],
		] as const) {
			await addEdge({
				caseId: visit,
				ancestorId: household,
				identifier: "parent",
				relationship: "child",
			});
		}

		const grouped = await store().queryGrouped({
			appId: APP_ID,
			caseType: "patient",
			indexIdentifier: "parent",
			groupOffset: 0,
			groupLimit: 10,
			restoreScope: RESTORE,
		});

		// A grouped case list is a DRAWING of the same read, so it inherits the
		// restore from the shared `buildCaseSelect` rather than re-deriving it.
		// This test exists because the caller reached the grouped path through
		// its own early return and could have dropped the scope there without
		// anything else noticing.
		expect(
			grouped.groups.flatMap((group) => group.rows.map((row) => row.case_id)),
		).toEqual(["visit-mine"]);
		expect(grouped.totalRows).toBe(1);
	});
});

describe("the hold", () => {
	it("keeps a held case out of the list while it still relays liveness", async () => {
		// household <-- patient(owned). The household is held.
		await addCase({ id: "household", caseType: "household", owner: OTHER });
		await addCase({ id: "sibling", caseType: "patient", owner: OTHER });
		await addCase({ id: "owned", caseType: "patient", owner: WORKER });
		await addEdge({
			caseId: "owned",
			ancestorId: "household",
			identifier: "parent",
			relationship: "child",
		});
		await addEdge({
			caseId: "sibling",
			ancestorId: "household",
			identifier: "parent",
			relationship: "child",
		});
		await h.pool.query(
			`INSERT INTO parked_case_values
			 (app_id, case_id, case_type, property, original_value, reason, from_type, to_type)
			 VALUES ($1, 'household', 'household', 'size', '"big"', 'retype', 'text', 'integer')`,
			[APP_ID],
		);

		// Restore membership is a fact about the device; parking ONE property
		// value must not drop a whole subtree out of what the preview shows.
		// So the hold is an outer filter, never a filter inside the closure.
		const households = await store().query({
			appId: APP_ID,
			caseType: "household",
			restoreScope: RESTORE,
		});
		expect(households).toEqual([]);

		const revealed = await store().query({
			appId: APP_ID,
			caseType: "household",
			restoreScope: RESTORE,
			includeHeld: true,
		});
		expect(revealed.map((row) => row.case_id)).toEqual(["household"]);

		// The sibling is NOT on the device, and that is the closure being
		// right rather than the hold interfering: liveness propagates up from a
		// live child and down only along EXTENSION edges, so an available
		// parent never enlivens its other children
		// (`livequery.py::has_live_extension`'s own docstring says so). The
		// household is here because its owned child pulled it in, and it stops
		// there.
		const patients = await store().query({
			appId: APP_ID,
			caseType: "patient",
			restoreScope: RESTORE,
		});
		expect(patients.map((row) => row.case_id)).toEqual(["owned"]);
	});
});

describe("the emitted statement", () => {
	it("declares the closure once, however many walks read it", async () => {
		await addCase({ id: "household", caseType: "household", owner: WORKER });
		await addCase({ id: "visit", caseType: "patient", owner: WORKER });
		await addEdge({
			caseId: "visit",
			ancestorId: "household",
			identifier: "visit",
			relationship: "child",
		});

		const statements: string[] = [];
		const logging = new Kysely<Database>({
			dialect: new PostgresDialect({
				pool: h.pool as unknown as PostgresPool,
			}),
			log: (event) => {
				statements.push(event.query.sql);
			},
		});
		await new PostgresCaseStore({
			projectId: PROJECT_ID,
			actorUserId: "member",
			ownerId: WORKER,
			db: logging,
			sampleGenerator: new HeuristicCaseGenerator(),
		}).query({
			appId: APP_ID,
			caseType: "household",
			caseTypeSchemas: schemas,
			// Two independent walks over one statement, so a per-walk copy of
			// the closure would show up as three declarations rather than one.
			predicate: and(
				exists(subcasePath("visit", "patient")),
				gt(countOf(anyRelationPath("visit", "patient")), literal(0)),
			),
			restoreScope: RESTORE,
		});
		// No `destroy()` — this wrapper shares the harness's pool, and the
		// harness owns closing it.
		const [statement] = statements;
		expect(statement).toBeDefined();
		// A Kysely creator carries its `WITH` clause into every query built
		// from it, so handing the CTE-bearing creator to the compile context
		// silently gives each leaf subquery its own copy of the closure —
		// correct results, recomputed per walk. It surfaces as a syntax error
		// only inside a `UNION` branch, which is one relation kind out of four.
		expect(statement?.match(/with recursive/gi) ?? []).toHaveLength(1);
	});
});

describe("relation walks", () => {
	/**
	 * Anchor `household` is live. `far` is a relative of the anchor that the
	 * worker's device does NOT hold, reachable by each relation kind. A walk
	 * that forgets the restore counts it.
	 */
	async function seedAnchorWithUnheldRelative(): Promise<void> {
		await addCase({ id: "household", caseType: "household", owner: WORKER });
		await addCase({ id: "far", caseType: "patient", owner: OTHER });
	}

	const cases: ReadonlyArray<{
		readonly kind: string;
		readonly path: RelationPath;
		readonly seed: () => Promise<void>;
	}> = [
		{
			kind: "subcase",
			path: subcasePath("visit", "patient"),
			// `far` indexes UP at the anchor, so the walk finds it going down.
			// A live case's children need NOT be live — HQ's own
			// `has_live_extension` says an available parent cannot enliven its
			// children — so this is where an unscoped walk over-counts.
			seed: async () =>
				addEdge({
					caseId: "far",
					ancestorId: "household",
					identifier: "visit",
					relationship: "child",
				}),
		},
		{
			kind: "any-relation",
			path: anyRelationPath("visit", "patient"),
			seed: async () =>
				addEdge({
					caseId: "far",
					ancestorId: "household",
					identifier: "visit",
					relationship: "child",
				}),
		},
	];

	for (const { kind, path, seed } of cases) {
		it(`excludes a non-live relative reached by ${kind}`, async () => {
			await seedAnchorWithUnheldRelative();
			await seed();

			const withScope = await store().query({
				appId: APP_ID,
				caseType: "household",
				caseTypeSchemas: schemas,
				predicate: exists(path),
				restoreScope: RESTORE,
			});
			expect(withScope).toEqual([]);

			// Same document, same predicate, no restore: the relative is really
			// there. Without this half the assertion above would pass on a
			// walk that is simply broken.
			const withoutScope = await store().query({
				appId: APP_ID,
				caseType: "household",
				caseTypeSchemas: schemas,
				predicate: exists(path),
			});
			expect(withoutScope.map((row) => row.case_id)).toEqual(["household"]);
		});
	}

	it("counts only the related cases the device holds", async () => {
		await addCase({ id: "household", caseType: "household", owner: WORKER });
		await addCase({ id: "held-visit", caseType: "patient", owner: WORKER });
		await addCase({ id: "far-visit", caseType: "patient", owner: OTHER });
		for (const id of ["held-visit", "far-visit"]) {
			await addEdge({
				caseId: id,
				ancestorId: "household",
				identifier: "visit",
				relationship: "child",
			});
		}

		// This is the bug the scoping exists to remove: "households with more
		// than one visit" would list a household whose second visit the worker
		// cannot open.
		const predicate = gt(countOf(subcasePath("visit", "patient")), literal(1));
		await expect(
			store().query({
				appId: APP_ID,
				caseType: "household",
				caseTypeSchemas: schemas,
				predicate,
				restoreScope: RESTORE,
			}),
		).resolves.toEqual([]);
		await expect(
			store().query({
				appId: APP_ID,
				caseType: "household",
				caseTypeSchemas: schemas,
				predicate,
			}),
		).resolves.toHaveLength(1);
	});

	it("applies the same rule to an ancestor walk, where it is provably a no-op", async () => {
		await addCase({ id: "household", caseType: "household", owner: OTHER });
		await addCase({ id: "patient", caseType: "patient", owner: WORKER });
		await addEdge({
			caseId: "patient",
			ancestorId: "household",
			identifier: "parent",
			relationship: "child",
		});

		// Every parent and host of a live case is itself live (the closure's
		// up-rule), so an ancestor walk can never reach a case outside the
		// restore. The restriction is applied here anyway — one rule with a
		// proven-redundant case beats three per-kind rules that can rot apart —
		// and this is the assertion that says so out loud. If it ever fails,
		// the up-rule changed and the redundancy argument is gone with it.
		await expect(
			store().query({
				appId: APP_ID,
				caseType: "patient",
				caseTypeSchemas: schemas,
				predicate: exists(ancestorPath(relationStep("parent"))),
				restoreScope: RESTORE,
			}),
		).resolves.toHaveLength(1);
	});
});
