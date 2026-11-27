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

export function describeLookupCarrierAlternative(
	name: string,
	alternative: LookupCarrierAlternative,
) {
	return alternative.kind === "json"
		? `“${name}” needs an authenticated table installation. ${alternative.reason} You can review its destination and ownership in Project data.`
		: `“${name}” needs a verified table in its destination project space. ${alternative.reason} You can connect that table in Project data.`;
}
