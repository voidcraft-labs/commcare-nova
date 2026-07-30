/**
 * WRITER — replace legacy name-backed Search-input references in raw module
 * entity JSON with the definition's immutable UUID.
 *
 * Dry-run by default. The final Blueprint parser has no compatibility arm, so
 * this writer intentionally operates below it. Each app is locked, every name
 * must resolve to exactly one same-module definition, accepted mutation
 * history must already be clean, and the write advances the app sequence with
 * attributed canonical mutations in a migration batch. Run the read-only scan
 * before and after; the post-scan must be zero.
 */

import "dotenv/config";
import { Command } from "commander";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { getAppDb, notifyAppStream } from "@/lib/db/pg";
import { runMain } from "./lib/main";
import {
	findLegacySearchInputRefs,
	planModuleSearchInputIdentityMigration,
} from "./lib/searchInputIdentity";

interface MigrateOptions {
	app?: string;
	execute?: boolean;
}

const program = new Command();
program
	.name("migrate-search-input-identity")
	.description(
		"Convert legacy name-backed Search-input AST leaves to UUIDs. Dry-run by default; --execute writes.",
	)
	.option("--app <appId>", "scope the migration to one app")
	.option("--execute", "write the migration (default: report only)")
	.addHelpText(
		"after",
		"\nDatabase:\n" +
			"  Uses NOVA_DB_LOCAL_URL or the Cloud SQL connector environment.\n" +
			"  There is intentionally no --prod writer shortcut.\n" +
			"\nExamples:\n" +
			"  $ npx tsx scripts/migrate-search-input-identity.ts\n" +
			"  $ npx tsx scripts/migrate-search-input-identity.ts --execute\n" +
			"  $ npx tsx scripts/migrate-search-input-identity.ts --app <appId> --execute\n",
	);
program.parse();
const opts = program.opts<MigrateOptions>();

async function main(): Promise<void> {
	const db = await getAppDb();
	try {
		let appsQuery = db
			.selectFrom("apps")
			.select(["id", "app_name"])
			.orderBy("id");
		if (opts.app !== undefined)
			appsQuery = appsQuery.where("id", "=", opts.app);
		const apps = await appsQuery.execute();
		let plannedRefs = 0;
		let migratedApps = 0;

		for (const app of apps) {
			const result = await db.transaction().execute(async (tx) => {
				const locked = await tx
					.selectFrom("apps")
					.select(["id", "mutation_seq"])
					.where("id", "=", app.id)
					.forUpdate()
					.executeTakeFirst();
				if (locked === undefined) return { refs: 0, wrote: false };
				const modules = await tx
					.selectFrom("blueprint_entities")
					.select(["uuid", "data"])
					.where("app_id", "=", app.id)
					.where("kind", "=", "module")
					.orderBy("uuid")
					.execute();
				const events = await tx
					.selectFrom("accepted_mutations")
					.select(["seq", "mutations"])
					.where("app_id", "=", app.id)
					.orderBy("seq")
					.execute();
				for (const event of events) {
					const legacy = findLegacySearchInputRefs(event.mutations);
					if (legacy.length > 0) {
						throw new Error(
							`${app.id}: accepted_mutations seq ${event.seq} contains ${legacy.length} legacy Search-input reference(s); refusing a partial-history migration`,
						);
					}
				}

				const plans = modules.map((row) => ({
					row,
					result: planModuleSearchInputIdentityMigration(row.data),
				}));
				const unresolved = plans.flatMap((plan) => plan.result.issues);
				if (unresolved.length > 0) {
					throw new Error(
						`${app.id}: ${unresolved.length} Search-input reference(s) do not resolve uniquely; run the read-only scan for paths`,
					);
				}
				const refs = plans.reduce(
					(sum, plan) => sum + plan.result.converted.length,
					0,
				);
				if (refs === 0 || opts.execute !== true) {
					return { refs, wrote: false };
				}

				for (const plan of plans) {
					if (plan.result.converted.length === 0) continue;
					const updated = await tx
						.updateTable("blueprint_entities")
						.set({ data: JSON.stringify(plan.result.record) })
						.where("app_id", "=", app.id)
						.where("uuid", "=", plan.row.uuid)
						.executeTakeFirst();
					if (Number(updated.numUpdatedRows) !== 1) {
						throw new Error(
							`${app.id}: expected to update exactly one module row ${plan.row.uuid}, updated ${updated.numUpdatedRows}`,
						);
					}
				}
				const mutations = plans.flatMap((plan) => plan.result.mutations);
				const seq = Number(locked.mutation_seq) + 1;
				const appUpdate = await tx
					.updateTable("apps")
					.set({ mutation_seq: seq, updated_at: new Date() })
					.where("id", "=", app.id)
					.where("mutation_seq", "=", locked.mutation_seq)
					.executeTakeFirst();
				if (Number(appUpdate.numUpdatedRows) !== 1) {
					throw new Error(
						`${app.id}: expected to advance exactly one app row from sequence ${locked.mutation_seq}, updated ${appUpdate.numUpdatedRows}`,
					);
				}
				await tx
					.insertInto("accepted_mutations")
					.values({
						app_id: app.id,
						seq,
						batch_id: `search-input-identity-v1:${app.id}`,
						run_id: null,
						actor_id: "system:search-input-identity-migration",
						kind: "migration",
						mutations: JSON.stringify(mutations),
					})
					.execute();
				await notifyAppStream(tx, app.id, seq);
				return { refs, wrote: true };
			});
			if (result.refs === 0) continue;
			plannedRefs += result.refs;
			if (result.wrote) migratedApps++;
			console.log(
				`${result.wrote ? "MIGRATED" : "WOULD MIGRATE"} ${app.id} (${app.app_name || "unnamed"}): ${result.refs} reference(s)`,
			);
		}

		console.log(
			opts.execute === true
				? `\nMigrated ${plannedRefs} reference(s) across ${migratedApps} app(s).`
				: `\nDRY RUN — would migrate ${plannedRefs} reference(s). Nothing writes without --execute.`,
		);
		if (opts.execute === true) {
			console.log(
				"Re-run scan-search-input-identity.ts in the same environment to record the zero-reference post-check.",
			);
		}
	} finally {
		await closeCaseStoreDatabase();
	}
}

runMain(main);
