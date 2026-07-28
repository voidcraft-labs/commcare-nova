/** Dry-run the sequence migration over PRODUCTION rows and report disagreements. */
import { migrateNested } from "@/lib/case-store/migrations/20260727120000_sequence_is_array_position";
import { targetProdDb } from "./lib/prodDb";

async function main() {
	targetProdDb();
	const { getCaseStorePool } = await import(
		"@/lib/case-store/postgres/connection"
	);
	const pool = await getCaseStorePool();
	{
		const { rows } = await pool.query(
			"SELECT app_id, kind, uuid, data FROM blueprint_entities",
		);
		let repaired = 0;
		let problems = 0;
		for (const raw of rows as unknown as {
			app_id: string;
			kind: string;
			uuid: string;
			data: Record<string, unknown>;
		}[]) {
			if (migrateNested(raw.kind, raw.data)) repaired++;
			const config = raw.data.caseListConfig as
				| {
						columns?: { uuid: string }[];
						listColumnOrder?: string[];
						detailColumnOrder?: string[];
				  }
				| undefined;
			if (config === undefined) continue;
			const set = new Set((config.columns ?? []).map((c) => c.uuid));
			for (const [name, seq] of [
				["listColumnOrder", config.listColumnOrder],
				["detailColumnOrder", config.detailColumnOrder],
			] as const) {
				if (
					seq === undefined ||
					seq.length !== set.size ||
					seq.some((u) => !set.has(u))
				) {
					console.log(
						`${name} wrong on module ${raw.uuid} (app ${raw.app_id})`,
					);
					problems++;
				}
			}
		}
		console.log(
			`prod rows=${rows.length} migrated=${repaired} problems=${problems}`,
		);
	}
	await pool.end();
}
void main();
