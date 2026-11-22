import { z } from "zod";
import type { LookupManifestHqOrigin } from "./types";

/** Inventory read by an editor and distribution to a worker are independent. */
export const lookupSourceFactsSchema = z.strictObject({
	inventory: z.enum(["complete", "unavailable"]),
	distribution: z.enum(["global", "assigned"]),
	storage: z.literal("generation").optional(),
	indexEvidence: z.enum(["unobserved", "workbook", "restore"]),
});
export type LookupSourceFacts = z.infer<typeof lookupSourceFactsSchema>;

/** Legacy managed copies could be born only from a complete global inventory.
 * New restricted or unreadable sources always carry explicit facts. */
export function requiresLookupProjection(
	hq: LookupManifestHqOrigin | undefined,
) {
	return (
		hq?.managedBy === "commcare-hq" &&
		hq.source !== undefined &&
		(hq.source.storage === "generation" ||
			hq.source.inventory !== "complete" ||
			hq.source.distribution === "assigned")
	);
}

export function workerLookupUnavailable(name: string) {
	return `“${name}” needs current data for this worker. You can reconnect to its project space and refresh the worker's data in Project data.`;
}

/** Historical inline rows remain in storage across an unreadable refresh or
 * a promotion. Only the current source may be inspected as current inventory. */
export function inlineLookupInventoryAvailable(
	hq: LookupManifestHqOrigin | undefined,
) {
	return (
		hq?.managedBy !== "commcare-hq" ||
		(hq.source?.inventory !== "unavailable" &&
			hq.source?.storage !== "generation")
	);
}
