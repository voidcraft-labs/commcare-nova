/** Authoritative attach/delete serialization for Project-scoped media. */

import type { Transaction } from "kysely";
import { type AppCapability, roleAllowsApp } from "@/lib/auth/projectRoles";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import {
	asWalkableDoc,
	describeCarrier,
	walkAssetRefs,
} from "@/lib/domain/mediaRefs";
import { assembleBlueprint, type EntityRow } from "./blueprintRows";
import { type MediaAssetRecord, mediaAssetRecordFromRow } from "./mediaAssets";
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
	assetId: string;
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
		assetId: string;
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

	await tx.deleteFrom("media_assets").where("id", "=", args.assetId).execute();
	return { kind: "deleted", asset: mediaAssetRecordFromRow(row) };
}

async function persistedAppReferencesInTransaction(
	tx: Transaction<AppDatabase>,
	args: { assetId: string; projectId: string },
): Promise<string[]> {
	const state = await tx
		.selectFrom("media_reference_index_state")
		.select("audited_complete_at")
		.where("singleton", "=", true)
		.executeTakeFirst();
	let candidateIds: string[] | undefined;
	if (state?.audited_complete_at !== null && state !== undefined) {
		candidateIds = (
			await tx
				.selectFrom("media_asset_refs")
				.select("app_id")
				.where("asset_id", "=", args.assetId)
				.execute()
		).map((entry) => entry.app_id);
		if (candidateIds.length === 0) return [];
	}

	let appQuery = tx
		.selectFrom("apps")
		.select(["id", "app_name", "connect_type", "case_types", "logo"])
		.where("project_id", "=", args.projectId)
		.where("deleted_at", "is", null);
	if (candidateIds !== undefined) {
		appQuery = appQuery.where("id", "in", [...new Set(candidateIds)]);
	}
	const apps = await appQuery.orderBy("id").execute();
	if (apps.length === 0) return [];
	const appIds = apps.map((app) => app.id);
	const entities = (await tx
		.selectFrom("blueprint_entities")
		.select(["app_id", "uuid", "kind", "parent_uuid", "ordinal", "data"])
		.where("app_id", "in", appIds)
		.orderBy("app_id")
		.orderBy("uuid")
		.execute()) as Array<EntityRow & { app_id: string }>;
	const entitiesByApp = new Map<string, EntityRow[]>();
	for (const entity of entities) {
		const list = entitiesByApp.get(entity.app_id) ?? [];
		list.push(entity);
		entitiesByApp.set(entity.app_id, list);
	}

	const descriptions: string[] = [];
	for (const app of apps) {
		const persisted = assembleBlueprint(
			app.id,
			{
				app_name: app.app_name,
				connect_type: app.connect_type,
				case_types: app.case_types,
				logo: app.logo,
			},
			entitiesByApp.get(app.id) ?? [],
		);
		const doc = hydratePersistedBlueprint(persisted);
		const carriers = [
			...new Set(
				[...walkAssetRefs(asWalkableDoc(doc))]
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
	}
	return descriptions;
}

export class MediaAssetStillReferencedError extends Error {
	readonly name = "MediaAssetStillReferencedError";
	constructor(readonly references: readonly string[]) {
		super("The media asset is still referenced by a live app.");
	}
}
