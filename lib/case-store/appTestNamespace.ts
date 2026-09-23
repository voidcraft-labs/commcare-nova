import { sql, type Transaction } from "kysely";
import { PostgresCaseStore } from "./postgres/store";
import { HeuristicCaseGenerator } from "./sample/heuristic";
import type { Database } from "./sql/database";
import type { CaseStore } from "./store";

/** Every SQL relation reachable by the production case store must be isolated.
 * Adding a table to Database requires an explicit decision here as well. */
const isolatedTables = {
	apps: true,
	app_locations: true,
	cases: true,
	case_type_schemas: true,
	case_schema_index_deletions: true,
	case_indices: true,
	parked_case_values: true,
	lookup_rows: true,
	form_attachments: true,
	form_submission_intents: true,
} satisfies Record<keyof Database, true>;

export function appTestNamespace(testId: string): string {
	if (
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
			testId,
		)
	) {
		throw new Error("Invalid app test identity.");
	}
	return `nova_app_test_${testId.replaceAll("-", "").toLowerCase()}`;
}

export type AppTestCaseStore = Pick<
	CaseStore,
	| "traverse"
	| "query"
	| "count"
	| "queryGrouped"
	| "readDeviceCaseDatabase"
	| "insert"
	| "update"
	| "applySubmission"
>;

/** The caller holds live app + membership + test-session locks BEFORE entry.
 * No source authorization runs under this temporary search path. This narrow
 * context cannot perform schema DDL, sample-data reset or external capture IO.
 * All data operations join the caller's transaction, including its step receipt. */
export async function withAppTestNamespace<T>(
	tx: Transaction<Database>,
	args: {
		testId: string;
		appId: string;
		projectId: string;
		actorUserId: string;
		ownerId: string;
		blueprintSeq: number;
	},
	body: (store: AppTestCaseStore, tx: Transaction<Database>) => Promise<T>,
): Promise<T> {
	const namespace = appTestNamespace(args.testId);
	const previous = await sql<{
		path: string;
	}>`SELECT current_setting('search_path') AS path`.execute(tx);
	await sql`SELECT set_config('search_path', ${`${namespace}, public`}, true)`.execute(
		tx,
	);
	// Never let a missing clone fall through to a live public table. Checking
	// the complete relation set also refuses old test state after schema drift.
	const resolved = await sql<{ name: string; namespace: string | null }>`
		SELECT name, n.nspname AS namespace FROM unnest(${Object.keys(isolatedTables)}::text[]) AS name
		LEFT JOIN pg_class c ON c.oid = to_regclass(name)
		LEFT JOIN pg_namespace n ON n.oid = c.relnamespace
	`.execute(tx);
	if (resolved.rows.some((row) => row.namespace !== namespace)) {
		throw new Error("This app test is no longer available. Start a new test.");
	}
	// A deployment may migrate production while a disposable namespace lives.
	// Refuse a changed column contract rather than running the new store on an
	// old clone. Compare defaults too: changed lifecycle defaults affect results.
	const drift = await sql<{ name: string }>`
		WITH relations AS (
			SELECT name,
				to_regclass(format('%I.%I', ${namespace}::text, name)) AS clone,
				CASE WHEN name = 'cases' THEN coalesce(to_regclass('nova_case_runtime.cases'), to_regclass('public.cases'))
				ELSE to_regclass(format('public.%I', name)) END AS source
			FROM unnest(${Object.keys(isolatedTables)}::text[]) AS name
		), shapes AS (
			SELECT r.name, side.kind,
				jsonb_agg(jsonb_build_array(a.attname, a.atttypid, a.atttypmod,
					a.attnotnull, a.attidentity, a.attgenerated,
					pg_get_expr(d.adbin, d.adrelid)) ORDER BY a.attnum) AS shape
			FROM relations r CROSS JOIN LATERAL (VALUES ('clone', r.clone), ('source', r.source)) AS side(kind, relation)
			JOIN pg_attribute a ON a.attrelid = side.relation AND a.attnum > 0 AND NOT a.attisdropped
			LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
			GROUP BY r.name, side.kind
		)
		SELECT name FROM shapes GROUP BY name HAVING count(DISTINCT shape) <> 1 OR count(*) <> 2
	`.execute(tx);
	if (drift.rows.length)
		throw new Error("Nova's record storage changed. Start a new test.");
	const store = new PostgresCaseStore({
		db: tx,
		projectId: args.projectId,
		actorUserId: args.actorUserId,
		ownerId: args.ownerId,
		sampleGenerator: new HeuristicCaseGenerator(),
		authorizeMutation: async (_tx, mutation) => {
			if (
				mutation.appId !== args.appId ||
				mutation.projectId !== args.projectId ||
				mutation.actorUserId !== args.actorUserId
			) {
				throw new Error(
					"The test operation belongs to a different app or actor.",
				);
			}
			return { appMutationSeq: args.blueprintSeq };
		},
	});
	// On error the caller must abort the transaction, restoring SET LOCAL too.
	// Do not issue a cleanup query into an aborted PostgreSQL transaction.
	const result = await body(store, tx);
	await sql`SELECT set_config('search_path', ${previous.rows[0].path}, true)`.execute(
		tx,
	);
	return result;
}
