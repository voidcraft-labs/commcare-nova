/**
 * Converge the split media reference projections over live data — the
 * operator sibling of the 20260809000000 migration's backfill, for the
 * deploy-window skew the old revision's writers left behind (it kept
 * writing thread-contributed `media_asset_refs` edges, and its thread
 * writes never populated `thread_media_refs`, until the cutover).
 *
 * Per app: rebuild `media_asset_refs` to exactly the authored Blueprint
 * projection. Per thread: rebuild `thread_media_refs` to exactly the
 * transcript's attachment set. Each rebuild runs in its own transaction
 * holding the authority row (`apps FOR UPDATE`; the thread's app or
 * design-session row) so it cannot race a live writer's replacement.
 *
 * Dry-run by default (prints what would change); `--execute` writes. Run
 * `scan-media-ref-projection-split.ts` before and after — the re-scan must
 * report zero divergence. One-off: delete this script (and the scan) after
 * the production run per repo policy.
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
import { getAppDb, withAppTx } from "../lib/db/pg";
import { hydratePersistedBlueprint } from "../lib/doc/fieldParent";
import { targetProdDb } from "./lib/prodDb";

async function main(): Promise<void> {
	const program = new Command()
		.description(
			"Rebuild media_asset_refs (Blueprint-only) and thread_media_refs (per-thread) to their exact split projections.",
		)
		.option("--execute", "write the rebuilt projections (default: dry-run)")
		.option(
			"--prod",
			"target the production Cloud SQL instance (public IP + your gcloud IAM identity)",
		)
		.parse();
	const execute = program.opts().execute === true;
	if (program.opts().prod === true) targetProdDb();

	const db = await getAppDb();
	let appsRebuilt = 0;
	let threadsRebuilt = 0;

	const appIds = await db.selectFrom("apps").select("id").execute();
	for (const { id: appId } of appIds) {
		const changed = await withAppTx(async (tx) => {
			const app = await tx
				.selectFrom("apps")
				.select(["id", "project_id", "app_name", "connect_type", "logo"])
				.select(sql<string | null>`case_types::text`.as("case_types_text"))
				.where("id", "=", appId)
				.forUpdate()
				.executeTakeFirst();
			if (!app) return false;
			const entities = await tx
				.selectFrom("blueprint_entities")
				.select(["uuid", "kind", "parent_uuid", "ordinal"])
				.select(sql<string>`data::text`.as("data_text"))
				.where("app_id", "=", appId)
				.orderBy("uuid")
				.execute();
			const persisted = assemblePersistedBlueprintJsonText(
				appId,
				{
					app_name: app.app_name,
					connect_type: app.connect_type,
					case_types_text: app.case_types_text,
					logo: app.logo,
				} as PersistedBlueprintRootText,
				entities as unknown as PersistedEntityRowText[],
			);
			const doc = hydratePersistedBlueprint(persisted);
			const expected = [
				...new Set(
					blueprintMediaRequirements(doc).map((ref) => String(ref.assetId)),
				),
			].sort();
			const stored = await tx
				.selectFrom("media_asset_refs")
				.select(sql<string>`asset_id::text`.as("asset_id"))
				.where("app_id", "=", appId)
				.execute();
			const storedIds = stored.map((row) => row.asset_id).sort();
			if (JSON.stringify(expected) === JSON.stringify(storedIds)) return false;
			console.log(
				`app ${appId}: media_asset_refs ${storedIds.length} -> ${expected.length} row(s)`,
			);
			if (!execute) return true;
			await tx
				.deleteFrom("media_asset_refs")
				.where("app_id", "=", appId)
				.execute();
			for (const assetId of expected) {
				await sql`
					INSERT INTO media_asset_refs (project_id, asset_id, app_id)
					VALUES (${app.project_id}, ${assetId}::uuid, ${appId})
					ON CONFLICT DO NOTHING
				`.execute(tx);
			}
			return true;
		});
		if (changed) appsRebuilt++;
	}

	const threadIds = await db
		.selectFrom("threads")
		.select("thread_id")
		.execute();
	for (const { thread_id: threadId } of threadIds) {
		const changed = await withAppTx(async (tx) => {
			/* The runtime thread writers' lock order: resolve the thread's
			 * authority target UNLOCKED, lock the AUTHORITY row first (a
			 * session bound to an app delegates to the app row), then the
			 * thread row — so this rebuild serializes against live thread
			 * writers and Project moves, and the stamped project_id comes
			 * off the locked authority, never a racing snapshot. */
			const mapping = await tx
				.selectFrom("threads")
				.select(["app_id", "design_session_id"])
				.where("thread_id", "=", threadId)
				.executeTakeFirst();
			if (!mapping) return false;
			let authorityAppId = mapping.app_id;
			if (authorityAppId === null && mapping.design_session_id !== null) {
				const session = await tx
					.selectFrom("design_sessions")
					.select("app_id")
					.where("id", "=", mapping.design_session_id)
					.executeTakeFirst();
				if (!session) return false;
				authorityAppId = session.app_id;
			}
			const projectRow =
				authorityAppId !== null
					? await tx
							.selectFrom("apps")
							.select("project_id")
							.where("id", "=", authorityAppId)
							.forUpdate()
							.executeTakeFirst()
					: mapping.design_session_id !== null
						? await tx
								.selectFrom("design_sessions")
								.select("project_id")
								.where("id", "=", mapping.design_session_id)
								.forUpdate()
								.executeTakeFirst()
						: undefined;
			if (!projectRow) return false;
			const thread = await tx
				.selectFrom("threads")
				.select(["thread_id", "messages"])
				.where("thread_id", "=", threadId)
				.forUpdate()
				.executeTakeFirst();
			if (!thread) return false;
			const expected = [
				...new Set(
					collectThreadAttachmentAssetIds(thread.messages).map(String),
				),
			].sort();
			const stored = await tx
				.selectFrom("thread_media_refs")
				.select(sql<string>`asset_id::text`.as("asset_id"))
				.where("thread_id", "=", threadId)
				.execute();
			const storedIds = stored.map((row) => row.asset_id).sort();
			if (JSON.stringify(expected) === JSON.stringify(storedIds)) return false;
			console.log(
				`thread ${threadId}: thread_media_refs ${storedIds.length} -> ${expected.length} row(s)`,
			);
			if (!execute) return true;
			await tx
				.deleteFrom("thread_media_refs")
				.where("thread_id", "=", threadId)
				.execute();
			for (const assetId of expected) {
				await sql`
					INSERT INTO thread_media_refs (thread_id, asset_id, project_id)
					VALUES (${threadId}, ${assetId}::uuid, ${projectRow.project_id})
					ON CONFLICT (thread_id, asset_id) DO NOTHING
				`.execute(tx);
			}
			return true;
		});
		if (changed) threadsRebuilt++;
	}

	console.log(
		`${execute ? "Rebuilt" : "Would rebuild"} ${appsRebuilt} app projection(s) and ${threadsRebuilt} thread projection(s).`,
	);
	await closeCaseStoreDatabase();
}

void main();
