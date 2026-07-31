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
			jsonArrayFrom(
				eb
					.selectFrom("threads as thread")
					.select("thread.messages")
					.whereRef("thread.app_id", "=", "app.id")
					.orderBy("thread.thread_id"),
			).as("threads"),
		])
		.where("edge.project_id", "=", args.projectId)
		.where("edge.asset_id", "=", args.assetId);
	const apps = await appQuery.orderBy("app.id").execute();
	if (apps.length === 0) return [];
	const threadReferenceCountByApp = new Map<string, number>();
	for (const app of apps) {
		for (const thread of app.threads) {
			const count = collectThreadAttachmentAssetIds(thread.messages).filter(
				(assetId) => assetId === args.assetId,
			).length;
			if (count > 0) {
				threadReferenceCountByApp.set(
					app.id,
					(threadReferenceCountByApp.get(app.id) ?? 0) + count,
				);
			}
		}
	}

	const descriptions: string[] = [];
	for (const app of apps) {
		const persisted = assemblePersistedBlueprintJsonText(
			app.id,
			{
				app_name: app.app_name,
				connect_type: app.connect_type,
				case_types_text: app.case_types_text,
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
		const threadReferenceCount = threadReferenceCountByApp.get(app.id) ?? 0;
		if (threadReferenceCount > 0) {
			carriers.push(
				threadReferenceCount === 1
					? "a conversation attachment"
					: `${threadReferenceCount} conversation attachments`,
			);
		}
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
	return descriptions;
}

export class MediaAssetStillReferencedError extends Error {
	readonly name = "MediaAssetStillReferencedError";
	constructor(readonly references: readonly string[]) {
		super("The media asset is still referenced by a persisted app.");
	}
}
