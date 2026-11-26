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
 * sentence names the direct publish (`file`). A direct publish keeps a table
 * the Project already put on its project space by a workbook in a workbook
 * (`workbook-there`), since the JSON resources cannot take over rows that
 * carry no Nova identity; a new export tag makes it a new table there. The workbook-only or over-budget
 * cases name the file's own delivery boundary.
 */
export function describeLookupCarrierAlternative(
	name: string,
	alternative: LookupCarrierAlternative,
	carriedBy: "file" | "workbook-there" | "too-large",
) {
	if (alternative.kind === "source-reference")
		return `“${name}” needs a verified table in its destination project space. ${alternative.reason} You can connect that table in Project data.`;
	switch (carriedBy) {
		case "file":
			return `“${name}” can't travel in the HQ app file. ${alternative.reason} A direct publish to CommCare HQ from Nova carries it exactly, so you can publish there instead.`;
		case "workbook-there":
			return `“${name}” is on this project space through a workbook, which can't carry its rows exactly any more. ${alternative.reason} You can change those rows in Project data, or give the table a new export tag so it goes there as a new table.`;
		case "too-large":
			return `“${name}” can't travel in this HQ app file. ${alternative.reason} You can publish supported paged tables directly from Nova, or prepare the table in the destination project space.`;
	}
}
