import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { sql, type Transaction } from "kysely";
import { ApiError } from "@/lib/apiError";
import { type AppDatabase, withAppTx } from "@/lib/db/pg";
import { verifyPlaceWitness } from "@/lib/deployment/placeWorkbook";
import { verifyAssignmentWitness } from "@/lib/export/privateAssignments";
import { LookupError } from "@/lib/lookup/errors";
import {
	type BulkObject,
	confirmBulkObject,
	lockLookupBudget,
	markBulkObjectDeleting,
	refundDeletedBulkObject,
	reserveBulkObject,
} from "@/lib/lookup/generations/budget";
import {
	deleteAssetGeneration,
	exportPartGeneration,
	fetchExportPart,
	storeExportPart,
} from "@/lib/storage/media";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import {
	artifactUnavailable,
	type ExportActor,
	type ExportSpec,
	lockExportAccess,
} from "./access";
import { claimExportWorkspace } from "./capacity";
import {
	type ByteRange,
	EXPORT_INLINE_BYTES,
	EXPORT_PART_BYTES,
	fixedExportParts,
} from "./range";

const lifetimeMs = 60 * 60 * 1000;
interface ArtifactRow {
	id: string;
	project_id: string;
	actor_id: string;
	grant_digest: string;
	binding: string;
	lease_owner: string | null;
	lease_until: Date | null;
	spec: ExportSpec;
	state: "building" | "ready" | "deleting";
	byte_length: string;
	digest: string | null;
	expires_at: Date;
}
interface PartRow {
	byte_offset: string;
	byte_length: number;
	digest: string;
	generation: string | null;
}

export interface ExportManifest {
	id: string;
	filename: string;
	format: "zip" | "ccz";
	byteLength: number;
	sha256: string;
	expiresAt: string;
}

function objectOf(row: ArtifactRow): BulkObject {
	return {
		projectId: row.project_id,
		id: row.id,
		actorId: row.actor_id,
		binding: row.binding,
		kind: "export",
	};
}
function partKey(row: ArtifactRow, offset: number) {
	return `private-exports/${encodeURIComponent(row.project_id)}/${row.id}/${offset}`;
}
function hash(bytes: Uint8Array) {
	return createHash("sha256").update(bytes).digest("hex");
}

function manifestOf(row: ArtifactRow): ExportManifest {
	if (row.state !== "ready" || row.digest === null)
		return artifactUnavailable();
	return {
		id: row.id,
		filename: row.spec.filename,
		format: row.spec.format,
		byteLength: Number(row.byte_length),
		sha256: row.digest,
		expiresAt: row.expires_at.toISOString(),
	};
}

async function getForActor(
	tx: Transaction<AppDatabase>,
	actor: ExportActor,
	id: string,
) {
	const result =
		await sql<ArtifactRow>`SELECT * FROM export_artifacts WHERE id=${id} AND actor_id=${actor.userId} AND expires_at>clock_timestamp() AND state<>'deleting' FOR SHARE`.execute(
			tx,
		);
	const row = result.rows[0];
	if (!row) return artifactUnavailable();
	if ((await lockExportAccess(tx, actor, row.spec)) !== row.grant_digest)
		return artifactUnavailable();
	return row;
}

function asResponseError(error: unknown): never {
	if (error instanceof LookupError) {
		if (error.code === "not_found") return artifactUnavailable();
		throw new ApiError(
			error.message,
			error.code === "storage_limit" ? 507 : 409,
		);
	}
	throw error;
}

/** Invoked lazily, only when an archive actually exceeds its ordinary inline allowance. */
export async function deliverExport(
	source: AsyncIterable<Uint8Array>,
	access: () => { actor: ExportActor; spec: ExportSpec },
	options: { signal?: AbortSignal; protected?: boolean } = {},
): Promise<{ bytes: Buffer } | { artifact: ExportManifest }> {
	const release = claimExportWorkspace("prepare");
	const parts = fixedExportParts(source);
	try {
		options.signal?.throwIfAborted();
		if (options.protected) {
			const { actor, spec } = access();
			await withAppTx((tx) => lockExportAccess(tx, actor, spec));
			await checkDestination(actor, spec);
		}
		const first = await parts.next();
		if (first.done && !options.protected) return { bytes: Buffer.alloc(0) };
		const second = await parts.next();
		if (
			!first.done &&
			!options.protected &&
			second.done &&
			first.value.byteLength <= EXPORT_INLINE_BYTES
		)
			return { bytes: first.value };
		options.signal?.throwIfAborted();
		const { actor, spec } = access();
		await checkDestination(actor, spec);
		// A returning editor can recover physical capacity even if no operator
		// sweep has run. Retire one expired part at a time under the Project lock.
		await withAppTx(async (tx) => {
			await lockExportAccess(tx, actor, spec);
			await reclaimExportBatch(tx, spec.projectId);
		});
		const owner = randomUUID();
		const row = await withAppTx(async (tx) => {
			const grantDigest = await lockExportAccess(tx, actor, spec);
			const binding = canonicalJsonDigest([
				spec,
				grantDigest,
				process.env.K_REVISION ?? "local-1",
			]);
			await lockLookupBudget(tx, spec.projectId);
			const active =
				await sql<ArtifactRow>`SELECT * FROM export_artifacts WHERE project_id=${spec.projectId} AND actor_id=${actor.userId}
				AND binding=${binding} AND expires_at>clock_timestamp() AND state<>'deleting' ORDER BY expires_at DESC LIMIT 1 FOR UPDATE`.execute(
					tx,
				);
			const previous = active.rows[0];
			if (previous?.state === "ready") return previous;
			if (previous) {
				const claim =
					await sql<ArtifactRow>`UPDATE export_artifacts SET lease_owner=${owner},lease_until=clock_timestamp()+interval '2 minutes'
					WHERE id=${previous.id} AND (lease_owner IS NULL OR lease_until<=clock_timestamp()) RETURNING *`.execute(
						tx,
					);
				if (!claim.rows[0])
					throw new ApiError(
						"Nova is still preparing this file. You can try the download again shortly.",
						409,
					);
				return claim.rows[0];
			}
			const id = randomUUID();
			const expiresAt = new Date(Date.now() + lifetimeMs);
			await reserveBulkObject(
				tx,
				{
					projectId: spec.projectId,
					id,
					actorId: actor.userId,
					binding,
					kind: "export",
				},
				0,
				expiresAt,
			);
			const created =
				await sql<ArtifactRow>`INSERT INTO export_artifacts(id,project_id,actor_id,app_id,grant_digest,binding,spec,state,expires_at,lease_owner,lease_until)
				VALUES(${id},${spec.projectId},${actor.userId},${spec.appId},${grantDigest},${binding},${JSON.stringify(spec)}::jsonb,'building',${expiresAt},${owner},clock_timestamp()+interval '2 minutes') RETURNING *`.execute(
					tx,
				);
			return created.rows[0];
		});
		if (row.state === "ready") return { artifact: manifestOf(row) };
		const { id, expires_at: expiresAt } = row;
		const renew = async (tx: Transaction<AppDatabase>) => {
			await getForActor(tx, actor, id);
			const held =
				await sql`UPDATE export_artifacts SET lease_until=clock_timestamp()+interval '2 minutes'
				WHERE id=${id} AND lease_owner=${owner} AND state='building' RETURNING id`.execute(
					tx,
				);
			if (!held.rows.length) return artifactUnavailable();
		};
		const digest = createHash("sha256");
		let offset = 0;
		const write = async (bytes: Buffer) => {
			options.signal?.throwIfAborted();
			const partDigest = hash(bytes);
			const written = await withAppTx(async (tx) => {
				await lockLookupBudget(tx, spec.projectId);
				await renew(tx);
				const existing =
					await sql<PartRow>`SELECT byte_offset,byte_length,digest,generation FROM export_artifact_parts
					WHERE project_id=${row.project_id} AND artifact_id=${id} AND byte_offset=${offset}`.execute(
						tx,
					);
				const receipt = existing.rows[0];
				if (receipt) {
					if (
						receipt.byte_length !== bytes.length ||
						receipt.digest !== partDigest
					)
						throw new Error("The file changed while resuming its preparation.");
					if (receipt.generation === null)
						await sql`UPDATE export_artifact_parts SET write_intent_at=clock_timestamp()
						WHERE project_id=${row.project_id} AND artifact_id=${id} AND byte_offset=${offset}`.execute(
							tx,
						);
					return receipt.generation !== null;
				}
				await reserveBulkObject(
					tx,
					objectOf(row),
					offset + bytes.length,
					expiresAt,
				);
				await sql`INSERT INTO export_artifact_parts(project_id,artifact_id,byte_offset,byte_length,digest)
					VALUES(${row.project_id},${id},${offset},${bytes.length},${partDigest})`.execute(
					tx,
				);
				return false;
			});
			// A lost acknowledgement is replayed with a GCS create-only precondition.
			if (!written)
				await withAppTx(async (tx) => {
					await renew(tx);
					const generation = await storeExportPart(
						partKey(row, offset),
						bytes,
						partDigest,
					);
					await sql`UPDATE export_artifact_parts SET generation=${generation} WHERE project_id=${row.project_id}
					AND artifact_id=${id} AND byte_offset=${offset} AND digest=${partDigest}`.execute(
						tx,
					);
				});
			offset += bytes.length;
			digest.update(bytes);
		};
		try {
			if (!first.done) await write(first.value);
			if (!second.done) await write(second.value);
			for await (const part of parts) await write(part);
			options.signal?.throwIfAborted();
			await checkDestination(actor, spec);
			const stored = await withAppTx(async (tx) => {
				await lockLookupBudget(tx, spec.projectId);
				await renew(tx);
				const extra =
					await sql`SELECT 1 FROM export_artifact_parts WHERE project_id=${row.project_id} AND artifact_id=${id}
					AND (byte_offset>=${offset} OR generation IS NULL) LIMIT 1`.execute(
						tx,
					);
				if (extra.rows.length)
					throw new Error("The file changed while resuming its preparation.");
				await confirmBulkObject(tx, objectOf(row), offset, expiresAt);
				const done =
					await sql<ArtifactRow>`UPDATE export_artifacts SET state='ready',lease_owner=NULL,lease_until=NULL,byte_length=${offset},digest=${digest.digest("hex")}
					WHERE id=${id} AND state='building' AND expires_at>clock_timestamp() RETURNING *`.execute(
						tx,
					);
				if (!done.rows[0]) return artifactUnavailable();
				return done.rows[0];
			});
			return { artifact: manifestOf(stored) };
		} catch (error) {
			await withAppTx(async (tx) => {
				await sql`UPDATE export_artifacts SET lease_owner=NULL,lease_until=NULL WHERE id=${id} AND lease_owner=${owner}`.execute(
					tx,
				);
			});
			throw error;
		}
	} catch (error) {
		return asResponseError(error);
	} finally {
		try {
			await parts.return(undefined);
		} finally {
			release();
		}
	}
}

async function checkDestination(actor: ExportActor, spec: ExportSpec) {
	if (spec.places) await verifyPlaceWitness(actor, spec);
	if (spec.assignments)
		await verifyAssignmentWitness(
			{
				scope: {
					appId: spec.appId,
					projectId: spec.projectId,
					actorUserId: actor.userId,
				},
				grant: actor.grant,
				target: spec.assignments.target,
			},
			spec.assignments,
		);
}

export async function readExportManifest(actor: ExportActor, id: string) {
	try {
		const row = await withAppTx((tx) => getForActor(tx, actor, id));
		await checkDestination(actor, row.spec);
		return await withAppTx(async (tx) =>
			manifestOf(await getForActor(tx, actor, id)),
		);
	} catch (error) {
		return asResponseError(error);
	}
}

export async function* exportRange(
	actor: ExportActor,
	id: string,
	range: ByteRange,
	signal?: AbortSignal,
) {
	const release = claimExportWorkspace("range");
	try {
		let next = range.start;
		while (next <= range.end) {
			signal?.throwIfAborted();
			const offset = Math.floor(next / EXPORT_PART_BYTES) * EXPORT_PART_BYTES;
			const { row, part } = await withAppTx(async (tx) => {
				const row = await getForActor(tx, actor, id);
				if (
					row.state !== "ready" ||
					range.start < 0 ||
					range.end >= Number(row.byte_length)
				)
					return artifactUnavailable();
				const parts =
					await sql<PartRow>`SELECT byte_offset,byte_length,digest,generation FROM export_artifact_parts
					WHERE project_id=${row.project_id} AND artifact_id=${id} AND byte_offset=${offset}`.execute(
						tx,
					);
				const part = parts.rows[0];
				if (!part?.generation) return artifactUnavailable();
				return { row, part: { ...part, generation: part.generation } };
			});
			await checkDestination(actor, row.spec);
			const bytes = await fetchExportPart(
				partKey(row, offset),
				part.generation,
				part.byte_length,
			);
			await checkDestination(actor, row.spec);
			if (hash(bytes) !== part.digest)
				throw new Error("The retained export failed its integrity check.");
			await withAppTx(async (tx) =>
				manifestOf(await getForActor(tx, actor, id)),
			);
			signal?.throwIfAborted();
			const end = Math.min(range.end + 1, offset + bytes.length);
			yield bytes.subarray(next - offset, end - offset);
			next = end;
		}
	} catch (error) {
		asResponseError(error);
	} finally {
		release();
	}
}

/** One part per short transaction, including one generation-specific delete.
 * In-flight writes receive a full lease to settle. If upload acknowledgement was
 * lost, inspect only the key the durable intent reserved. Never refund on error. */
export async function reclaimExportBatch(
	tx: Transaction<AppDatabase>,
	projectId: string,
) {
	await lockLookupBudget(tx, projectId);
	const found =
		await sql<ArtifactRow>`SELECT e.* FROM export_artifacts e WHERE e.project_id=${projectId} AND e.expires_at<=clock_timestamp()
		AND (e.lease_until IS NULL OR e.lease_until<=clock_timestamp())
		AND NOT EXISTS(SELECT 1 FROM export_artifact_parts p WHERE p.project_id=e.project_id AND p.artifact_id=e.id AND p.generation IS NULL
			AND p.write_intent_at>clock_timestamp()-interval '15 minutes')
		ORDER BY expires_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`.execute(tx);
	const row = found.rows[0];
	if (!row) return false;
	await markBulkObjectDeleting(tx, objectOf(row));
	await sql`UPDATE export_artifacts SET state='deleting' WHERE id=${row.id}`.execute(
		tx,
	);
	const parts =
		await sql<PartRow>`SELECT byte_offset,byte_length,digest,generation FROM export_artifact_parts WHERE project_id=${projectId}
		AND artifact_id=${row.id} ORDER BY byte_offset LIMIT 1 FOR UPDATE`.execute(
			tx,
		);
	const part = parts.rows[0];
	if (part) {
		const key = partKey(row, Number(part.byte_offset));
		const generation = part.generation ?? (await exportPartGeneration(key));
		if (generation) {
			await deleteAssetGeneration(key, generation);
			if ((await exportPartGeneration(key)) !== null)
				throw new Error("The retained download still exists after deletion.");
		}
		await sql`DELETE FROM export_artifact_parts WHERE project_id=${projectId} AND artifact_id=${row.id} AND byte_offset=${part.byte_offset}`.execute(
			tx,
		);
	} else {
		await sql`DELETE FROM export_artifacts WHERE id=${row.id}`.execute(tx);
		await refundDeletedBulkObject(tx, objectOf(row));
	}
	return true;
}
