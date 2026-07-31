/**
 * Read-only: why does the canonical-identity cutover refuse an app?
 *
 * `scan-canonical-identity-foundation` is deliberately content-free — it
 * reports a `findingsDigest` and nothing else, so a blocked app is a hash. This
 * prints the findings themselves, which is what an operator needs to decide
 * whether a blocker is repairable data or a defect in the plan.
 *
 * Writes nothing. Run before the cutover, delete after it.
 */
import { Command } from "commander";
import { sql } from "kysely";
import { planCanonicalAppMigration } from "@/lib/case-store/migrations/20260728000000_canonical_identity_foundation/frozenTransform";
import { getAppDb } from "@/lib/db/pg";
import { targetProdDb } from "./lib/prodDb";

const program = new Command()
	.name("inspect-cutover-blockers")
	.description("Print the validator findings behind each blocked app")
	.option("--prod", "read production through the operator IAM connection")
	.parse();

if (program.opts().prod === true) targetProdDb();

interface AppTextRow {
	id: string;
	app_name: string;
	connect_type: string | null;
	case_types_text: string | null;
	logo: string | null;
	mutation_seq: string;
}

interface EntityTextRow {
	app_id: string;
	uuid: string;
	kind: string;
	parent_uuid: string | null;
	ordinal: number;
	data_text: string;
}

async function main(): Promise<void> {
	const db = await getAppDb();
	const apps = await sql<AppTextRow>`
		SELECT id, app_name, connect_type,
		       case_types::text AS case_types_text,
		       logo::text AS logo, mutation_seq
		FROM apps
		ORDER BY convert_to(id, 'UTF8')
	`.execute(db);
	const entities = await sql<EntityTextRow>`
		SELECT app_id, uuid::text AS uuid, kind,
		       parent_uuid::text AS parent_uuid, ordinal,
		       data::text AS data_text
		FROM blueprint_entities
		ORDER BY
			convert_to(app_id, 'UTF8'),
			convert_to(kind, 'UTF8'),
			convert_to(parent_uuid::text, 'UTF8') NULLS FIRST,
			ordinal,
			convert_to(uuid::text, 'UTF8')
	`.execute(db);

	const byApp = new Map<string, EntityTextRow[]>();
	for (const row of entities.rows) {
		const list = byApp.get(row.app_id) ?? [];
		list.push(row);
		byApp.set(row.app_id, list);
	}

	const codeTotals = new Map<string, number>();
	let blocked = 0;
	for (const app of apps.rows) {
		/* Exactly the shape frozenScanner builds (`frozenScanner.ts:1530`):
		 * camelCase `parentUuid`, and the owning `appId` on every row. Passing
		 * snake_case hides every parent link and reports the whole estate as
		 * `invalid-topology`. */
		const rows = (byApp.get(app.id) ?? []).map((row) => ({
			appId: row.app_id,
			uuid: row.uuid,
			kind: row.kind,
			parentUuid: row.parent_uuid,
			ordinal: row.ordinal,
			data: JSON.parse(row.data_text) as unknown,
		}));
		let plan: { findings: readonly unknown[] };
		try {
			plan = planCanonicalAppMigration({
				appId: app.id,
				appName: app.app_name,
				connectType: app.connect_type,
				caseTypes:
					app.case_types_text === null
						? null
						: (JSON.parse(app.case_types_text) as unknown),
				logo: app.logo,
				mutationSeq: app.mutation_seq,
				rows,
				// biome-ignore lint/suspicious/noExplicitAny: frozen snapshot shape
			} as any);
		} catch (error) {
			blocked += 1;
			console.log(`\n=== ${app.id} — planner threw ===`);
			console.log(`  name: ${JSON.stringify(app.app_name)}`);
			console.log(`  ${String(error)}`);
			continue;
		}
		if (plan.findings.length === 0) continue;
		blocked += 1;
		console.log(`\n=== ${app.id} — ${plan.findings.length} finding(s) ===`);
		console.log(`  name: ${JSON.stringify(app.app_name)}`);
		for (const finding of plan.findings) {
			const text = JSON.stringify(finding);
			const code =
				(finding as { code?: string } | null)?.code ?? "(no code field)";
			codeTotals.set(code, (codeTotals.get(code) ?? 0) + 1);
			console.log(`  - ${text.slice(0, 400)}`);
		}
	}

	console.log(`\n──────── ${blocked} blocked of ${apps.rows.length} apps`);
	for (const [code, count] of [...codeTotals].sort((a, b) => b[1] - a[1])) {
		console.log(`  ${count.toString().padStart(4)}  ${code}`);
	}
}

void main();
