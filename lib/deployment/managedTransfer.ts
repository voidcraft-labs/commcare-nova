import "server-only";
import { decrypt } from "@/lib/commcare/encryption";
import { readGlobalGenerationTransferWitness } from "@/lib/commcare/hq/lookupCoverage";
import { listHqLookupTables } from "@/lib/commcare/hq/lookupTables";
import { withAppTx } from "@/lib/db/pg";
import { resolveHqTarget } from "@/lib/db/settings";
import { LookupError } from "@/lib/lookup/errors";
import { lookupStorageRefusal } from "@/lib/lookup/generations/budget";
import {
	type InventoryAccess,
	sourceChanged,
} from "@/lib/lookup/generations/scope";
import { transferGeneration } from "@/lib/lookup/generations/transfer";
import {
	type ManagedTableReview,
	takeOverManagedLookupTableInTransaction,
} from "@/lib/lookup/managed";
import { RUNTIME_CAPABILITIES } from "@/lib/runtimeCapabilities";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";

import { withSourceBulkRead } from "./sourceReadBudget";

export async function transferManagedGeneration(
	access: InventoryAccess,
	review: ManagedTableReview,
) {
	return withSourceBulkRead(async (signal) => {
		try {
			const initial = await withAppTx((tx) => transferGeneration(tx, access));
			const { origin, evidence } = initial;
			const target = await resolveHqTarget(access.scope.actorId, origin.domain);
			if (
				!target.ok ||
				target.server !== origin.server ||
				target.username !== initial.username ||
				target.connectionEpoch !== initial.connectionEpoch
			)
				return sourceChanged();
			const creds = {
				server: target.server,
				username: target.username,
				apiKey: await decrypt(target.encryptedApiKey),
			};
			const tables = await listHqLookupTables(creds, origin.domain, {
				cancel: signal,
			});
			if ("success" in tables)
				throw new LookupError(
					"managed_in_hq",
					"Nova could not read the source table. You can check its project-space connection and retry.",
				);
			const table = tables.find(
				(t) => t.id === origin.remoteId && t.tag === initial.tag,
			);
			if (!table?.isGlobal) return sourceChanged();
			const binding = canonicalJsonDigest(evidence);
			const witness = await readGlobalGenerationTransferWitness(
				creds,
				origin.domain,
				table,
				{
					binding,
					expected: evidence,
					cancel: signal,
					maxRequests: 250_000,
					maxBytes: 64 * 1024 ** 3,
					deadlineMs: Math.max(
						1000,
						(RUNTIME_CAPABILITIES.cloudRunRequestSeconds - 30) * 1000,
					),
					authorizePage: async () => {
						const current = await withAppTx((tx) =>
							transferGeneration(tx, access),
						);
						if (canonicalJsonDigest(current.evidence) !== binding)
							return sourceChanged();
					},
				},
			);
			if ("success" in witness)
				throw new LookupError(
					"managed_in_hq",
					witness.cause === "moved"
						? "The source changed since this inventory was recorded. You can refresh the inventory before transferring the table."
						: "Nova could not verify the full global table and its index settings. You can check the source connection and refresh the inventory.",
				);
			await withAppTx(async (tx) => {
				const current = await transferGeneration(tx, access);
				if (canonicalJsonDigest(current.evidence) !== binding)
					return sourceChanged();
				await takeOverManagedLookupTableInTransaction(
					tx,
					current.authority,
					access.tableId,
					review,
					new Date(),
					{
						sourceDigest: evidence.sourceDigest,
						indexedFields: witness.indexedFields,
						generation: { access, evidence },
					},
				);
			});
		} catch (error) {
			throw lookupStorageRefusal(error) ?? error;
		}
	});
}
