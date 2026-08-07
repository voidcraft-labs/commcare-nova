/**
 * READ-ONLY — report every divergence between the stored media reference
 * projections and the split-projection shapes the design-session cutover
 * derives today:
 *
 *  - `media_asset_refs` rows the app's authored Blueprint does not carry
 *    (thread-contributed edges an OLD-revision writer re-added during the
 *    deploy window), and Blueprint references missing their edge;
 *  - `thread_media_refs` rows the thread's transcript does not carry, and
 *    transcript attachments missing their row (a thread an old writer
 *    updated after the migration's backfill ran).
 *
 * The 20260809000000 migration performs this same convergence in the migrate
 * Job; this scan sizes what the deploy window skewed after the old revision
 * drained, and `migrate-media-ref-projection-split.ts` converges it. Run this
 * before the migrate, and again after (the re-scan must report zero
 * divergence). `--prod` targets the production instance over its public IP
 * (see `./lib/prodDb.ts`). Run with `--help` for flags.
 */

import "dotenv/config";
import { Command } from "commander";
import { sql } from "kysely";
import { closeCaseStoreDatabase } from "../lib/case-store/postgres/connection";
import { collectThreadAttachmentAssetIds } from "../lib/chat/threadAttachments";
import { blueprintMediaRequirements } from "../lib/db/canonicalCommitKernel";
import {
	assemblePersistedBlueprintJsonText,
	type PersistedBlueprintRootText,
	type PersistedEntityRowText,
} from "../lib/db/persistedJson";
import { getAppDb } from "../lib/db/pg";
import { hydratePersistedBlueprint } from "../lib/doc/fieldParent";
import { targetProdDb } from "./lib/prodDb";

interface Divergence {
	readonly scope: string;
	readonly detail: string;
}

async function main(): Promise<void> {
	const program = new Command()
		.description(
			"Report media_asset_refs / thread_media_refs rows that diverge from the split projections.",
		)
		.option(
			"--prod",
			"scan the production Cloud SQL instance (public IP + your gcloud IAM identity)",
		)
		.parse();
	if (program.opts().prod === true) targetProdDb();

	const db = await getAppDb();
	const divergences: Divergence[] = [];

	const apps = await db
		.selectFrom("apps")
		.select(["id", "project_id", "app_name", "connect_type", "logo"])
		.select(sql<string | null>`case_types::text`.as("case_types_text"))
		.execute();
	for (const app of apps) {
		const entities = await db
			.selectFrom("blueprint_entities")
			.select(["uuid", "kind", "parent_uuid", "ordinal"])
			.select(sql<string>`data::text`.as("data_text"))
			.where("app_id", "=", app.id)
			.orderBy("uuid")
			.execute();
		const persisted = assemblePersistedBlueprintJsonText(
			app.id,
			{
				app_name: app.app_name,
				connect_type: app.connect_type,
				case_types_text: app.case_types_text,
				logo: app.logo,
			} as PersistedBlueprintRootText,
			entities as unknown as PersistedEntityRowText[],
		);
		const doc = hydratePersistedBlueprint(persisted);
		const expected = new Set(
			blueprintMediaRequirements(doc).map((ref) => String(ref.assetId)),
		);
		const stored = await db
			.selectFrom("media_asset_refs")
			.select(sql<string>`asset_id::text`.as("asset_id"))
			.where("app_id", "=", app.id)
			.execute();
		const storedSet = new Set(stored.map((row) => row.asset_id));
		for (const assetId of storedSet) {
			if (!expected.has(assetId)) {
				divergences.push({
					scope: `app ${app.id}`,
					detail: `edge ${assetId} has no Blueprint carrier (stale thread-contributed edge)`,
				});
			}
		}
		for (const assetId of expected) {
			if (!storedSet.has(assetId)) {
				divergences.push({
					scope: `app ${app.id}`,
					detail: `Blueprint reference ${assetId} has no media_asset_refs edge`,
				});
			}
		}
	}

	const threads = await db
		.selectFrom("threads")
		.select(["thread_id", "app_id", "design_session_id", "messages"])
		.execute();
	for (const thread of threads) {
		const expected = new Set(
			collectThreadAttachmentAssetIds(thread.messages).map(String),
		);
		const stored = await db
			.selectFrom("thread_media_refs")
			.select(sql<string>`asset_id::text`.as("asset_id"))
			.where("thread_id", "=", thread.thread_id)
			.execute();
		const storedSet = new Set(stored.map((row) => row.asset_id));
		for (const assetId of expected) {
			if (!storedSet.has(assetId)) {
				divergences.push({
					scope: `thread ${thread.thread_id}`,
					detail: `transcript attachment ${assetId} has no thread_media_refs row`,
				});
			}
		}
		for (const assetId of storedSet) {
			if (!expected.has(assetId)) {
				divergences.push({
					scope: `thread ${thread.thread_id}`,
					detail: `thread_media_refs row ${assetId} has no transcript carrier`,
				});
			}
		}
	}

	if (divergences.length === 0) {
		console.log(
			`Scanned ${apps.length} app(s) and ${threads.length} thread(s): both media reference projections are exact.`,
		);
	} else {
		console.log(
			`Found ${divergences.length} divergence(s) across ${apps.length} app(s) and ${threads.length} thread(s):`,
		);
		for (const divergence of divergences) {
			console.log(`  - ${divergence.scope}: ${divergence.detail}`);
		}
		process.exitCode = 1;
	}
	await closeCaseStoreDatabase();
}

void main();
