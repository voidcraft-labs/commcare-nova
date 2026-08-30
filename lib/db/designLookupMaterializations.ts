import type { Transaction } from "kysely";
import type { AppDatabase } from "./pg";

/**
 * Release the temporary destructive-governance edges for a design session.
 * The immutable materialization receipt and accepted Project data remain;
 * only the short-lived pre-genesis protection is removed.
 */
export async function releaseDesignLookupProtectionsInTransaction(
	tx: Transaction<AppDatabase>,
	designSessionId: string,
): Promise<void> {
	await tx
		.deleteFrom("design_lookup_protections")
		.where(
			"materialization_id",
			"in",
			tx
				.selectFrom("design_lookup_materializations")
				.select("id")
				.where("design_session_id", "=", designSessionId),
		)
		.execute();
}
