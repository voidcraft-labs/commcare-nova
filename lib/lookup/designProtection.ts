import type { Transaction } from "kysely";
import type { AppDatabase } from "@/lib/db/pg";
import type { LookupColumnId, LookupTableId } from "@/lib/domain/lookupIds";

export async function hasLookupDesignProtection(
	tx: Transaction<AppDatabase>,
	projectId: string,
	tableId: LookupTableId,
	columnId?: LookupColumnId,
): Promise<boolean> {
	const protection = await tx
		.selectFrom("design_lookup_protections")
		.select("id")
		.where("project_id", "=", projectId)
		.where("table_id", "=", tableId)
		.$if(columnId !== undefined, (query) =>
			query.where((eb) =>
				eb.or([
					eb("column_id", "is", null),
					eb("column_id", "=", columnId as LookupColumnId),
				]),
			),
		)
		.executeTakeFirst();
	return protection !== undefined;
}
