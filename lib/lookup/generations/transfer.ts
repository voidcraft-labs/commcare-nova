import "server-only";
import { sql, type Transaction } from "kysely";
import type { AppDatabase } from "@/lib/db/pg";
import { managedCanonicalSchema } from "../managedRules";
import {
	type InventoryAccess,
	lockInventoryScope,
	sourceChanged,
} from "./scope";

/** Exact local counterpart of the native transfer observation. Recheck after
 * streaming the source and after laying out the editable rows and value refs. */
export async function transferGeneration(
	tx: Transaction<AppDatabase>,
	access: InventoryAccess,
	distribution: "global" | "assigned" = "global",
) {
	const {
		table,
		scopeDigest,
		revision,
		origin,
		connectionEpoch,
		username,
		authority,
	} = await lockInventoryScope(tx, access, "transfer");
	const canonical = managedCanonicalSchema.parse(table.hq_canonical);
	if (
		!table.active_generation_id ||
		canonical.source?.storage !== "generation" ||
		canonical.source.inventory !== "complete" ||
		canonical.source.distribution !== distribution
	)
		return sourceChanged();
	const result = await sql<{
		through_digest: string;
		definition_digest: string;
		next_ordinal: string;
	}>`SELECT through_digest,definition_digest,next_ordinal
        FROM lookup_generations WHERE project_id=${access.scope.projectId} AND table_id=${access.tableId} AND id=${table.active_generation_id}
        AND state='complete' AND scope_digest=${scopeDigest} FOR SHARE`.execute(
		tx,
	);
	const gen = result.rows[0];
	if (!gen || Number(gen.next_ordinal) !== table.row_count)
		return sourceChanged();
	return {
		authority,
		tag: table.tag,
		origin,
		connectionEpoch,
		username,
		evidence: {
			generationId: table.active_generation_id,
			throughDigest: gen.through_digest,
			definitionDigest: gen.definition_digest,
			count: table.row_count,
			scopeDigest,
			revision,
			sourceDigest: canonical.digest,
		},
	};
}
export type TransferGenerationEvidence = Awaited<
	ReturnType<typeof transferGeneration>
>["evidence"];
