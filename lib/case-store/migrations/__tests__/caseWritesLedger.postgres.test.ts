/**
 * The sixth fold identity, `fold-baseline:hq-round-trip-case-writes` by
 * `system:hq-round-trip-case-writes`, admitted by the database. The plausible
 * failures: the new arm left out of one of the two functions, so a marker
 * passes one and the other refuses it; the new batch id admitted under
 * another actor; an earlier identity's admission changed by the replacement;
 * a body that drifts from the one it copies; and a migration that resolves
 * either function by its name alone, so the trigger keeps an older body.
 *
 * Each identity is probed on its own app the way a cutover's fleet
 * transaction writes it: under the app row's lock the root moves one
 * sequence, every entity row is touched, then the marker and the baseline
 * carry the snapshot the database computes. The transaction commits, so the
 * deferred marker check runs too.
 */

import { randomUUID } from "node:crypto";
import { type Kysely, sql } from "kysely";
import { describe, expect, it } from "vitest";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import {
	down,
	up,
} from "../20261110020000_hq_round_trip_case_writes_fold_horizon";

const MIGRATION = "20261110020000_hq_round_trip_case_writes_fold_horizon";
const ADMIT = "public.nova_admit_app_change_fold_baseline_insert()";
const REQUIRE = "public.nova_require_app_change_fold_baseline()";

/* Every migration before this one: the admission functions as the HQ
 * round-trip expressions horizon wrote them. */
const h = setupAppStateTestDb("case_writes_ledger_", {
	authSchema: "migrated",
	caseStoreMigrationsBefore: MIGRATION,
});

const OWNER = "owner-case-writes";
const PROJECT = "project-case-writes";
const RUN = "run-case-writes-genesis";
const NONCE = "6a0a35a4-2222-4333-8444-955556666888";

const ADMITTED = "admitted";
const BASELINE_REFUSED =
	"app_change_fold_baselines insert requires an exact horizon or genesis marker";
const MARKER_REFUSED =
	"only an exact fold marker may carry an empty app-change batch";
const MARKER_NEEDS_BASELINE =
	"exact horizon and genesis markers require a fold baseline";

type Identity =
	| {
			readonly kind: "operator";
			readonly batch: string;
			readonly actor: string;
	  }
	| { readonly kind: "genesis" };

function operator(cutover: string, actorCutover = cutover): Identity {
	return {
		kind: "operator",
		batch: `fold-baseline:${cutover}`,
		actor: `system:${actorCutover}`,
	};
}

const EARLIER_IDENTITIES: readonly { name: string; identity: Identity }[] = [
	{
		name: "canonical-identity-foundation",
		identity: operator("canonical-identity-foundation"),
	},
	{ name: "genesis", identity: { kind: "genesis" } },
	{ name: "unified-authoring", identity: operator("unified-authoring") },
	{
		name: "hq-round-trip-emission",
		identity: operator("hq-round-trip-emission"),
	},
	{
		name: "hq-round-trip-expressions",
		identity: operator("hq-round-trip-expressions"),
	},
];

const CASE_WRITES = operator("hq-round-trip-case-writes");
const CASE_WRITES_OTHER_ACTOR = operator(
	"hq-round-trip-case-writes",
	"hq-round-trip-expressions",
);

class RolledBack extends Error {}

/**
 * Write one fold marker over a fresh app, with its baseline or without it,
 * and say what the database answered: `"admitted"` once the transaction
 * commits, or the message it raised. A probe without its baseline is rolled
 * back after `SET CONSTRAINTS ALL IMMEDIATE` runs the deferred marker check,
 * so no lone marker stays.
 */
async function probe(
	identity: Identity,
	options: { readonly baseline: boolean },
): Promise<string> {
	const genesis = identity.kind === "genesis";
	const appId = await h.seedApp({
		id: randomUUID(),
		owner: OWNER,
		project_id: PROJECT,
		...(genesis
			? { status: "generating", run_id: RUN, run_holder_nonce: NONCE }
			: {}),
	});
	try {
		await h.withTransaction(async (tx) => {
			await sql`SELECT 1 FROM apps WHERE id = ${appId} FOR UPDATE`.execute(tx);
			await sql`UPDATE apps SET mutation_seq = 1, app_name = 'After the horizon',
				app_name_lower = 'after the horizon' WHERE id = ${appId}`.execute(tx);
			await sql`UPDATE blueprint_entities SET data = data WHERE app_id = ${appId}`.execute(
				tx,
			);
			await sql`INSERT INTO app_changes
				(app_id, seq, batch_id, actor_id, run_id, kind, mutations,
				 from_project_id, to_project_id)
				VALUES (${appId}, 1,
					${genesis ? `genesis:${appId}` : identity.batch},
					${genesis ? OWNER : identity.actor},
					${genesis ? RUN : null},
					'fold-baseline', '[]'::jsonb, NULL, NULL)`.execute(tx);
			if (!options.baseline) {
				await sql`SET CONSTRAINTS ALL IMMEDIATE`.execute(tx);
				throw new RolledBack();
			}
			await sql`
				INSERT INTO app_change_fold_baselines
					(app_id, seq, project_id, snapshot, snapshot_digest)
				SELECT app.id, 1, app.project_id, current.snapshot,
					nova_app_change_fold_snapshot_digest(current.snapshot)
				FROM apps AS app,
					LATERAL (
						SELECT nova_current_app_change_fold_snapshot(app.id) AS snapshot
					) AS current
				WHERE app.id = ${appId}
			`.execute(tx);
		});
	} catch (error) {
		if (error instanceof RolledBack) return "rolled back";
		if (error instanceof Error) return error.message;
		throw error;
	}
	return ADMITTED;
}

async function verdicts(identities: readonly { identity: Identity }[]) {
	const out: string[] = [];
	for (const { identity } of identities) {
		out.push(await probe(identity, { baseline: true }));
	}
	return out;
}

async function functionState(
	db: Kysely<unknown>,
	signature: string,
): Promise<{ oid: number; definition: string }> {
	const rows = await sql<{ oid: string; definition: string }>`
		SELECT ${signature}::regprocedure::oid::int8 AS oid,
			pg_catalog.pg_get_functiondef(${signature}::regprocedure) AS definition
	`.execute(db);
	const [row] = rows.rows;
	return { oid: Number(row.oid), definition: row.definition };
}

async function triggerFunction(
	db: Kysely<unknown>,
	table: string,
	trigger: string,
): Promise<number> {
	const rows = await sql<{ oid: string }>`
		SELECT tgfoid::int8 AS oid
		FROM pg_catalog.pg_trigger
		WHERE tgrelid = ${table}::regclass AND tgname = ${trigger}
	`.execute(db);
	return Number(rows.rows[0].oid);
}

function raw(): Kysely<unknown> {
	return h.db() as unknown as Kysely<unknown>;
}

describe(MIGRATION, () => {
	it("admits the sixth identity, only under its own actor, and every earlier identity alike", async () => {
		// The prefix as it stands: the five identities admitted, the sixth not.
		expect(await verdicts(EARLIER_IDENTITIES)).toEqual(
			EARLIER_IDENTITIES.map(() => ADMITTED),
		);
		expect(await probe(CASE_WRITES, { baseline: true })).toBe(BASELINE_REFUSED);
		expect(await probe(CASE_WRITES, { baseline: false })).toBe(MARKER_REFUSED);

		await up(raw());

		expect(await probe(CASE_WRITES, { baseline: true })).toBe(ADMITTED);
		expect(await probe(CASE_WRITES, { baseline: false })).toBe(
			MARKER_NEEDS_BASELINE,
		);
		expect(await probe(CASE_WRITES_OTHER_ACTOR, { baseline: true })).toBe(
			BASELINE_REFUSED,
		);
		expect(await probe(CASE_WRITES_OTHER_ACTOR, { baseline: false })).toBe(
			MARKER_REFUSED,
		);
		expect(
			await probe(operator("hq-round-trip-case-write"), { baseline: true }),
		).toBe(BASELINE_REFUSED);
		expect(await verdicts(EARLIER_IDENTITIES)).toEqual(
			EARLIER_IDENTITIES.map(() => ADMITTED),
		);

		const baselines = await h
			.db()
			.selectFrom("app_change_fold_baselines as baseline")
			.innerJoin("app_changes as marker", (join) =>
				join
					.onRef("marker.app_id", "=", "baseline.app_id")
					.onRef("marker.seq", "=", "baseline.seq"),
			)
			.select(["marker.batch_id", "marker.actor_id"])
			.where("marker.batch_id", "=", "fold-baseline:hq-round-trip-case-writes")
			.execute();
		expect(baselines).toEqual([
			{
				batch_id: "fold-baseline:hq-round-trip-case-writes",
				actor_id: "system:hq-round-trip-case-writes",
			},
		]);
	});

	it("replaces both public functions in place, under the triggers that call them", async () => {
		const db = raw();
		const admitBefore = await functionState(db, ADMIT);
		const requireBefore = await functionState(db, REQUIRE);
		expect(
			await triggerFunction(
				db,
				"public.app_change_fold_baselines",
				"app_change_fold_baselines_admit_insert",
			),
		).toBe(admitBefore.oid);
		expect(
			await triggerFunction(
				db,
				"public.app_changes",
				"app_changes_fold_baseline_required",
			),
		).toBe(requireBefore.oid);
		expect(admitBefore.definition).not.toContain("hq-round-trip-case-writes");
		expect(requireBefore.definition).not.toContain("hq-round-trip-case-writes");

		await up(db);

		const admitAfter = await functionState(db, ADMIT);
		const requireAfter = await functionState(db, REQUIRE);
		expect(admitAfter.oid).toBe(admitBefore.oid);
		expect(requireAfter.oid).toBe(requireBefore.oid);
		expect(admitAfter.definition).toContain(
			"(marker.batch_id = 'fold-baseline:hq-round-trip-case-writes' AND marker.actor_id = 'system:hq-round-trip-case-writes')",
		);
		expect(requireAfter.definition).toContain(
			"(NEW.batch_id = 'fold-baseline:hq-round-trip-case-writes' AND NEW.actor_id = 'system:hq-round-trip-case-writes')",
		);
		// Only the one arm moved in each body.
		const arm = (definition: string, subject: string) =>
			definition.replace(
				`\n\t\t\t\t\t\t\tOR (${subject}.batch_id = 'fold-baseline:hq-round-trip-case-writes' AND ${subject}.actor_id = 'system:hq-round-trip-case-writes')`,
				"",
			);
		expect(arm(admitAfter.definition, "marker")).toBe(admitBefore.definition);
		expect(arm(requireAfter.definition, "NEW")).toBe(requireBefore.definition);
	});

	it("refuses to run down, since every app's fold starts from this horizon", async () => {
		await expect(down()).rejects.toThrow(
			"This migration is forward-only: the case-writes fold horizon is history every app now starts from.",
		);
	});
});
