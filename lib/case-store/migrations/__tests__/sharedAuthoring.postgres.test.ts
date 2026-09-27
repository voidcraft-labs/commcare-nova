import { sql } from "kysely";
import { Migrator } from "kysely/migration";
import { expect, it } from "vitest";
import { setupPerTestDatabase } from "../../sql/__tests__/perTestDatabase";
import { caseStoreMigrations } from "..";

const migration = "20260927000000_shared_authoring";
const database = setupPerTestDatabase({
	databaseNamePrefix: "shared_authoring_upgrade_",
	establishLocalMigrationAuthority: true,
	prepareTemplate: async (db) => {
		const result = await new Migrator({
			db,
			provider: {
				getMigrations: async () =>
					Object.fromEntries(
						Object.entries(caseStoreMigrations).filter(
							([name]) => name < migration,
						),
					),
			},
		}).migrateToLatest();
		if (result.error) throw result.error;
	},
});

it("preserves reviewed private history while admitting only one authority kind for new work", async () => {
	const db = database.db;
	const designId = crypto.randomUUID();
	const candidateId = crypto.randomUUID();
	const digest = "a".repeat(64);
	await sql`INSERT INTO design_sessions(id,proposed_app_id,owner_user_id,project_id,state,mode)
  VALUES (${designId}::uuid,'proposed','owner','project','active','build')`.execute(
		db,
	);
	await sql`INSERT INTO authoring_plans(session_id,revision) VALUES (${designId}::uuid,1)`.execute(
		db,
	);
	await sql`INSERT INTO authoring_plan_revisions(session_id,revision,markdown,editor,run_id,request_id,request_digest)
  VALUES (${designId}::uuid,1,'Collect visits.','architect','old-run','plan',${digest})`.execute(
		db,
	);
	await sql`INSERT INTO authoring_workspaces(id,design_session_id,plan_revision,kind,proposed_app_id,base_project_id,base_snapshot_digest,owner_user_id,owner_run_id,status,exclusive_kind)
  VALUES (${candidateId}::uuid,${designId}::uuid,1,'genesis','proposed','project',${digest},'owner','old-run','open','retireCaseType')`.execute(
		db,
	);
	const receipt = JSON.stringify({
		requestId: "old-noop",
		disposition: "noop",
		workspaceRevision: 0,
		replayResult: {
			kind: "mutate",
			mutations: [],
			result: { ok: true, moduleUuid: "old-identity" },
		},
	});
	await sql`INSERT INTO authoring_requests(change_set_id,request_id,tool_name,input_digest,expected_revision,resulting_revision,status,receipt)
  VALUES (${candidateId}::uuid,'old-noop','createModule',${digest},0,0,'noop',${receipt}::jsonb)`.execute(
		db,
	);
	const before =
		await sql`SELECT * FROM authoring_requests WHERE change_set_id=${candidateId}::uuid`.execute(
			db,
		);
	const result = await new Migrator({
		db,
		provider: { getMigrations: async () => caseStoreMigrations },
	}).migrateToLatest();
	if (result.error) throw result.error;
	expect(
		(
			await sql`SELECT * FROM authoring_requests WHERE change_set_id=${candidateId}::uuid`.execute(
				db,
			)
		).rows,
	).toEqual(before.rows);
	expect(
		(
			await sql`SELECT design_session_id,authoring_session_id,plan_revision,status,exclusive_kind FROM authoring_workspaces WHERE id=${candidateId}::uuid`.execute(
				db,
			)
		).rows,
	).toEqual([
		{
			design_session_id: designId,
			authoring_session_id: null,
			plan_revision: "1",
			status: "open",
			exclusive_kind: "retireCaseType",
		},
	]);
	const ordinaryId = crypto.randomUUID();
	await sql`INSERT INTO authoring_sessions(id,actor_user_id,project_id,origin,proposed_app_id,app_name,begin_request_id,begin_input_digest)
  VALUES (${ordinaryId}::uuid,'owner','project','mcp','ordinary-proposed','Visits','begin',${digest})`.execute(
		db,
	);
	// Neither a missing authority nor combining ordinary ownership with reviewed
	// lineage can weaken the existing reviewed-plan foreign key.
	await expect(
		sql`UPDATE authoring_workspaces SET authoring_session_id=${ordinaryId}::uuid WHERE id=${candidateId}::uuid`.execute(
			db,
		),
	).rejects.toThrow();
	await expect(
		sql`UPDATE authoring_workspaces SET design_session_id=NULL,plan_revision=NULL,owner_run_id=NULL WHERE id=${candidateId}::uuid`.execute(
			db,
		),
	).rejects.toThrow();
	await sql`INSERT INTO authoring_session_requests(ordinary_session_id,request_id,operation,input_digest) VALUES (${ordinaryId}::uuid,'retry','save',${digest})`.execute(
		db,
	);
	await sql`INSERT INTO authoring_session_requests(design_session_id,request_id,operation,input_digest) VALUES (${designId}::uuid,'retry','save',${digest})`.execute(
		db,
	);
	await expect(
		sql`INSERT INTO authoring_session_requests(ordinary_session_id,request_id,operation,input_digest) VALUES (${ordinaryId}::uuid,'retry','discard',${digest})`.execute(
			db,
		),
	).rejects.toThrow();
});
