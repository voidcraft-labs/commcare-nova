import { sql } from "kysely";
import { Migrator } from "kysely/migration";
import { expect, it } from "vitest";
import { setupPerTestDatabase } from "@/lib/case-store/sql/__tests__/perTestDatabase";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import { up } from "../20260911020000_retire_design_continuation_receipts";
import { caseStoreMigrationProvider } from "../index";

const h = setupPerTestDatabase({
	databaseNamePrefix: "retire_design_receipts_",
	establishLocalMigrationAuthority: true,
	prepareTemplate: async (db) => {
		const result = await new Migrator({
			db,
			provider: caseStoreMigrationProvider,
		}).migrateTo("20260911010000_design_turn_steps");
		if (result.error) throw result.error;
	},
});
async function seed(kind: "design" | "executor", turn: string | null) {
	const sessionId = crypto.randomUUID(),
		contextId = crypto.randomUUID();
	const eventDigest = canonicalJsonDigest({
		stepKey: "step",
		eventKind: "started",
		requestDigest: "a".repeat(64),
	});
	const provenanceDigest =
		turn === null
			? null
			: canonicalJsonDigest({
					contextId,
					stepKey: "step",
					turnProvenanceId: turn,
					eventDigest,
				});
	await sql`INSERT INTO design_sessions(id,mode,project_id,owner_user_id,proposed_app_id,state,continuation_recovery) VALUES (${sessionId}::uuid,'build','project','owner','proposed','active','{"migration":"completed"}'::jsonb)`.execute(
		h.db,
	);
	await sql`INSERT INTO design_model_contexts(id,design_session_id,context_kind,generation,model_id,prompt_version,toolset_digest,context_version) VALUES (${contextId}::uuid,${sessionId}::uuid,${kind},0,'model','prompt',${"a".repeat(64)},'context')`.execute(
		h.db,
	);
	await sql`INSERT INTO design_model_steps(context_id,step_key,event_kind,event_digest,request_digest,created_by_run_id,turn_provenance_id,turn_provenance_digest) VALUES (${contextId}::uuid,'step','started',${eventDigest},${"a".repeat(64)},'run',${turn},${provenanceDigest})`.execute(
		h.db,
	);
	await sql`INSERT INTO design_model_steps(context_id,step_key,event_kind,event_digest,response_digest,usage,created_by_run_id) VALUES (${contextId}::uuid,'step','completed',${"b".repeat(64)},${"c".repeat(64)},'{"totalTokens":12}'::jsonb,'run')`.execute(
		h.db,
	);
}
async function hasReceipt() {
	return (
		(
			await sql`SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='design_sessions' AND column_name='continuation_recovery'`.execute(
				h.db,
			)
		).rows.length > 0
	);
}
it("removes only temporary receipts after conversion and retains design and executor accounting", async () => {
	await seed("design", "user-turn");
	await seed("executor", null);
	const before = (
		await sql`SELECT * FROM design_model_steps ORDER BY context_id,event_kind`.execute(
			h.db,
		)
	).rows;
	expect(await hasReceipt()).toBe(true);
	await h.db.transaction().execute((tx) => up(tx));
	expect(await hasReceipt()).toBe(false);
	expect(
		(
			await sql`SELECT * FROM design_model_steps ORDER BY context_id,event_kind`.execute(
				h.db,
			)
		).rows,
	).toEqual(before);
});
it("refuses retirement while a historical design start lacks provenance", async () => {
	await seed("design", null);
	const before = (
		await sql`SELECT * FROM design_model_steps ORDER BY event_kind`.execute(
			h.db,
		)
	).rows;
	await expect(h.db.transaction().execute((tx) => up(tx))).rejects.toThrow(
		"Design turn provenance must be complete",
	);
	expect(await hasReceipt()).toBe(true);
	expect(
		(
			await sql`SELECT * FROM design_model_steps ORDER BY event_kind`.execute(
				h.db,
			)
		).rows,
	).toEqual(before);
});
