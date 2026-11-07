import { createHash } from "node:crypto";
import { type Kysely, sql } from "kysely";
import { beforeEach, describe, expect, it } from "vitest";
import type { CaseType } from "@/lib/domain";
import { gt, literal, prop } from "@/lib/domain/expression/builders";
import { proseText } from "@/lib/domain/prose";
import {
	retireCaseExpressionIndexes,
	scanCaseExpressionIndexes,
} from "../../../../scripts/lib/retireCaseExpressionIndexes";
import { HeuristicCaseGenerator } from "../../sample/heuristic";
import { setupPerTestDatabase } from "../../sql/__tests__/perTestDatabase";
import { compilePredicate } from "../../sql/compilePredicate";
import type { Database } from "../../sql/database";
import { PostgresCaseStore } from "../store";

const database = setupPerTestDatabase({
	schema: "migrated",
	databaseNamePrefix: "fixed_case_indexes_",
});
const app = "fixed-app",
	project = "fixed-project";
function db() {
	return database.db as Kysely<Database>;
}
function store() {
	return new PostgresCaseStore({
		db: db(),
		projectId: project,
		actorUserId: "actor",
		ownerId: "actor",
		sampleGenerator: new HeuristicCaseGenerator(),
	});
}
async function indexes() {
	return (
		await sql<{
			name: string;
		}>`SELECT c.relname AS name FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE i.indrelid='cases'::regclass ORDER BY c.relname`.execute(
			db(),
		)
	).rows.map((r) => r.name);
}
beforeEach(async () => {
	await sql`INSERT INTO apps(id,owner,project_id,app_name,app_name_lower) VALUES (${app},'actor',${project},'Fixed','fixed'),('other-app','actor','other-project','Other','other')`.execute(
		db(),
	);
});
describe("fixed fleet-wide case indexes", () => {
	it("keeps index count constant as schema grows and bounds compiled predicates to the app scope", async () => {
		const before = await indexes();
		const types: CaseType[] = Array.from({ length: 25 }, (_, i) => ({
			name: `type_${i}`,
			properties: Array.from({ length: 100 }, (_, j) => ({
				name: `p_${j}`,
				label: proseText(`Property ${j}`),
				data_type: "int" as const,
			})),
		}));
		const schemas = new Map(types.map((t) => [t.name, t]));
		for (const type of types)
			await store().applySchemaChange({
				appId: app,
				caseType: type.name,
				caseTypeSchemas: schemas,
				syncedSeq: 1,
			});
		expect(await indexes()).toEqual(before);
		expect(before).toEqual([
			"cases_app_type_idx",
			"cases_pkey",
			"cases_project_app_type_idx",
		]);
		await sql`INSERT INTO cases(case_id,app_id,project_id,owner_id,case_type,case_name,properties) SELECT 'other-'||n,'other-app','other-project','actor','type_0','Other',jsonb_build_object('p_0',n) FROM generate_series(1,20000) n`.execute(
			db(),
		);
		await store().insert({
			appId: app,
			row: {
				case_id: "target",
				case_type: "type_0",
				case_name: "Target",
				properties: { p_0: 75 },
			},
		});
		await sql`ANALYZE cases`.execute(db());
		const predicate = gt(prop("type_0", "p_0"), literal(50));
		const query = db()
			.selectFrom("cases as c")
			.select("c.case_id")
			.where("c.project_id", "=", project)
			.where("c.app_id", "=", app)
			.where("c.case_type", "=", "type_0")
			.where(
				compilePredicate(predicate, {
					reading: "search",
					db: db(),
					appId: app,
					projectId: project,
					anchorAlias: "c",
					currentCaseType: "type_0",
					caseTypeSchemas: schemas,
					bindings: {},
				}),
			);
		expect(await query.execute()).toEqual([{ case_id: "target" }]);
		const compiled = query.compile();
		const plan = await database.pool.query(
			`EXPLAIN (ANALYZE,FORMAT JSON) ${compiled.sql}`,
			[...compiled.parameters],
		);
		const rendered = JSON.stringify(plan.rows);
		expect(rendered).toMatch(/cases_(project_app_type|app_type)_idx/);
		expect(rendered).toContain('"Actual Rows":1');
	});
	it("retires exact historical indexes and refuses a changed inventory without dropping anything", async () => {
		const tag = (s: string) =>
			createHash("sha256").update(s).digest("hex").slice(0, 12);
		const name = `cases_${tag(`${app} type_0`)}_${tag("old_property")}_int`;
		await sql`CREATE INDEX ${sql.id(name)} ON cases (((properties->>'old_property')::integer)) WHERE app_id=${sql.lit(app)} AND case_type='type_0'`.execute(
			db(),
		);
		const prefix = `cases_${tag(`${app} type_0`)}_${tag("old_property")}`;
		await sql`CREATE INDEX ${sql.id(`${prefix}_fuzzy`)} ON cases USING gin ((properties->>'old_property') gin_trgm_ops) WHERE app_id=${sql.lit(app)} AND case_type='type_0'`.execute(
			db(),
		);
		await sql`CREATE INDEX ${sql.id(`${prefix}_num`)} ON cases (((properties->>'old_property')::numeric)) WHERE app_id=${sql.lit(app)} AND case_type='type_0'`.execute(
			db(),
		);
		await sql`CREATE INDEX ${sql.id(`${prefix}_contains`)} ON cases USING gin ((properties->'old_property') jsonb_ops) WHERE app_id=${sql.lit(app)} AND case_type='type_0'`.execute(
			db(),
		);
		const scan = await scanCaseExpressionIndexes(db());
		expect(scan.blockers).toEqual([]);
		expect(scan.indexes.map((i) => i.name)).toEqual([
			`${prefix}_contains`,
			`${prefix}_fuzzy`,
			name,
			`${prefix}_num`,
		]);
		await expect(
			retireCaseExpressionIndexes(db(), "0".repeat(64)),
		).rejects.toThrow("inventory changed");
		expect(await indexes()).toContain(name);
		expect(await retireCaseExpressionIndexes(db(), scan.digest)).toBe(4);
		expect((await scanCaseExpressionIndexes(db())).indexes).toEqual([]);
		await sql`CREATE INDEX ${sql.id(name)} ON cases (((properties->>'different')::integer)) WHERE app_id=${sql.lit(app)} AND case_type='type_0'`.execute(
			db(),
		);
		const changed = await scanCaseExpressionIndexes(db());
		expect(changed.blockers).toHaveLength(1);
		await expect(
			retireCaseExpressionIndexes(db(), changed.digest),
		).rejects.toThrow("Unproven historical index");
		expect(await indexes()).toContain(name);
	});
});
