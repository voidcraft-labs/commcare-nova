/**
 * A link into a menu whose forms read the search, carrying by hand the values
 * automatic matching would carry.
 *
 * Contract: Nova's emission writes such a link with no carried values and
 * with their held-case guards (`formLinkProjection.ts::projectManualSearchLink`),
 * and the reader reads it back carrying them, with no condition. A link that
 * carries nothing and whose condition is exactly those guards prints the same
 * link, and the canonical choice `search-link-guards-are-carried-values`
 * returns the one that carries them.
 *
 * Plausible failures: the guard read as the link's condition and the carried
 * value lost; a carried value read from a guard where the emission would write
 * it as a stored datum; the canonical row rewriting a condition the emission
 * prints differently.
 */
import { describe, expect, it } from "vitest";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { ensureReferenceIndex } from "@/lib/doc/referenceIndex";
import {
	type BlueprintDoc,
	blueprintDocSchema,
	type Expression,
	type FormLink,
	type Uuid,
} from "@/lib/domain";
import { slotContext } from "@/lib/domain/expression/context";
import { producerDocuments } from "@/proof/corpus/producers";
import { expandDoc } from "../../../expander";
import { withCandidate } from "../../candidate";
import { canonicalExpression } from "../../expressions/canonical";
import { searchLinkGuardsAreCarriedValues } from "../afterSubmit";
import { codesOf, readMenusOf } from "./menuReading";

/** The producer document whose end-of-form link carries the case it registers into a menu
 *  whose forms read the search. */
function searchLinkDoc(): BlueprintDoc {
	const document = producerDocuments().find(
		(one) => one.id === "search-hidden-link",
	);
	if (document === undefined)
		throw new Error("The corpus holds the document search-hidden-link.");
	const doc = hydratePersistedBlueprint(blueprintDocSchema.parse(document.doc));
	ensureReferenceIndex(doc);
	return doc;
}

/** The one form holding a link, and that link. */
function linkOf(doc: BlueprintDoc): { formUuid: Uuid; link: FormLink } {
	for (const [formUuid, form] of Object.entries(doc.forms)) {
		const [link] = form.formLinks ?? [];
		if (link !== undefined) return { formUuid: formUuid as Uuid, link };
	}
	throw new Error("The document holds a link.");
}

/** Every form's stored links as the HQ import file holds them. */
function storedLinks(doc: BlueprintDoc): unknown {
	return expandDoc(doc).modules.map((module) =>
		module.forms.map((form) => [
			form.post_form_workflow,
			form.post_form_workflow_fallback,
			form.form_links,
		]),
	);
}

/** `doc` with its link carrying nothing and holding, as its condition, the guard Nova writes
 *  for the value it carried: the case the form registers is on the device, of its type. */
function guardConditionOf(doc: BlueprintDoc): BlueprintDoc {
	const { formUuid, link } = linkOf(doc);
	const [carried] = link.datums ?? [];
	if (carried === undefined) throw new Error("The link carries a value.");
	const caseType =
		carried.name.kind === "selected-case"
			? (doc.modules[carried.name.module]?.caseType ?? "")
			: "";
	const guard: Expression = {
		kind: "gt",
		left: {
			kind: "count",
			via: {
				kind: "cases",
				source: "casedb",
				where: [
					{
						kind: "and",
						clauses: [
							{
								kind: "eq",
								left: {
									kind: "term",
									term: { kind: "prop", property: "case_id", caseType },
								},
								right: carried.xpath,
							},
							{
								kind: "eq",
								left: { kind: "term", term: { kind: "case-row-type" } },
								right: {
									kind: "term",
									term: { kind: "case-type", caseType },
								},
							},
						],
					},
				],
			},
		},
		right: { kind: "term", term: { kind: "literal", value: 0 } },
	} as Expression;
	return withCandidate(doc, (draft) => {
		const one = draft.forms[formUuid]?.formLinks?.[0];
		if (one === undefined) return;
		delete one.datums;
		one.condition = guard as typeof one.condition;
	});
}

describe("a link into a menu whose forms read the search", () => {
	it("reads back carrying the values its guards name, with no condition", async () => {
		const doc = searchLinkDoc();
		const reading = await readMenusOf(doc);
		expect(codesOf(reading)).toEqual([]);
		const read = reading.doc as BlueprintDoc;
		// The reading mints its own identities, so a carried value names its menu by name. The
		// stored value is taken as its canonical tree in its own slot, as every read-back is
		// judged: two values that print one datum read back as one.
		const carried = (of: BlueprintDoc, canonical: boolean) => {
			const { formUuid, link } = linkOf(of);
			return link.datums?.map((datum) => {
				const context = slotContext(
					of,
					{
						entity: "form",
						uuid: formUuid,
						slot: "form_link_datum_xpath",
						member: { linkUuid: link.uuid, datum: datum.name },
					},
					new Map(),
				);
				if (context === undefined)
					throw new Error("The link's carried value has a slot context.");
				return {
					menu:
						datum.name.kind === "selected-case"
							? of.modules[datum.name.module]?.name
							: undefined,
					xpath: canonical
						? canonicalExpression(datum.xpath, context)
						: datum.xpath,
				};
			});
		};
		expect(linkOf(read).link.condition).toBeUndefined();
		expect(carried(read, false)).toEqual(carried(doc, true));
		expect(carried(doc, false)).toHaveLength(1);
	});

	it("prints one link where it carries its values or holds their guards as its condition (search-link-guards-are-carried-values)", () => {
		const doc = searchLinkDoc();
		const guarded = guardConditionOf(doc);
		expect(storedLinks(guarded)).toEqual(storedLinks(doc));
		const canonical = linkOf(searchLinkGuardsAreCarriedValues(guarded)).link;
		expect(canonical.condition).toBeUndefined();
		expect(canonical.datums).toEqual(linkOf(doc).link.datums);
		// A document that already carries them is left as it is.
		expect(searchLinkGuardsAreCarriedValues(doc)).toBe(doc);
	});
});
