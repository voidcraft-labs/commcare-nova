import { expect } from "vitest";
import {
	type BlueprintDoc,
	datumRefKey,
	entryDatumSupplies,
} from "@/lib/domain";
import {
	advancedLoadTags,
	menuEmittedAdvanced,
} from "@/lib/domain/advancedEntryDatums";
import { advancedFormLoads } from "../advancedSelections";
import {
	entryDatumIds,
	formLinkProjectionContext,
} from "../formLinkProjection";

/** The two production boundaries must agree without sharing their derivation:
 * domain admission supplies identities; wire emission annotates actual datums.
 * Used by every admitted expander and compiler-fuzz document as well as the
 * focused session corpus. Sorting compares sets without discarding duplicates. */
export function expectEntryDatumAgreement(doc: BlueprintDoc): number {
	const context = formLinkProjectionContext(doc, { entryMetadataOnly: true });
	let entries = 0;
	for (const module of context.moduleOrder) {
		for (const form of context.formOrder[module] ?? []) {
			const point = { kind: "form" as const, module, form };
			const actual = entryDatumIds(doc, context, module, form).flatMap((row) =>
				row.refs.map((ref) => [datumRefKey(ref), row.scalar] as const),
			);
			const expected = entryDatumSupplies(doc, point).refs.map(
				({ ref, scalar }) => [datumRefKey(ref), scalar] as const,
			);
			const byIdentity = (
				a: readonly [string, boolean],
				b: readonly [string, boolean],
			) => a[0].localeCompare(b[0]);
			expect(
				actual.sort(byIdentity),
				`${doc.appName}: ${module}/${form}`,
			).toEqual(expected.sort(byIdentity));
			// The domain tags each load of an advanced form as the placement
			// planner does, so the datum it reads first is the one the entry
			// prints.
			if (menuEmittedAdvanced(doc, module))
				expect(
					advancedLoadTags(doc, form),
					`${doc.appName}: ${module}/${form} load tags`,
				).toEqual(advancedFormLoads(doc, form).map((load) => load.tag));
			entries++;
		}
	}
	return entries;
}
