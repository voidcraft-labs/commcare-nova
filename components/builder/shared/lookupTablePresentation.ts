import type { LookupRead } from "@/lib/domain/lookupRead";
import type { LookupMember } from "@/lib/lookup/types";
// Identity-backed lookup vocabulary presented by the shared expression editor.
//
// Stored AST leaves keep table/column UUIDs. Editors receive this rows-free
// projection so menus can show author names while the checker resolves the
// immutable identities and scalar types from the same definition snapshot.

import type {
	CasePropertyDataType,
	LookupColumnId,
	LookupTableId,
} from "@/lib/domain";

export interface EditorLookupColumnDecl {
	readonly id: LookupColumnId;
	readonly wireName: string;
	readonly label: string;
	readonly dataType: CasePropertyDataType;
	readonly repeated?: true;
	readonly properties?: readonly LookupMember[];
}

export interface EditorLookupTableDecl {
	readonly id: LookupTableId;
	readonly name: string;
	readonly columns: readonly EditorLookupColumnDecl[];
	readonly attributes?: readonly LookupMember[];
}

/** The one row whose columns direct `table-column` terms may read. */
export interface EditorLookupTableScope {
	readonly tableId: LookupTableId;
	readonly columns: readonly EditorLookupColumnDecl[];
	readonly attributes?: readonly LookupMember[];
}

export function lookupColumnDisplayLabel(
	column: EditorLookupColumnDecl,
): string {
	const label = column.label.trim();
	return label.length > 0 ? label : column.wireName;
}

/** Scalar choices available from one row. A repeated column starts at its
 * first occurrence; the picker can change its position and detail filter. */
export function editorLookupReads(
	table: Pick<EditorLookupTableDecl, "columns" | "attributes"> | undefined,
) {
	const reads: {
		id: LookupRead;
		label: string;
		wireName: string;
		dataType: CasePropertyDataType;
	}[] = [];
	if (!table) return reads;
	for (const column of table.columns)
		reads.push({
			...column,
			id: column.repeated ? { columnId: column.id, occurrence: 1 } : column.id,
		});
	for (const attribute of table.attributes ?? [])
		reads.push({
			...attribute,
			id: { attributeId: attribute.id },
			dataType: "text",
		});
	return reads;
}
