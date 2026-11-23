import "server-only";
import { sql } from "kysely";
import { roleAllowsApp } from "@/lib/auth/projectRoles";
import { projectRoleForInTransaction } from "@/lib/db/projectMembership";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import { LookupError } from "../errors";
import {
	type BulkObject,
	refundDeletedBulkObject,
	reserveBulkObject,
} from "../generations/budget";
import { lookupManifestHqOriginOf } from "../managedRules";
import { requiresLookupProjection } from "../source";
import type { LookupScope } from "../types";
import {
	advanceLookupProjectRevision,
	type LookupWriteAuthority,
	lockLookupProjectState,
	lockLookupTableForUpdate,
	lookupTableRevisions,
	notifyCommittedLookupMutation,
	requireLookupCapability,
} from "../writerTransaction";
import { assembleValue, type CellEdit } from "./assemble";
import {
	type LookupValueEditRequest,
	type LookupValueReadRequest,
	type LookupValueSlot,
	lookupValueSlotSchema,
	VALUE_CHUNK_BYTES,
	valueSlotPath,
} from "./input";
import { reclaimCellStorageBatch } from "./recovery";
import {
	invalidValue,
	readValueRange,
	storagePath,
	type ValueTx,
	valueBytes,
	valueMetadata,
} from "./value";

function conflict(): never {
	throw new LookupError(
		"conflict",
		"The row or edit changed. You can reopen the value and start from its current version.",
	);
}
function unavailable(): never {
	throw new LookupError(
		"not_found",
		"This lookup value is unavailable with this connection.",
	);
}

export async function readLookupValueInTransaction(
	tx: ValueTx,
	scope: LookupScope,
	request: LookupValueReadRequest,
) {
	const role = await projectRoleForInTransaction(
		tx,
		scope.actorId,
		scope.projectId,
	);
	if (!role || !roleAllowsApp(role, "view")) return unavailable();
	const table = await tx
		.selectFrom("lookup_tables")
		.selectAll()
		.where("project_id", "=", scope.projectId)
		.where("id", "=", request.tableId)
		.forShare()
		.executeTakeFirst();
	if (!table || requiresLookupProjection(lookupManifestHqOriginOf(table)))
		return unavailable();
	if (
		lookupTableRevisions(table).tableRevision !== request.expectedTableRevision
	)
		return conflict();
	const target = { ...request, projectId: scope.projectId };
	return readValueRange(
		tx,
		target,
		await valueMetadata(tx, target),
		request.byteOffset ?? 0,
	);
}

function storedSlot(path: string[]): LookupValueSlot {
	const [kind, key, nth, propertyId] = path;
	return lookupValueSlotSchema.parse(
		kind === "attribute"
			? { kind, attributeId: key }
			: kind === "cell"
				? { kind, columnId: key }
				: {
						kind,
						columnId: key,
						index: Number(nth),
						...(kind === "property" ? { propertyId } : {}),
					},
	);
}

function receipt(
	edit: Pick<CellEdit, "state" | "next_offset" | "result_revision">,
) {
	return {
		state: edit.state,
		nextOffset: Number(edit.next_offset),
		...(edit.result_revision ? { tableRevision: edit.result_revision } : {}),
	};
}

/** The ambient editor (Project data, a live app, or a private design) supplies
 * its own verified grant identity and its already locked Project authority. */
export async function applyLookupValueEditInTransaction(
	tx: ValueTx,
	authority: LookupWriteAuthority,
	request: LookupValueEditRequest,
	grantBinding: string,
) {
	requireLookupCapability(tx, authority, "edit");
	if (!grantBinding) return unavailable();
	const { projectId, actorId } = authority;
	const { tableId, operationId } = request;
	const membership = await sql<{
		id: string;
		version: string;
	}>`SELECT id,xmin::text AS version FROM auth_member WHERE "organizationId"=${projectId} AND "userId"=${actorId}`.execute(
		tx,
	);
	if (!membership.rows[0]) return unavailable();
	const binding = canonicalJsonDigest([
		grantBinding,
		projectId,
		actorId,
		membership.rows[0].id,
		membership.rows[0].version,
	]);
	const object: BulkObject = {
		projectId,
		id: operationId,
		actorId,
		binding,
		kind: "cell",
	};
	await lockLookupProjectState(tx, authority);
	const current = await tx
		.selectFrom("lookup_tables")
		.selectAll()
		.where("project_id", "=", projectId)
		.where("id", "=", tableId)
		.executeTakeFirst();
	if (!current) return unavailable();
	const revision = lookupTableRevisions(current).tableRevision;
	await lockLookupTableForUpdate(tx, authority, tableId, revision, "author");
	const found =
		await sql<CellEdit>`SELECT *, expires_at>clock_timestamp() AS live FROM lookup_cell_edits
		WHERE project_id=${projectId} AND id=${operationId} AND actor_id=${actorId} AND table_id=${tableId} AND binding=${binding} FOR UPDATE`.execute(
			tx,
		);
	const edit = found.rows[0];
	if (request.kind === "begin") {
		const review = canonicalJsonDigest(request);
		if (edit) {
			if (
				edit.review_digest !== review ||
				(!edit.live && edit.state === "staging")
			)
				return conflict();
			return receipt(edit);
		}
		if (revision !== request.expectedTableRevision) return conflict();
		const meta = await valueMetadata(tx, { ...request, projectId });
		if (meta.digest !== request.baseDigest) return conflict();
		if (
			request.endByte < request.startByte ||
			request.endByte > Number(meta.total_bytes)
		)
			return invalidValue(
				"The replacement range is outside the reviewed value.",
			);
		// A one-byte lookahead at each review boundary catches a split character
		// before any upload is admitted (the final stream checks it again).
		for (const offset of new Set([request.startByte, request.endByte])) {
			if (offset < Number(meta.total_bytes)) {
				for await (const bytes of valueBytes(
					tx,
					{ ...request, projectId },
					meta,
					offset,
					offset + 1,
				)) {
					if ((bytes[0] & 0xc0) === 0x80)
						return invalidValue(
							"This edit splits a character. You can select a complete character.",
						);
				}
			}
		}
		await reclaimCellStorageBatch(tx, projectId);
		if (request.replacementBytes < request.endByte - request.startByte)
			await sql`SELECT set_config('nova.lookup_rewrite_project',${projectId},true)`.execute(
				tx,
			);
		const expires = new Date(Date.now() + 24 * 60 * 60 * 1000);
		await reserveBulkObject(tx, object, 0, expires);
		const inserted = await sql<CellEdit>`INSERT INTO lookup_cell_edits
			(project_id,table_id,id,actor_id,binding,review_digest,row_id,slot,expected_revision,base_digest,base_bytes,start_byte,end_byte,replacement_bytes,replacement_digest,state,expires_at)
			VALUES(${projectId},${tableId},${operationId},${actorId},${binding},${review},${request.rowId},${valueSlotPath(request.slot)}::text[],
			${revision},${meta.digest},${meta.total_bytes},${request.startByte},${request.endByte},${request.replacementBytes},${request.replacementDigest},'staging',${expires})
			ON CONFLICT DO NOTHING RETURNING *`.execute(tx);
		if (!inserted.rows[0]) return conflict();
		return receipt(inserted.rows[0]);
	}
	if (!edit) return unavailable();
	if (request.kind === "cancel") {
		if (edit.state !== "staging") return receipt(edit);
		await sql`UPDATE lookup_cell_edits SET state='cancelled' WHERE project_id=${projectId} AND id=${operationId}`.execute(
			tx,
		);
		await refundDeletedBulkObject(tx, object);
		return receipt({ ...edit, state: "cancelled" });
	}
	if (request.kind === "finish" && edit.state === "complete")
		return receipt(edit);
	if (
		edit.state !== "staging" ||
		!edit.live ||
		edit.expected_revision !== revision
	)
		return conflict();
	if (
		Number(edit.replacement_bytes) <
		Number(edit.end_byte) - Number(edit.start_byte)
	)
		await sql`SELECT set_config('nova.lookup_rewrite_project',${projectId},true)`.execute(
			tx,
		);
	if (request.kind === "append") {
		const body = Buffer.from(request.base64, "base64");
		if (
			!body.length ||
			body.length > VALUE_CHUNK_BYTES ||
			body.toString("base64") !== request.base64
		)
			return invalidValue(
				"This chunk needs canonical base64 encoding and at most 32 KiB of bytes.",
			);
		const next = Number(edit.next_offset);
		if (request.offset < next) {
			const prior =
				await sql`SELECT 1 FROM lookup_cell_inputs WHERE project_id=${projectId} AND operation_id=${operationId} AND byte_offset=${request.offset} AND body=${body}`.execute(
					tx,
				);
			if (!prior.rows.length) return conflict();
			return receipt(edit);
		}
		if (
			request.offset !== next ||
			next + body.length > Number(edit.replacement_bytes)
		)
			return invalidValue(
				"This chunk doesn't continue the reviewed replacement. You can resume at its next byte.",
			);
		await sql`INSERT INTO lookup_cell_inputs(project_id,operation_id,byte_offset,body) VALUES(${projectId},${operationId},${next},${body})`.execute(
			tx,
		);
		await sql`UPDATE lookup_cell_edits SET next_offset=next_offset+${body.length} WHERE project_id=${projectId} AND id=${operationId}`.execute(
			tx,
		);
		return receipt({ ...edit, next_offset: String(next + body.length) });
	}
	if (edit.next_offset !== edit.replacement_bytes)
		return invalidValue(
			"The replacement is missing bytes. You can continue uploading at the next offset.",
		);
	const target = {
		projectId,
		tableId,
		rowId: edit.row_id,
		slot: storedSlot(edit.slot),
	};
	const { column, path } = storagePath(target.slot);
	const next = await assembleValue(tx, target, edit);
	const accounting = async () =>
		Number(
			(
				await sql<{
					bytes: string;
				}>`SELECT (value_bytes+external_bytes)::text AS bytes FROM lookup_rows
		WHERE (project_id,table_id,id)=(${projectId},${tableId},${edit.row_id})`.execute(
					tx,
				)
			).rows[0].bytes,
		);
	const before = await accounting();
	await sql`DELETE FROM lookup_cell_value_refs WHERE (project_id,table_id,row_id,slot)=(${projectId},${tableId},${edit.row_id},${edit.slot}::text[])`.execute(
		tx,
	);
	if (next.id) {
		await sql`INSERT INTO lookup_cell_value_refs(project_id,table_id,row_id,slot,value_id,total_bytes,digest)
			VALUES(${projectId},${tableId},${edit.row_id},${edit.slot}::text[],${next.id},${next.total},${next.digest})`.execute(
			tx,
		);
	}
	await sql`UPDATE lookup_rows SET ${column}=jsonb_set(${column},${path}::text[],${JSON.stringify(next.value)}::jsonb,false),updated_at=now(),updated_by=${actorId}
		WHERE (project_id,table_id,id)=(${projectId},${tableId},${edit.row_id})`.execute(
		tx,
	);
	const delta = (await accounting()) - before;
	const published = await advanceLookupProjectRevision(tx, projectId);
	await sql`UPDATE lookup_tables SET data_bytes=data_bytes+${delta},rows_revision=${published},updated_by=${actorId},updated_at=now()
		WHERE project_id=${projectId} AND id=${tableId}`.execute(tx);
	await sql`UPDATE lookup_cell_edits SET state='complete',result_revision=${published} WHERE project_id=${projectId} AND id=${operationId}`.execute(
		tx,
	);
	await refundDeletedBulkObject(tx, object);
	await notifyCommittedLookupMutation(tx, projectId, published);
	return receipt({ ...edit, state: "complete", result_revision: published });
}
