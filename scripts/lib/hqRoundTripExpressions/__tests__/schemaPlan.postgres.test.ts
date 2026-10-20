/**
 * The cutover's case-schema plan against real stored cases (part 09 §8): a
 * declaration over a type whose cases already hold the key blocks, an
 * inferred retype counts the values `conversionImpact` finds uncastable, and
 * after the cutover commits, the drift writer converges the stored schemas
 * so the drift scan finds nothing and the uncastable values are parked.
 */

import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { withSchemaContext } from "@/lib/case-store";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { loadApp } from "@/lib/db/apps";
import { withAppTx } from "@/lib/db/pg";
import { computeSchemaDrift } from "../../schemaDrift";
import { prepareSchemaDriftRepairInAppTransaction } from "../../schemaDriftMigration";
import { readPlannedFleet } from "../fleet";
import { runMigrate } from "../run";
import { readSchemaChangeImpacts } from "../schemaPlan";
import { FOLD_HORIZON_MIGRATION } from "../writer";
import {
	fixtureApp,
	readFixtureManifest,
	seedCase,
	seedPreStepApp,
	seedStoredSchemas,
} from "./postgresSeed";

/* From main's migration prefix: the writer applies the fold horizon itself
 * and refuses any other ledger. */
const h = setupAppStateTestDb("hq_expr_schema_plan_", {
	authSchema: "migrated",
	caseStoreMigrationsBefore: FOLD_HORIZON_MIGRATION,
});

const OWNER = "owner-expr-schema-plan";
const PROJECT = "project-expr-schema-plan";

/** Seed a fixture with its pre-step stored schemas; return its planned changes. */
async function seedApp(id: string, appId: string) {
	await seedPreStepApp(
		h.db(),
		fixtureApp(id, { appId, projectId: PROJECT, owner: OWNER }),
	);
	const planned = await readPlannedFleet(h.db(), { appId });
	const target = planned.targets.get(appId);
	const app = planned.plan.apps.find((candidate) => candidate.appId === appId);
	if (target === undefined || app === undefined) {
		throw new Error(`Fixture ${id} has no target.`);
	}
	await seedStoredSchemas(h.db(), appId, target, app.schemaChanges);
	return app.schemaChanges;
}

async function blockerCodes(appId: string): Promise<string[]> {
	const planned = await readPlannedFleet(h.db(), { appId });
	return (
		planned.plan.apps
			.find((app) => app.appId === appId)
			?.blockers.map((blocker) => blocker.code) ?? []
	);
}

describe("the case-schema plan", () => {
	it("blocks a declaration whose case type already holds the key, and only then", async () => {
		await h.seedProjectMember(OWNER, PROJECT, "owner");
		const fixture = readFixtureManifest().find(
			(entry) => entry.id === "orphan-read-property",
		);
		const orphans = (fixture?.context?.cases ?? []) as {
			caseType: string;
			properties: Record<string, unknown>;
		}[];
		expect(orphans.length).toBeGreaterThan(0);
		const changes = await seedApp("orphan-read-property", "app-orphan");
		const declared = changes.filter((change) => change.source === "declared");
		expect(declared.length).toBeGreaterThan(0);

		// Another app's case holding the same key is not this app's.
		await seedApp("orphan-read-property", "app-other");
		await seedCase(h.db(), {
			caseId: "other-app-case",
			appId: "app-other",
			projectId: PROJECT,
			caseType: orphans[0]?.caseType ?? "",
			ownerId: OWNER,
			properties: orphans[0]?.properties ?? {},
		});
		expect(await blockerCodes("app-orphan")).not.toContain(
			"declared-property-has-stored-values",
		);
		expect(await blockerCodes("app-other")).toContain(
			"declared-property-has-stored-values",
		);
		await h.withTransaction(async (tx) => {
			const impacts = await readSchemaChangeImpacts(tx, "app-orphan", declared);
			expect(impacts.map((impact) => impact.storedValues)).toEqual(
				declared.map(() => 0),
			);
		});

		// The fixture's orphan values, as `scan-orphan-property-keys.ts` leaves them.
		for (const [index, orphan] of orphans.entries()) {
			await seedCase(h.db(), {
				caseId: `orphan-${index}`,
				appId: "app-orphan",
				projectId: PROJECT,
				caseType: orphan.caseType,
				ownerId: OWNER,
				properties: orphan.properties,
			});
		}
		expect(await blockerCodes("app-orphan")).toContain(
			"declared-property-has-stored-values",
		);
		await h.withTransaction(async (tx) => {
			const impacts = await readSchemaChangeImpacts(tx, "app-orphan", declared);
			expect(
				impacts.some((impact) => impact.storedValues > 0),
				"the orphan key is counted",
			).toBe(true);
		});
		const dryRun = await runMigrate(h.db(), { mode: "dry-run" });
		expect(dryRun.outcome).toMatchObject({
			outcome: "stopped",
			stoppedBy: ["blocker"],
		});
	}, 60_000);

	it("counts an inferred retype's uncastable values, and the drift writer parks them after the cutover", async () => {
		await h.seedProjectMember(OWNER, PROJECT, "owner");
		const changes = await seedApp("hidden-inference", "app-inferred");
		const inferred = changes.filter((change) => change.source === "inferred");
		expect(inferred.length).toBeGreaterThan(0);
		const [retype] = inferred;
		if (retype === undefined) throw new Error("No inferred retype.");
		expect(retype.to).not.toBe("text");
		await seedCase(h.db(), {
			caseId: "uncastable",
			appId: "app-inferred",
			projectId: PROJECT,
			caseType: retype.caseType,
			ownerId: OWNER,
			properties: { [retype.property]: "never a typed value" },
		});

		await h.withTransaction(async (tx) => {
			const impacts = await readSchemaChangeImpacts(
				tx,
				"app-inferred",
				inferred,
			);
			expect(impacts[0]).toMatchObject({ storedValues: 0, uncastable: 1 });
		});
		// Parking is the designed path, so an uncastable value never blocks.
		expect(await blockerCodes("app-inferred")).toEqual([]);

		const dryRun = await runMigrate(h.db(), { mode: "dry-run" });
		expect(dryRun.outcome).toEqual({ outcome: "ok" });
		const executed = await runMigrate(h.db(), {
			mode: "execute",
			expectPlanDigest: dryRun.report
				.all()
				.find((line) => line.section === "fleet")?.planDigest as string,
		});
		expect(executed.outcome).toEqual({ outcome: "ok" });

		// The committed target derives the retype; the stored rows still hold
		// the old type until the drift writer runs after the deploy.
		const before = await loadApp("app-inferred");
		if (before === null) throw new Error("The app no longer loads.");
		expect(
			(
				await computeSchemaDrift(
					h.db() as never,
					"app-inferred",
					before.blueprint,
				)
			).length,
		).toBeGreaterThan(0);

		// `migrate-schema-drift.ts --execute`, through its own library.
		const store = await withSchemaContext();
		const prepared = await withAppTx((tx) =>
			prepareSchemaDriftRepairInAppTransaction(tx, store, "app-inferred"),
		);
		await prepared?.completeAfterCommit();

		const after = await loadApp("app-inferred");
		if (after === null) throw new Error("The app no longer loads.");
		expect(
			await computeSchemaDrift(
				h.db() as never,
				"app-inferred",
				after.blueprint,
			),
		).toEqual([]);
		const parked = await sql<{ case_id: string; property: string }>`
			SELECT case_id, property FROM parked_case_values
			WHERE app_id = 'app-inferred' AND dismissed_at IS NULL
		`.execute(h.db());
		expect(parked.rows).toEqual([
			{ case_id: "uncastable", property: retype.property },
		]);
	}, 60_000);
});
