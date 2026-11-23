import type { Transaction } from "kysely";
import type { AppDatabase } from "@/lib/db/pg";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import { LookupError } from "./errors";
import {
	type LookupWriteAuthority,
	lookupReceiptCapability,
	requireLookupCapability,
} from "./writerTransaction";

type LocalReceipt =
	| {
			groupId: import("@/lib/domain/uuid").Uuid;
			projectRevision: import("./types").LookupRevision;
	  }
	| import("./types").LookupMutationReceipt
	| import("./types").LookupAuthoringBatchReceipt;

/** Caller owns both the actor's transactional Project membership and the
 * Project state lock. The receipt and its write commit atomically; an exact
 * retry returns before a stale expected table revision is considered. */
export async function lookupEditOnce<T extends LocalReceipt>(
	tx: Transaction<AppDatabase>,
	scope: LookupWriteAuthority,
	operationId: string | undefined,
	kind: string,
	input: unknown,
	apply: () => Promise<T>,
): Promise<T> {
	if (operationId === undefined) return apply();
	const digest = canonicalJsonDigest({ kind, input });
	const prior = await lookupPriorReceipt<T>(tx, scope, operationId, digest);
	if (prior) return prior;
	const receipt = await apply();
	await tx
		.insertInto("lookup_project_edit_receipts")
		.values({
			project_id: scope.projectId,
			actor_id: scope.actorId,
			operation_id: operationId,
			digest,
			required_capability: lookupReceiptCapability(scope),
			receipt: JSON.stringify(receipt),
		})
		.execute();
	return receipt;
}

export async function lookupPriorReceipt<T extends LocalReceipt>(
	tx: Transaction<AppDatabase>,
	scope: LookupWriteAuthority,
	operationId: string,
	digest: string,
): Promise<T | undefined> {
	const prior = await tx
		.selectFrom("lookup_project_edit_receipts")
		.select(["digest", "receipt", "required_capability"])
		.where("project_id", "=", scope.projectId)
		.where("actor_id", "=", scope.actorId)
		.where("operation_id", "=", operationId)
		.executeTakeFirst();
	if (prior) {
		requireLookupCapability(tx, scope, prior.required_capability);
		if (prior.digest !== digest)
			throw new LookupError(
				"invalid_input",
				"That operation already saved a different edit. You can start a new change.",
			);
		// Both the caller's kind and its validated input own this stored shape.
		return prior.receipt as T;
	}
	return undefined;
}
