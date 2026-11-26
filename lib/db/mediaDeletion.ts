/** Authoritative attach/delete serialization for Project-scoped media. */

import type { Transaction } from "kysely";
import { type AppCapability, roleAllowsApp } from "@/lib/auth/projectRoles";
import type { MediaAssetId } from "@/lib/domain";
import {
	asWalkableDoc,
	describeCarrier,
	walkAuthoredAssetRefs,
} from "@/lib/domain/mediaRefs";
import { type MediaAssetRecord, mediaAssetRecordFromRow } from "./mediaAssets";
import {
	hydrateReferenceApp,
	persistedReferenceApps,
} from "./persistedReferenceApps";
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
	// Read exact edges and their carriers from the same statement snapshot.
	const appQuery = persistedReferenceApps(tx)
		.innerJoin("media_asset_refs as edge", (join) =>
			join
				.onRef("app.id", "=", "edge.app_id")
				.onRef("app.project_id", "=", "edge.project_id"),
		)
		.where("edge.project_id", "=", args.projectId)
		.where("edge.asset_id", "=", args.assetId);
	const apps = await appQuery.orderBy("app.id").execute();

	const descriptions: string[] = [];
	for (const app of apps) {
		const doc = hydrateReferenceApp(app);
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

	// Conversation evidence is retained independently; deleting its Library origin
	// never deletes thread_source_contents or thread_source_links.
	return descriptions;
}

export class MediaAssetStillReferencedError extends Error {
	readonly name = "MediaAssetStillReferencedError";
	constructor(readonly references: readonly string[]) {
		super("The media asset is still referenced by a persisted app.");
	}
}
