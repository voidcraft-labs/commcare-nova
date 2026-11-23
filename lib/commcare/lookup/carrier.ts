import type { LookupTableDefinition } from "@/lib/lookup/types";

/** Eligibility for a different carrier is independent of the target ledger.
 * A direct destination must prove ownership and authority before writing. */
export type LookupCarrierAlternative =
	| { kind: "json"; reason: string }
	| { kind: "source-reference"; reason: string };

export function alternativeLookupCarrier(
	table: LookupTableDefinition,
	reason: string,
): LookupCarrierAlternative {
	const source = table.hq;
	if (
		table.workerAccess === "assigned" ||
		source?.source?.distribution === "assigned"
	)
		return {
			kind: "source-reference",
			reason: `${reason} Its assignments need the destination’s own verified table.`,
		};
	if (table.columns.some((column) => column.index !== undefined))
		return {
			kind: "source-reference",
			reason: `${reason} Its column indexes need verification in the destination.`,
		};
	if (
		source !== undefined &&
		(source.source?.inventory !== "complete" ||
			source.source.indexEvidence === "unobserved")
	)
		return {
			kind: "source-reference",
			reason:
				reason +
				" The source table’s complete contents and indexes need fresh verification.",
		};
	return { kind: "json", reason };
}

/**
 * What a person reads about a table its carrier cannot take. A table the JSON
 * resources can carry travels that way on a direct publish
 * (`lib/deployment/lookupJsonExecutor.ts`), which the HQ app file cannot do:
 * it holds no credentials and installs nothing itself, so for that file the
 * sentence names the direct publish. A direct publish sends through the JSON
 * resources only a table it holds whole in one snapshot, so a larger one is
 * named as what Nova can't carry yet.
 */
export function describeLookupCarrierAlternative(
	name: string,
	alternative: LookupCarrierAlternative,
	carriedBy: "file" | "direct",
) {
	if (alternative.kind === "source-reference")
		return `“${name}” needs a verified table in its destination project space. ${alternative.reason} You can connect that table in Project data.`;
	return carriedBy === "file"
		? `“${name}” can't travel in the HQ app file. ${alternative.reason} A direct publish to CommCare HQ from Nova carries it exactly, so you can publish there instead.`
		: `Nova can't carry “${name}” exactly to CommCare HQ yet: it is larger than Nova sends through CommCare HQ's table resources in one publish. ${alternative.reason} You can keep it smaller in Project data.`;
}
