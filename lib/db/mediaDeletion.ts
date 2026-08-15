/** Authoritative attach/delete serialization for Project-scoped media. */

import { sql, type Transaction } from "kysely";
import { jsonArrayFrom } from "kysely/helpers/postgres";
import { type AppCapability, roleAllowsApp } from "@/lib/auth/projectRoles";
import { collectThreadAttachmentAssetIds } from "@/lib/chat/threadAttachments";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import type { MediaAssetId } from "@/lib/domain";
import {
	asWalkableDoc,
	describeCarrier,
	walkAuthoredAssetRefs,
} from "@/lib/domain/mediaRefs";
import { type MediaAssetRecord, mediaAssetRecordFromRow } from "./mediaAssets";
import {
	assemblePersistedBlueprintJsonText,
	type PersistedEntityRowText,
} from "./persistedJson";
import { type AppDatabase, withAppTx } from "./pg";
import { projectRoleForInTransaction } from "./projectMembership";

const REFERENCE_DESCRIPTION_LIMIT = 5;

export type MediaMetadataDeleteResult =
	| { readonly kind: "not_found" }
	| { readonly kind: "referenced"; readonly references: readonly string[] }
	| { readonly kind: "deleted"; readonly asset: MediaAssetRecord };

/**
 * Browser/library deletion wrapper. The transaction takes no app row lock;
 * chat deletion calls the in-transaction core after its required app/holder
 * lock instead.
 */
export async function deleteMediaAssetForActor(args: {
	assetId: MediaAssetId;
	actorUserId: string;
	expectedProjectId?: string;
}): Promise<MediaMetadataDeleteResult> {
	return withAppTx((tx) => deleteMediaAssetMetadataInTransaction(tx, args));
}

/**
 * Fresh membership gate -> asset `FOR UPDATE` -> complete persisted-carrier
 * rewalk -> metadata delete. Never takes an app row lock after the asset lock.
 */
export async function deleteMediaAssetMetadataInTransaction(
	tx: Transaction<AppDatabase>,
	args: {
		assetId: MediaAssetId;
		actorUserId: string;
		expectedProjectId?: string;
		requiredCapability?: AppCapability;
	},
): Promise<MediaMetadataDeleteResult> {
	const snapshot = await tx
		.selectFrom("media_assets")
		.select("project_id")
		.where("id", "=", args.assetId)
		.executeTakeFirst();
	if (
		snapshot === undefined ||
		(args.expectedProjectId !== undefined &&
			snapshot.project_id !== args.expectedProjectId)
	) {
		return { kind: "not_found" };
	}
	const role = await projectRoleForInTransaction(
		tx,
		args.actorUserId,
		snapshot.project_id,
	);
	if (
		role === null ||
		!roleAllowsApp(role, args.requiredCapability ?? "edit")
	) {
		return { kind: "not_found" };
	}

	const row = await tx
		.selectFrom("media_assets")
		.selectAll()
		.where("id", "=", args.assetId)
		.where("project_id", "=", snapshot.project_id)
		.forUpdate()
		.executeTakeFirst();
	if (row === undefined) return { kind: "not_found" };

	const references = await persistedAppReferencesInTransaction(tx, {
		assetId: args.assetId,
		projectId: snapshot.project_id,
	});
	if (references.length > 0) return { kind: "referenced", references };

	await tx
		.deleteFrom("media_assets")
		.where("id", "=", args.assetId)
		.where("project_id", "=", snapshot.project_id)
		.execute();
	return { kind: "deleted", asset: mediaAssetRecordFromRow(row) };
}

async function persistedAppReferencesInTransaction(
	tx: Transaction<AppDatabase>,
	args: { assetId: MediaAssetId; projectId: string },
): Promise<string[]> {
	// Exact edges, the app root, normalized entities, and thread transcripts MUST
	// come from one statement snapshot. A READ COMMITTED transaction takes a
	// fresh snapshot per statement: reading candidate edges first would otherwise
	// let a concurrent writer remove its edge and carrier before the carrier
	// statement, producing a false projection-invariant failure. We deliberately
	// cannot lock apps after the asset lock, so one edge-rooted query with
	// correlated JSON subqueries makes the complete projection coherent without
	// reversing the global lock order.
	const appQuery = tx
		.selectFrom("media_asset_refs as edge")
		.innerJoin("apps as app", (join) =>
			join
				.onRef("app.id", "=", "edge.app_id")
				.onRef("app.project_id", "=", "edge.project_id"),
		)
		.select(["app.id", "app.app_name", "app.connect_type", "app.logo"])
		.select(
			sql<string | null>`${sql.ref("app.case_types")}::text`.as(
				"case_types_text",
			),
		)
		.select(
			sql<string | null>`${sql.ref("app.localization")}::text`.as(
				"localization_text",
			),
		)
		.select((eb) => [
			jsonArrayFrom(
				eb
					.selectFrom("blueprint_entities as entity")
					.select([
						"entity.uuid",
						"entity.kind",
						"entity.parent_uuid",
						"entity.ordinal",
					])
					.select(sql<string>`${sql.ref("entity.data")}::text`.as("data_text"))
					.whereRef("entity.app_id", "=", "app.id")
					.orderBy("entity.uuid"),
			).as("entities"),
		])
		.where("edge.project_id", "=", args.projectId)
		.where("edge.asset_id", "=", args.assetId);
	const apps = await appQuery.orderBy("app.id").execute();

	const descriptions: string[] = [];
	for (const app of apps) {
		const persisted = assemblePersistedBlueprintJsonText(
			app.id,
			{
				app_name: app.app_name,
				connect_type: app.connect_type,
				case_types_text: app.case_types_text,
				localization_text: app.localization_text,
				logo: app.logo,
			},
			app.entities as PersistedEntityRowText[],
		);
		const doc = hydratePersistedBlueprint(persisted);
		const carriers = [
			...new Set(
				[...walkAuthoredAssetRefs(asWalkableDoc(doc))]
					.filter((ref) => ref.assetId === args.assetId)
					.map(describeCarrier),
			),
		];
		if (
			carriers.length > 0 &&
			descriptions.length < REFERENCE_DESCRIPTION_LIMIT
		) {
			descriptions.push(
				`"${app.app_name}" (${app.id}) on ${carriers.join("; ")}`,
			);
		}
		if (carriers.length === 0) {
			throw new Error(
				`media_asset_refs is not an exact projection for app ${app.id} and asset ${args.assetId}`,
			);
		}
	}

	/* The CONVERSATION reference family — the split half of the projection.
	 * One `thread_media_refs` row per referencing thread; the row is the
	 * exact projection (the thread writers replace it transactionally), and
	 * the walk above no longer sees transcripts, so this is the only place a
	 * conversation attachment blocks deletion. */
	const threadRefs = await tx
		.selectFrom("thread_media_refs")
		.select(["thread_id"])
		.where("project_id", "=", args.projectId)
		.where("asset_id", "=", args.assetId)
		.orderBy("thread_id")
		.execute();
	if (threadRefs.length > 0) {
		descriptions.push(
			threadRefs.length === 1
				? "a conversation attachment"
				: `${threadRefs.length} conversation attachments`,
		);
	} else {
		/* Defense-in-depth backstop: re-prove absence against the transcripts
		 * themselves. The per-thread projection is the authority the thread
		 * writers maintain, but deletion is the one IRREVERSIBLE consumer
		 * (the bytes purge after commit), so a missing projection row — a
		 * writer that predates the projection, a rollout window, a repair
		 * mid-flight — must not authorize a purge the primary record
		 * refutes. The containment prefilter narrows to candidate threads in
		 * this Project; a candidate whose transcript names the asset — or
		 * whose attachment metadata cannot be parsed to prove it doesn't —
		 * blocks the deletion. */
		const candidates = await tx
			.selectFrom("threads")
			.leftJoin("apps", "apps.id", "threads.app_id")
			.leftJoin(
				"design_sessions",
				"design_sessions.id",
				"threads.design_session_id",
			)
			.select(["threads.thread_id", "threads.messages"])
			.where(
				sql<boolean>`${sql.ref("threads.messages")}::text LIKE '%' || ${args.assetId} || '%'`,
			)
			.where((eb) =>
				eb.or([
					eb("apps.project_id", "=", args.projectId),
					eb("design_sessions.project_id", "=", args.projectId),
				]),
			)
			.orderBy("threads.thread_id")
			.execute();
		let referencingThreads = 0;
		for (const candidate of candidates) {
			try {
				if (
					collectThreadAttachmentAssetIds(candidate.messages).includes(
						args.assetId,
					)
				) {
					referencingThreads += 1;
				}
			} catch {
				referencingThreads += 1;
			}
		}
		if (referencingThreads > 0) {
			descriptions.push(
				referencingThreads === 1
					? "a conversation attachment"
					: `${referencingThreads} conversation attachments`,
			);
		}
	}
	return descriptions;
}

export class MediaAssetStillReferencedError extends Error {
	readonly name = "MediaAssetStillReferencedError";
	constructor(readonly references: readonly string[]) {
		super("The media asset is still referenced by a persisted app.");
	}
}
