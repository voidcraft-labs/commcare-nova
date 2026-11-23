import { type RawBuilder, sql, type Transaction } from "kysely";
import type { AppDatabase } from "@/lib/db/pg";
import type { LookupRowId, LookupTableId } from "@/lib/domain/lookupIds";
import { validateLookupRowValues } from "./coercion";
import { LOOKUP_MAX_CHANGE_BYTES, LOOKUP_MAX_ROW_BYTES } from "./constants";
import { LookupError } from "./errors";
import {
	applyPatchToExternalRefs,
	dropRowExternalRefs,
} from "./largeValues/projection";
import type {
	LookupColumn,
	LookupMember,
	LookupRowContent,
	LookupRowPatch,
	LookupRowValues,
	LookupScope,
} from "./types";

/** Patch one row using only its addressed projection; a large unedited
 * sibling's text never crosses the database boundary. Caller holds the
 * exact table revision throughout the ordered batch. */
export async function patchLookupRowInTransaction(
	tx: Transaction<AppDatabase>,
	scope: LookupScope,
	tableId: LookupTableId,
	rowId: LookupRowId,
	columns: readonly LookupColumn[],
	attributes: readonly LookupMember[],
	changes: readonly LookupRowPatch[],
): Promise<{ changed: boolean; delta: number }> {
	if (
		Buffer.byteLength(JSON.stringify(changes), "utf8") > LOOKUP_MAX_CHANGE_BYTES
	)
		throw new LookupError(
			"storage_limit",
			"This edit is too large for one request. You can change its values in parts.",
		);
	const before = await tx
		.selectFrom("lookup_rows")
		.select(["value_bytes", "external_bytes"])
		.where("project_id", "=", scope.projectId)
		.where("table_id", "=", tableId)
		.where("id", "=", rowId)
		.executeTakeFirst();
	if (!before)
		throw new LookupError(
			"not_found",
			"The selected row no longer belongs to this table.",
		);
	const initialBytes = before.value_bytes + Number(before.external_bytes);
	let bytes = initialBytes;
	let changed = false;
	const byId = new Map(columns.map((column) => [column.id, column]));
	const address = sql`project_id=${scope.projectId} AND table_id=${tableId}::uuid AND id=${rowId}::uuid`;
	for (const change of changes) {
		let target = sql.ref("content");
		let next: RawBuilder<unknown>;
		if (change.kind === "attribute") {
			if (!attributes.some((member) => member.id === change.attributeId))
				throw new LookupError(
					"invalid_input",
					"This row detail no longer belongs to the table.",
				);
			next = sql`jsonb_set(content, ARRAY['attributes',${change.attributeId}::text], to_jsonb(${change.text}::text))`;
		} else {
			const column = byId.get(change.columnId);
			if (!column)
				throw new LookupError(
					"invalid_input",
					"This column no longer belongs to the table.",
				);
			if (change.kind === "cell") {
				if (column.repeated)
					throw new LookupError(
						"invalid_input",
						"This column needs an ordered list of values.",
					);
				const result = validateLookupRowValues(
					[column],
					change.value === null ? {} : { [column.id]: change.value },
				);
				if (!result.success)
					throw new LookupError(
						"invalid_input",
						"This value does not match the column type.",
						{
							details: result.issues,
							totalDetailCount: result.totalIssueCount,
						},
					);
				target = sql.ref("values");
				next =
					change.value === null
						? sql`"values" - ${column.id}::text`
						: sql`"values" || ${JSON.stringify(result.values)}::jsonb`;
			} else {
				if (!column.repeated)
					throw new LookupError(
						"invalid_input",
						"This change needs a repeated column.",
					);
				const root = sql`coalesce(content->'occurrences','{}'::jsonb)`;
				const list = sql`coalesce(content->'occurrences'->${column.id}::text,'[]'::jsonb)`;
				const props = new Set<string>(
					column.properties?.map((member) => member.id),
				);
				let updatedList: RawBuilder<unknown>;
				if (change.kind === "list") {
					updatedList = change.present ? sql`'[]'::jsonb` : sql`NULL::jsonb`;
				} else {
					const length = (
						await sql<{
							n: number;
						}>`SELECT jsonb_array_length(${list}) AS n FROM lookup_rows WHERE ${address}`.execute(
							tx,
						)
					).rows[0].n;
					if (
						change.index > length ||
						(change.index === length && change.kind !== "insert")
					)
						throw new LookupError(
							"invalid_input",
							"This value is outside the current list. You can refresh the row.",
						);
					const nth = String(change.index);
					if (change.kind === "insert") {
						if (
							Object.keys(change.value.properties).some(
								(key) => !props.has(key),
							)
						)
							throw new LookupError(
								"invalid_input",
								"A value detail no longer belongs to this column.",
							);
						updatedList = sql`jsonb_insert(${list},ARRAY[${nth}::text],${JSON.stringify(change.value)}::jsonb)`;
					} else if (change.kind === "remove")
						updatedList = sql`${list} - ${change.index}::integer`;
					else if (change.kind === "occurrence")
						updatedList = sql`jsonb_set(${list},ARRAY[${nth}::text,'text'],to_jsonb(${change.text}::text))`;
					else {
						if (!props.has(change.propertyId))
							throw new LookupError(
								"invalid_input",
								"This value detail no longer belongs to this column.",
							);
						const path = sql`ARRAY[${nth}::text,'properties',${change.propertyId}::text]`;
						updatedList =
							change.text === null
								? sql`${list} #- ${path}`
								: sql`jsonb_set(${list},${path},to_jsonb(${change.text}::text))`;
					}
				}
				if (change.kind === "list" && !change.present)
					next = sql`CASE WHEN ${root} - ${column.id}::text = '{}'::jsonb THEN content-'occurrences'
					ELSE content #- ARRAY['occurrences',${column.id}::text] END`;
				else
					next = sql`jsonb_set(content,'{occurrences}',jsonb_set(${root},ARRAY[${column.id}::text],${updatedList}))`;
			}
		}
		const refChanged = await applyPatchToExternalRefs(
			tx,
			scope.projectId,
			tableId,
			rowId,
			change,
		);
		const written = await sql<{
			value_bytes: number;
			external_bytes: string;
		}>`UPDATE lookup_rows SET ${target}=${next},updated_by=${scope.actorId},updated_at=now()
			WHERE ${address} AND (${refChanged} OR ${target} IS DISTINCT FROM ${next}) RETURNING value_bytes,external_bytes`.execute(
			tx,
		);
		if (written.rows[0]) {
			changed = true;
			bytes =
				written.rows[0].value_bytes + Number(written.rows[0].external_bytes);
		}
	}
	return { delta: bytes - initialBytes, changed };
}

/** Replace the supplied projections on one row without returning its old
 * values. Omitting rich content preserves its bytes and all of its references. */
export async function replaceLookupRowInTransaction(
	tx: Transaction<AppDatabase>,
	scope: LookupScope,
	tableId: LookupTableId,
	rowId: LookupRowId,
	values: LookupRowValues,
	content: LookupRowContent | undefined,
) {
	const address = sql`project_id=${scope.projectId} AND table_id=${tableId}::uuid AND id=${rowId}::uuid`;
	const before = (
		await sql<{
			bytes: string;
		}>`SELECT (value_bytes+external_bytes)::text AS bytes FROM lookup_rows WHERE ${address}`.execute(
			tx,
		)
	).rows[0];
	if (!before)
		throw new LookupError(
			"not_found",
			"The selected row no longer belongs to this table.",
		);
	const cells = sql`${JSON.stringify(values)}::jsonb`;
	const body =
		content === undefined
			? sql.ref("content")
			: sql`${JSON.stringify(content)}::jsonb`;
	const dropped = await dropRowExternalRefs(
		tx,
		scope.projectId,
		tableId,
		rowId,
		content !== undefined,
	);
	const written = (
		await sql<{
			bytes: string;
			edit_bytes: number;
		}>`UPDATE lookup_rows SET "values"=${cells},content=${body},updated_at=now(),updated_by=${scope.actorId}
		WHERE ${address} AND (${dropped} OR "values" IS DISTINCT FROM ${cells} OR content IS DISTINCT FROM ${body})
		RETURNING (value_bytes+external_bytes)::text AS bytes,
			${content === undefined ? sql`octet_length("values"::text)` : sql.ref("value_bytes")} AS edit_bytes`.execute(
			tx,
		)
	).rows[0];
	if (!written) return { changed: false, delta: 0 };
	if (written.edit_bytes > LOOKUP_MAX_ROW_BYTES)
		throw new LookupError(
			"storage_limit",
			"This replacement is too large for one edit. You can change individual values instead.",
		);
	return { changed: true, delta: Number(written.bytes) - Number(before.bytes) };
}
