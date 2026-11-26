/**
 * The one in-memory publisher of a Project's ready media file.
 *
 * A caller that already holds validated bytes in memory (MCP's inline upload,
 * and a create that brings an app in from CommCare HQ) publishes them here.
 * There is no untrusted PUT round trip, so the bytes go straight to their
 * content key and the complete `ready` row commits in ONE metadata
 * transaction: there is no invisible pending row whose id a crash could lose.
 *
 * The whole publication runs under the canonical Project/hash content lock
 * (`withMediaObjectKeyLock`) the browser confirm, the Project copy and the
 * last-reference cleanup take. Under it the publisher re-checks dedup, so a
 * re-upload of bytes the Project already holds returns that ready file and
 * stores nothing. Each metadata decision proves current Project `edit` inside
 * its own transaction: the dedup read, the ready insert, and the reconciliation
 * after a lost commit response.
 *
 * The caller allocates the asset id before storage, so an ambiguous commit is
 * reconciled under the same lock: the exact committed row is returned, another
 * ready winner is deduplicated, or a truly unclaimed object is deleted. A hard
 * process crash before metadata leaves only the deterministic content key,
 * which a retry safely overwrites and adopts.
 */

import "server-only";
import type { Kysely, Transaction } from "kysely";
import { roleAllowsApp } from "@/lib/auth/projectRoles";
import {
	findReadyAssetByProjectAndHash,
	hasAssetForGcsObjectKey,
	insertReadyAssetInTransaction,
} from "@/lib/db/mediaAssets";
import type { AppDatabase } from "@/lib/db/pg";
import { projectRoleForInTransaction } from "@/lib/db/projectMembership";
import { gcsObjectKeyFor, type MediaAssetId } from "@/lib/domain/multimedia";
import { log } from "@/lib/logger";
import {
	deleteAsset as deleteStoredAsset,
	uploadAssetBytes,
} from "@/lib/storage/media";
import { withMediaObjectKeyLock } from "@/lib/storage/mediaObjectKeyLock";
import type { ValidatedMediaMetadata } from "./validate";

/** What a publication of ready bytes answered. */
export type ReadyMediaPublication =
	| { readonly kind: "published"; readonly assetId: MediaAssetId }
	| { readonly kind: "deduplicated"; readonly assetId: MediaAssetId };

/**
 * The caller may not add media to the Project's library: it is no member of
 * the Project (`not-a-member`), or its role there has no `edit` capability
 * (`cannot-edit`). Thrown from inside a metadata transaction, so nothing that
 * transaction would have written commits.
 */
export class MediaPublishPermissionError extends Error {
	readonly name = "MediaPublishPermissionError";
	constructor(readonly reason: "not-a-member" | "cannot-edit") {
		super(
			reason === "not-a-member"
				? "Only a member of this Project can add media to its library."
				: "Your role in this Project can't add media to its library. Ask a Project admin to make you an editor.",
		);
	}
}

type PublicationGrant = (tx:Transaction<AppDatabase>)=>void|Promise<void>;
type PublicationAuthority = PublicationGrant | {
 /** Source ownership locks precede the Project membership gate. */
 readonly lockSource: (tx:Transaction<AppDatabase>)=>Promise<boolean>;
 readonly grant: PublicationGrant;
};

/**
 * Publish validated bytes as one ready file of a Project, or return the ready
 * file that already holds them. Proves `edit` on the Project inside each
 * metadata transaction.
 */
export async function publishReadyMedia(input: {
	readonly actorUserId: string;
	readonly projectId: string;
	readonly bytes: Buffer;
	readonly validated: ValidatedMediaMetadata;
	readonly originalFilename: string;
	/** The id a new row takes. */
	readonly assetId: MediaAssetId;
 readonly authorizePublication?: PublicationAuthority;
}): Promise<ReadyMediaPublication> {
	const { actorUserId, projectId, bytes, validated, assetId } = input;
	const gcsObjectKey = gcsObjectKeyFor(
		projectId,
		validated.contentHash,
		validated.extension,
	);
	let finalObjectMayNeedCleanup = false;
	try {
		const publication = await withMediaObjectKeyLock(
			gcsObjectKey,
			async (lockedDb): Promise<ReadyMediaPublication> => {
				/* Re-check dedup while holding the same canonical-key lock as
				 * browser confirm, Project-copy publication, and last-reference
				 * cleanup. Exactly one same-content publisher stores bytes and
				 * commits ready metadata; every waiter observes that winner. */
				const existing = await withUploadPermission(
					lockedDb,
					actorUserId,
					projectId,
					input.authorizePublication,
					(tx) =>
						findReadyAssetByProjectAndHash(
							projectId,
							validated.contentHash,
							tx,
						),
				);
				if (existing) return { kind: "deduplicated", assetId: existing.id };

				/* Mark before storage I/O because a failed storage request can have
				 * committed remotely. The flag stays set until the lock body and its
				 * advisory unlock both finish successfully. */
				finalObjectMayNeedCleanup = true;
				await uploadAssetBytes({
					gcsObjectKey,
					bytes,
					contentType: validated.mimeType,
				});
				const published = await withUploadPermission(
					lockedDb,
					actorUserId,
					projectId,
					input.authorizePublication,
					(tx) =>
						insertReadyAssetInTransaction(tx, {
							assetId,
							owner: actorUserId,
							project_id: projectId,
							contentHash: validated.contentHash,
							mimeType: validated.mimeType,
							kind: validated.kind,
							extension: validated.extension,
							sizeBytes: validated.sizeBytes,
							gcsObjectKey,
							originalFilename: input.originalFilename,
							...(validated.dimensions !== undefined && {
								dimensions: validated.dimensions,
							}),
							...(validated.durationMs !== undefined && {
								durationMs: validated.durationMs,
							}),
							...(validated.mediaFormat !== undefined && {
								mediaFormat: validated.mediaFormat,
							}),
						}),
				);
				return { kind: "published", assetId: published.id };
			},
		);
		finalObjectMayNeedCleanup = false;
		return publication;
	} catch (error) {
		if (finalObjectMayNeedCleanup) {
			const recovered = await recoverFailedPublication({
				gcsObjectKey,
				projectId,
				contentHash: validated.contentHash,
				attemptId:assetId,authorizePublication:input.authorizePublication,
				actorUserId,
			}).catch((cleanupError: unknown) => {
				if (cleanupError instanceof MediaPublishPermissionError)
					throw cleanupError;
				log.error(
					"[media:publish-ready] lost-publication recovery failed",
					cleanupError,
					{ gcsObjectKey, projectId, attemptAssetId: assetId },
				);
				return null;
			});
			if (recovered !== null) {
				return recovered.assetId === assetId
					? { kind: "published", assetId }
					: { kind: "deduplicated", assetId: recovered.assetId };
			}
		}
		throw error;
	}
}

/** Storage work holds only the content lock. Each metadata decision then
 * proves current edit authority under the same transaction as its read or
 * publication. */
function withUploadPermission<T>(
	db: Kysely<AppDatabase>,
	actorUserId: string,
	projectId: string,
	authorize: PublicationAuthority|undefined,
	body: (tx: Transaction<AppDatabase>) => Promise<T>,
): Promise<T> {
	return db.transaction().execute(async (tx) => {
		const grant=typeof authorize === "function" ? authorize : authorize && await authorize.lockSource(tx) ? authorize.grant : undefined;
		const role = await projectRoleForInTransaction(tx, actorUserId, projectId);
		if (role === null) throw new MediaPublishPermissionError("not-a-member");
		if (!roleAllowsApp(role, "edit"))
			throw new MediaPublishPermissionError("cannot-edit");
		await grant?.(tx);
		return body(tx);
	});
}

async function recoverFailedPublication(args: {
 attemptId:MediaAssetId;
 authorizePublication?: PublicationAuthority;
	gcsObjectKey: string;
	projectId: string;
	contentHash: string;
	actorUserId: string;
}): Promise<{ assetId: MediaAssetId } | null> {
	return withMediaObjectKeyLock(args.gcsObjectKey, async (lockedDb) => {
		/* A transaction commit can succeed even when its acknowledgement is lost.
		 * Re-read the serialized Project/hash result before treating the object as
		 * unpublished. If it is our preallocated id, the insert committed; if a
		 * waiter published after our rollback, that row is the canonical dedup
		 * result. Identical bytes can validate under different extensions, so a
		 * ready hash winner does not necessarily claim this attempt's exact key. */
		const ready = await findReadyAssetByProjectAndHash(
			args.projectId,
			args.contentHash,
			lockedDb,
		);
		if (ready !== null) {
			if (ready.gcsObjectKey !== args.gcsObjectKey) {
				const attemptedKeyIsClaimed = await hasAssetForGcsObjectKey(
					args.gcsObjectKey,
					lockedDb,
				);
				if (!attemptedKeyIsClaimed) {
					await deleteStoredAsset(args.gcsObjectKey);
				}
			}
			return withUploadPermission(
				lockedDb,
				args.actorUserId,
				args.projectId,
				ready.id===args.attemptId ? undefined : args.authorizePublication,
				async (tx) => {
					const current = await findReadyAssetByProjectAndHash(
						args.projectId,
						args.contentHash,
						tx,
					);
					return current === null ? null : { assetId: current.id };
				},
			);
		}
		const published = await hasAssetForGcsObjectKey(
			args.gcsObjectKey,
			lockedDb,
		);
		if (!published) await deleteStoredAsset(args.gcsObjectKey);
		return null;
	});
}
