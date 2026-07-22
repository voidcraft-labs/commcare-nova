import type { Transaction } from "kysely";
import type { AppDatabase } from "./pg";

/**
 * Read the rollout switch that decides whether holder nonce participates in
 * authority. Call only after locking the target app row: the compatibility
 * row is then held FOR SHARE through the write, preserving the repo's fixed
 * app-row-first lock order against the S02c2 cutover transaction.
 */
export async function readRunHolderNonceEnforcementForShare(
	tx: Transaction<AppDatabase>,
): Promise<boolean> {
	const row = await tx
		.selectFrom("lookup_reference_compatibility")
		.select("run_holder_nonce_enforced")
		.where("id", "=", 1)
		.forShare()
		.executeTakeFirst();
	if (!row) {
		throw new Error("Run-holder compatibility state is missing.");
	}
	return row.run_holder_nonce_enforced;
}
