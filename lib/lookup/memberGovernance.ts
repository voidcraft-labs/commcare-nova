import type { Transaction } from "kysely";
import { readLookupReferencingApps } from "@/lib/db/lookupReferenceEdges";
import type { AppDatabase } from "@/lib/db/pg";
import type {
	LookupColumnId,
	LookupMemberId,
	LookupTableId,
} from "@/lib/domain/lookupIds";
import { LookupError } from "./errors";
import type { LookupReaderReview, LookupRevision } from "./types";

/** A legacy accepted design protects its entire table or its selected
 * column. Current applications hold the exact detail they read, including
 * apps in the trash. Both sets are checked under the parent's write lock. */
export async function assertMemberRemovable(
	tx: Transaction<AppDatabase>,
	projectId: string,
	tableId: LookupTableId,
	columnId: LookupColumnId | null,
	memberId: LookupMemberId,
) {
	let query = tx
		.selectFrom("design_lookup_protections")
		.select("id")
		.where("project_id", "=", projectId)
		.where("table_id", "=", tableId);
	query =
		columnId === null
			? query.where("column_id", "is", null)
			: query.where((eb) =>
					eb.or([eb("column_id", "is", null), eb("column_id", "=", columnId)]),
				);
	if (await query.executeTakeFirst())
		throw new LookupError(
			"accepted_design",
			"An accepted design uses this detail. You can finish or update its design first.",
		);
	const blockingApps = await readLookupReferencingApps(tx, {
		projectId,
		tableId,
		memberId,
	});
	if (blockingApps.length)
		throw new LookupError(
			"referenced",
			"An app still uses this detail. You can change its reference first.",
			{ blockingApps },
		);
}

export async function holdLookupReaderReview(
	tx: Transaction<AppDatabase>,
	projectId: string,
	tableId: LookupTableId,
	projectRevision: LookupRevision,
	reviewed?: LookupReaderReview,
) {
	const readers = await readLookupReferencingApps(tx, { projectId, tableId });
	if (!readers.length && reviewed === undefined) return;
	const readerIds = readers.map((app) => app.appId).sort();
	const supplied = reviewed?.readerAppIds.slice().sort();
	if (
		reviewed?.projectRevision !== projectRevision ||
		supplied?.length !== readerIds.length ||
		readerIds.some((id, index) => supplied?.[index] !== id)
	)
		throw new LookupError(
			"conflict",
			"The apps using this table need a fresh review. You can check the affected apps and confirm the change.",
			{ blockingApps: readers },
		);
}
