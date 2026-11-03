/**
 * `catalog.ts` reads the live object under production's heap order (step 5's
 * part 09, section 15.2). The plausible failure is a catalog read that
 * resolves a constraint or a routine by its name alone: production holds
 * app-test namespaces whose tables carry copies of the app tables' checks,
 * and a name-only scan answers whichever tuple it meets first. After a
 * `VACUUM FULL` and with index scans off, that is the copy made before the
 * window replaced the live object, so a read by name would prove the window's
 * migrations from the copy that predates them.
 *
 * The test builds that order and observes it rather than assuming it: the
 * decoy's catalog tuples sit at a lower `ctid` than the live ones, and a
 * name-only control read returns the decoy's definition. Only then does it
 * hold each `catalog.ts` function to the live definition. Gated run G5 is
 * this test's first CI run; a precondition that does not hold fails as a
 * harness defect, never as a pass.
 */

import { type Kysely, sql } from "kysely";
import { describe, expect, it } from "vitest";
import { runCaseStoreMigrationsWithReport } from "@/lib/case-store/migrate";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import type { AppDatabase } from "@/lib/db/pg";
import {
	CatalogObjectMissingError,
	constraintDefinition,
	relationConstraints,
	routineDefinition,
	schemaRoutines,
} from "../catalog";
import {
	MARKER_BATCH_ID,
	PENDING_MIGRATIONS,
	PUBLISH_PLACEMENT_MIGRATION,
} from "../types";

const h = setupAppStateTestDb("case_writes_catalog_", {
	authSchema: "migrated",
	caseStoreMigrationsBefore: PUBLISH_PLACEMENT_MIGRATION,
});

const CONFIRMATIONS = "app_deployment_confirmations";
const KIND_CHECK = "app_deployment_confirmations_kind_check";
const COMMTRACK_SUBJECT = "app_deployment_confirmations_commtrack_subject";
const ADMIT_CHANGE = "nova_admit_app_change_insert";
const ADMIT_BASELINE = "nova_admit_app_change_fold_baseline_insert";
const REQUIRE_BASELINE = "nova_require_app_change_fold_baseline";
/** The three routines the window's migrations replace, by signature. */
const ROUTINES = [ADMIT_CHANGE, ADMIT_BASELINE, REQUIRE_BASELINE] as const;

function missingSentence(kind: string, name: string, where: string): string {
	return `The catalog has no ${kind} ${name} on ${where}, which this cutover reads to prove its migrations applied. The cutover stopped; compare the ledger with main's migrations.`;
}

/**
 * Steps 1 to 4 of section 15.2: compact the two catalog heaps, seed the
 * app-test namespace decoy with the pre-window confirmation table and the
 * three routines as `public` holds them before the migrations, turn index
 * scans off for the per-test database and this session, then apply the three
 * migrations through the production `Migrator`, so each live tuple is
 * appended after the decoy's. Returns the decoy namespace.
 */
async function seedDecoyThenMigrate(session: Kysely<AppDatabase>) {
	// 1. Compacted heaps: later tuples append after the existing ones.
	await sql`VACUUM FULL pg_catalog.pg_constraint`.execute(session);
	await sql`VACUUM FULL pg_catalog.pg_proc`.execute(session);

	// 2. The decoy, the way production's app-test namespaces are made.
	const created = await sql<{ namespace: string }>`
		SELECT public.nova_create_app_test_namespace(gen_random_uuid()) AS namespace
	`.execute(session);
	const namespace = created.rows[0]?.namespace;
	if (namespace === undefined) {
		throw new Error(
			"nova_create_app_test_namespace answered no namespace, so the decoy could not be seeded.",
		);
	}
	await sql`
		CREATE TABLE ${sql.id(namespace, CONFIRMATIONS)}
			(LIKE public.app_deployment_confirmations INCLUDING CONSTRAINTS)
	`.execute(session);
	for (const routine of ROUTINES) {
		const definition = await routineDefinition(
			session,
			"public",
			`${routine}()`,
		);
		const header = `CREATE OR REPLACE FUNCTION public.${routine}()`;
		expect(
			definition.startsWith(header),
			`pg_get_functiondef printed public.${routine} without its schema-qualified header, so the decoy cannot be re-targeted at the namespace.`,
		).toBe(true);
		const retargeted = `CREATE OR REPLACE FUNCTION ${namespace}.${routine}()${definition.slice(header.length)}`;
		await sql.raw(retargeted).execute(session);
	}

	// 3. Index scans off, for the per-test database (which dies with the
	// test) and for this session.
	await sql`
		DO $$ BEGIN
			EXECUTE pg_catalog.format('ALTER DATABASE %I SET enable_indexscan = off', pg_catalog.current_database());
		END $$
	`.execute(session);
	await sql`SET enable_indexscan = off`.execute(session);

	// 4. The window's migrations, through the production Migrator.
	const report = await runCaseStoreMigrationsWithReport(
		session as unknown as Kysely<unknown>,
	);
	expect(report.appliedMigrationNames).toEqual(PENDING_MIGRATIONS);
	return namespace;
}

/** Whether the decoy's catalog tuple precedes the live one in its heap. */
async function decoyPrecedes(
	session: Kysely<AppDatabase>,
	query: "constraint" | "routine",
	namespace: string,
): Promise<boolean> {
	const result =
		query === "constraint"
			? await sql<{ precedes: boolean }>`
				SELECT decoy.ctid < live.ctid AS precedes
				FROM pg_catalog.pg_constraint AS decoy, pg_catalog.pg_constraint AS live
				WHERE decoy.conrelid = pg_catalog.to_regclass(pg_catalog.format('%I.%I', ${namespace}::text, ${CONFIRMATIONS}::text))
					AND decoy.conname = ${KIND_CHECK}
					AND live.conrelid = pg_catalog.to_regclass(pg_catalog.format('%I.%I', 'public', ${CONFIRMATIONS}::text))
					AND live.conname = ${KIND_CHECK}
			`.execute(session)
			: await sql<{ precedes: boolean }>`
				SELECT decoy.ctid < live.ctid AS precedes
				FROM pg_catalog.pg_proc AS decoy, pg_catalog.pg_proc AS live
				WHERE decoy.oid = pg_catalog.to_regprocedure(pg_catalog.format('%I.%s', ${namespace}::text, ${`${ADMIT_CHANGE}()`}::text))
					AND live.oid = pg_catalog.to_regprocedure(pg_catalog.format('%I.%s', 'public', ${`${ADMIT_CHANGE}()`}::text))
			`.execute(session);
	expect(
		result.rows,
		`the decoy and the live ${query} each answer exactly one catalog row`,
	).toHaveLength(1);
	return result.rows[0]?.precedes === true;
}

const HARNESS_DEFECT =
	"The heap-order precondition does not hold on this Postgres, so this test cannot tell a name-only catalog read from a relation-qualified one. That is a harness defect, not a pass: move the seeding as part 09 G5's outcome B says (the decoy after the VACUUM FULLs, the live objects dropped and re-created after it) until the ctid order holds.";

describe("catalog.ts under production's heap order", () => {
	it("reads the live constraint and routine where a name-only read answers the app-test decoy", async () => {
		await h
			.db()
			.connection()
			.execute(async (session) => {
				const namespace = await seedDecoyThenMigrate(session);

				// 5. The precondition, observed by ctid, with its name-only control.
				expect(
					await decoyPrecedes(session, "constraint", namespace),
					HARNESS_DEFECT,
				).toBe(true);
				expect(
					await decoyPrecedes(session, "routine", namespace),
					HARNESS_DEFECT,
				).toBe(true);
				const byConstraintName = await sql<{ definition: string }>`
					SELECT pg_catalog.pg_get_constraintdef(oid) AS definition
					FROM pg_catalog.pg_constraint
					WHERE conname = ${KIND_CHECK}
					LIMIT 1
				`.execute(session);
				const decoyKinds = byConstraintName.rows[0]?.definition ?? "";
				expect(decoyKinds, HARNESS_DEFECT).toContain("form-entry-sync-off");
				expect(decoyKinds, HARNESS_DEFECT).not.toContain("commtrack-off");
				const byRoutineName = await sql<{ definition: string }>`
					SELECT pg_catalog.pg_get_functiondef(oid) AS definition
					FROM pg_catalog.pg_proc
					WHERE proname = ${ADMIT_CHANGE}
					LIMIT 1
				`.execute(session);
				const decoyBody = byRoutineName.rows[0]?.definition ?? "";
				expect(decoyBody, HARNESS_DEFECT).toContain(namespace);
				expect(decoyBody, HARNESS_DEFECT).not.toContain("'publish-placement'");

				// 6. Every catalog.ts function answers the live definition.
				const kinds = await constraintDefinition(
					session,
					"public",
					CONFIRMATIONS,
					KIND_CHECK,
				);
				expect(kinds).toContain("'commtrack-off'");
				expect(kinds).not.toBe(decoyKinds);
				expect(
					await constraintDefinition(
						session,
						"public",
						CONFIRMATIONS,
						COMMTRACK_SUBJECT,
					),
				).toContain("'commtrack-off'");

				const admitChange = await routineDefinition(
					session,
					"public",
					`${ADMIT_CHANGE}()`,
				);
				expect(admitChange).toContain("'publish-placement'");
				expect(admitChange).not.toContain(namespace);
				for (const routine of [ADMIT_BASELINE, REQUIRE_BASELINE]) {
					const body = await routineDefinition(
						session,
						"public",
						`${routine}()`,
					);
					expect(body).toContain(`'${MARKER_BATCH_ID}'`);
					expect(body).not.toContain(namespace);
				}

				const liveConstraints = await relationConstraints(
					session,
					"public",
					CONFIRMATIONS,
				);
				/* The decoy's set, read by its own relation: the cutover names no
				 * schema but `public`, so this read is the test's own. */
				const decoyConstraints = await sql<{
					name: string;
					definition: string;
				}>`
					SELECT c.conname AS name, pg_catalog.pg_get_constraintdef(c.oid) AS definition
					FROM pg_catalog.pg_constraint AS c
					WHERE c.conrelid = pg_catalog.to_regclass(pg_catalog.format('%I.%I', ${namespace}::text, ${CONFIRMATIONS}::text))
				`.execute(session);
				expect(liveConstraints.get(KIND_CHECK)).toBe(kinds);
				expect(liveConstraints.has(COMMTRACK_SUBJECT)).toBe(true);
				expect(decoyConstraints.rows).toContainEqual({
					name: KIND_CHECK,
					definition: decoyKinds,
				});
				expect(
					decoyConstraints.rows.some((row) => row.name === COMMTRACK_SUBJECT),
				).toBe(false);
				const byOid = await sql<{ name: string }>`
					SELECT c.conname AS name
					FROM pg_catalog.pg_constraint AS c
					JOIN pg_catalog.pg_class AS r ON r.oid = c.conrelid
					JOIN pg_catalog.pg_namespace AS n ON n.oid = r.relnamespace
					WHERE n.nspname = 'public' AND r.relname = ${CONFIRMATIONS}
				`.execute(session);
				expect([...liveConstraints.keys()].sort()).toEqual(
					byOid.rows.map((row) => row.name).sort(),
				);

				const routines = await schemaRoutines(session, "public");
				for (const routine of ROUTINES) {
					expect(routines.get(`${routine}()`)).toBe(
						await routineDefinition(session, "public", `${routine}()`),
					);
				}
				for (const [signature, body] of routines) {
					expect(
						body.includes(namespace),
						`public routine ${signature} is the namespace's copy`,
					).toBe(false);
				}
			});
	});

	it("throws its sentence for a missing relation, constraint and routine", async () => {
		const db = h.db();
		await expect(
			constraintDefinition(db, "public", "no_such_relation", KIND_CHECK),
		).rejects.toThrow(
			new CatalogObjectMissingError(
				missingSentence("relation", "no_such_relation", "public"),
			),
		);
		await expect(
			constraintDefinition(db, "public", CONFIRMATIONS, "no_such_constraint"),
		).rejects.toThrow(
			missingSentence(
				"constraint",
				"no_such_constraint",
				`public.${CONFIRMATIONS}`,
			),
		);
		await expect(
			relationConstraints(db, "public", "no_such_relation"),
		).rejects.toThrow(
			missingSentence("relation", "no_such_relation", "public"),
		);
		await expect(
			routineDefinition(db, "public", "nova_no_such_routine()"),
		).rejects.toThrow(
			missingSentence("routine", "nova_no_such_routine()", "public"),
		);
		/* A routine named with the wrong arguments is another signature, never
		 * the same-named routine by name alone. */
		await expect(
			routineDefinition(db, "public", `${ADMIT_CHANGE}(integer)`),
		).rejects.toThrow(
			missingSentence("routine", `${ADMIT_CHANGE}(integer)`, "public"),
		);
	});
});
