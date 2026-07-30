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
}

export interface EditorLookupTableDecl {
	readonly id: LookupTableId;
	readonly name: string;
	readonly columns: readonly EditorLookupColumnDecl[];
}

/** The one row whose columns direct `table-column` terms may read. */
export interface EditorLookupTableScope {
	readonly tableId: LookupTableId;
	readonly columns: readonly EditorLookupColumnDecl[];
}

export function lookupColumnDisplayLabel(
	column: EditorLookupColumnDecl,
): string {
	const label = column.label.trim();
	return label.length > 0 ? label : column.wireName;
}
