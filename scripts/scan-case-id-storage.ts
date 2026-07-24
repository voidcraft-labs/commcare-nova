/**
 * READ-ONLY — report the storage state of the case-identity column family.
 *
 * The five columns are `cases.case_id`, `cases.parent_case_id`,
 * `case_indices.case_id`, `case_indices.ancestor_id`, and
 * `parked_case_values.case_id`. Run before the
 * `20260724030000_opaque_case_ids` widening to record the pre-migration
 * population, and again after it: the rescan must report every column as
 * `text`, the `uuidv7()::text` default, the intact `parked_case_values`
 * FK, and the non-UUID-shaped value census (zero until authored ids
 * exist). A mixed uuid/text family exits non-zero. `--prod` uses the
 * repository's read-only production inspection connection.
 */

import "dotenv/config";
import { Command } from "commander";
import { sql } from "kysely";
import {
	closeCaseStoreDatabase,
	getCaseStoreDatabase,
} from "../lib/case-store/postgres/connection";
import { runMain } from "./lib/main";
import { targetProdDb } from "./lib/prodDb";

interface ScanOptions {
	prod?: boolean;
}

const program = new Command();
program
	.name("scan-case-id-storage")
	.description(
		"Report the case-identity column family's storage state (read-only). Run before and after the opaque_case_ids widening migration.",
	)
	.option(
		"--prod",
		"scan production Cloud SQL through your read-only gcloud IAM identity",
	)
	.addHelpText(
		"after",
		"\nDatabase:\n" +
			"  Scans NOVA_DB_LOCAL_URL by default. --prod targets production via\n" +
			"  scripts/lib/prodDb.ts; it grants no write permissions.\n" +
			"\nExamples:\n" +
			"  $ npx tsx scripts/scan-case-id-storage.ts\n" +
			"  $ npx tsx scripts/scan-case-id-storage.ts --prod\n",
	);
program.parse();
const opts = program.opts<ScanOptions>();
if (opts.prod === true) targetProdDb();

const UUID_SHAPE =
	"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";

interface ColumnState {
	table: string;
	column: string;
	type: string;
	rows: number;
	nonUuidValues: number | null;
}

async function main(): Promise<void> {
	const db = await getCaseStoreDatabase();
	try {
		const schemaRow = await sql<{ cases_schema: string | null }>`
			SELECT n.nspname AS cases_schema
			  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
			 WHERE c.oid = COALESCE(
				to_regclass('nova_case_runtime.cases'),
				to_regclass('public.cases')
			 )
		`.execute(db);
		const casesSchema = schemaRow.rows[0]?.cases_schema;
		if (casesSchema === undefined || casesSchema === null) {
			throw new Error(
				"cases table not found in nova_case_runtime or public — is this database migrated?",
			);
		}

		const family: ReadonlyArray<{
			schema: string;
			table: string;
			column: string;
		}> = [
			{ schema: casesSchema, table: "cases", column: "case_id" },
			{ schema: casesSchema, table: "cases", column: "parent_case_id" },
			{ schema: "public", table: "case_indices", column: "case_id" },
			{ schema: "public", table: "case_indices", column: "ancestor_id" },
			{ schema: "public", table: "parked_case_values", column: "case_id" },
		];

		console.log(
			`Scanning the case-identity column family (read-only); cases schema is "${casesSchema}"…\n`,
		);

		const states: ColumnState[] = [];
		for (const { schema, table, column } of family) {
			const typeRow = await sql<{ type: string }>`
				SELECT format_type(atttypid, atttypmod) AS type FROM pg_attribute
				 WHERE attrelid = format('%I.%I', ${schema}::text, ${table}::text)::regclass
				   AND attname = ${column}::name
			`.execute(db);
			const type = typeRow.rows[0]?.type ?? "<missing>";
			const countRow = await sql<{ rows: string }>`
				SELECT count(*) AS rows FROM ${sql.table(`${schema}.${table}`)}
			`.execute(db);
			let nonUuidValues: number | null = null;
			if (type === "text") {
				const censusRow = await sql<{ non_uuid: string }>`
					SELECT count(*) AS non_uuid FROM ${sql.table(`${schema}.${table}`)}
					 WHERE ${sql.ref(column)} IS NOT NULL
					   AND ${sql.ref(column)} !~* ${UUID_SHAPE}
				`.execute(db);
				nonUuidValues = Number(censusRow.rows[0]?.non_uuid ?? 0);
			}
			const state: ColumnState = {
				table: `${schema}.${table}`,
				column,
				type,
				rows: Number(countRow.rows[0]?.rows ?? 0),
				nonUuidValues,
			};
			states.push(state);
			const census =
				state.nonUuidValues === null
					? ""
					: `, ${state.nonUuidValues} non-UUID-shaped value(s)`;
			console.log(
				`${state.table}.${state.column}: ${state.type}, ${state.rows} row(s)${census}`,
			);
		}

		const defaultRow = await sql<{ def: string | null }>`
			SELECT pg_get_expr(d.adbin, d.adrelid) AS def
			  FROM pg_attrdef d
			  JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
			 WHERE d.adrelid = format('%I.cases', ${casesSchema}::text)::regclass
			   AND a.attname = 'case_id'
		`.execute(db);
		const caseIdDefault = defaultRow.rows[0]?.def ?? "<none>";
		console.log(`\ncases.case_id default: ${caseIdDefault}`);

		const fkRow = await sql<{ def: string }>`
			SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
			 WHERE conname = 'parked_case_values_case_id_fkey'
			   AND conrelid = 'public.parked_case_values'::regclass
		`.execute(db);
		const fk = fkRow.rows[0]?.def ?? "<missing>";
		console.log(`parked_case_values FK: ${fk}`);

		const types = new Set(states.map((s) => s.type));
		const allUuid = types.size === 1 && types.has("uuid");
		const allText = types.size === 1 && types.has("text");
		if (allUuid) {
			console.log(
				"\nPre-migration state: the whole family is `uuid`. Ready for the opaque_case_ids widening.",
			);
			return;
		}
		if (allText) {
			const defaultOk = caseIdDefault.includes("uuidv7()");
			const fkOk = fk.includes("case_id");
			if (defaultOk && fkOk) {
				console.log(
					"\nPost-migration state: the whole family is `text` with the generated-id default and the FK intact. Rescan clean.",
				);
				return;
			}
			console.log(
				"\nWidened, but the default or FK is not in its expected end state — inspect before proceeding.",
			);
			process.exitCode = 1;
			return;
		}
		console.log(
			"\nMIXED family — some columns widened, some not. The migration did not complete; inspect before proceeding.",
		);
		process.exitCode = 1;
	} finally {
		await closeCaseStoreDatabase();
	}
}

runMain(main);
