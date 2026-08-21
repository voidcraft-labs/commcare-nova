/**
 * What an insertion gap offers on a form with (or without) sections.
 *
 * The field picker opens from a gap `{ parentUuid, atIndex }`. Three
 * contexts decide what that gap can do, and this pure helper answers for
 * all of them so the popup, its tooltip, and a test read one decision:
 *
 *   - **root of a sectioned form**: the gap is a page break. It offers
 *     ONE thing, a new section, and no question kinds: a question at the
 *     root of a sectioned form is refused by the gate, and the picker never
 *     offers what the gate refuses.
 *   - **root of a sectionless form**: the ordinary kinds plus "Split into
 *     sections here", which pages the whole form at this gap (at either
 *     end it makes one page holding everything).
 *   - **inside a section**: the ordinary kinds minus `section` plus
 *     "Split section here" (a new page starting at this gap), or, at the
 *     end of the page, "New section after this one".
 *   - **inside a group or repeat**: the ordinary kinds minus `section`;
 *     no page gesture, a page cannot start inside a box.
 *
 * Each gesture carries its planner call, so the popup only applies a
 * `FormSectionPlan` through `applyFormSectionPlan` and selects the page it
 * produced.
 */

import { orderedFieldUuids } from "@/lib/doc/fieldWalk";
import {
	addSection,
	type FormSectionPlan,
	splitIntoSections,
	splitSection,
} from "@/lib/doc/formSectionMutations";
import { formIsSectioned, formOfField } from "@/lib/doc/formSectionVerdicts";
import type { BlueprintDoc, Uuid } from "@/lib/domain";

export type InsertionContext =
	| "sectioned-root"
	| "sectionless-root"
	| "in-section"
	| "nested";

export interface SectionGestureItem {
	readonly key: "add-section" | "split-form" | "split-section";
	readonly label: string;
	/** Present when the gesture is shown but unavailable here, with why. */
	readonly disabledReason?: string;
	/** Build the plan against the CURRENT document (read at click time). */
	readonly plan: (doc: BlueprintDoc) => FormSectionPlan;
}

export interface SectionGestures {
	readonly context: InsertionContext;
	/** Whether the ordinary question kinds are offered at all. */
	readonly offersKinds: boolean;
	/** Whether `section` is among the offered kinds (never: a section is
	 *  always a gesture, so its placement is planned, not guessed). */
	readonly items: readonly SectionGestureItem[];
	/** What the gap's "+" names on hover. */
	readonly insertLabel: string;
}

/** Decide the gap's context from the document. */
export function insertionContext(
	doc: BlueprintDoc,
	parentUuid: Uuid,
): InsertionContext {
	if (doc.forms[parentUuid] !== undefined) {
		return formIsSectioned(doc, parentUuid)
			? "sectioned-root"
			: "sectionless-root";
	}
	return doc.fields[parentUuid]?.kind === "section" ? "in-section" : "nested";
}

export function sectionGestureItems(
	doc: BlueprintDoc,
	parentUuid: Uuid,
	atIndex: number,
): SectionGestures {
	const context = insertionContext(doc, parentUuid);
	const children = orderedFieldUuids(doc, parentUuid);

	switch (context) {
		case "sectioned-root": {
			const after = atIndex <= 0 ? null : (children[atIndex - 1] ?? null);
			return {
				context,
				offersKinds: false,
				insertLabel: "Add a section",
				items: [
					{
						key: "add-section",
						label: "Section",
						plan: (current) => addSection(current, parentUuid, { after }),
					},
				],
			};
		}
		case "sectionless-root": {
			const atEdge = atIndex <= 0 || atIndex >= children.length;
			const atFieldUuid = atEdge ? undefined : children[atIndex];
			return {
				context,
				offersKinds: true,
				insertLabel: "Insert field",
				items: [
					{
						key: "split-form",
						label: atEdge ? "Split into sections" : "Split into sections here",
						plan: (current) =>
							splitIntoSections(current, parentUuid, { atFieldUuid }),
					},
				],
			};
		}
		case "in-section": {
			const formUuid = formOfField(doc, parentUuid);
			if (atIndex <= 0) {
				return {
					context,
					offersKinds: true,
					insertLabel: "Insert field",
					items: [
						{
							key: "split-section",
							label: "Split section here",
							disabledReason: "Already the start of this section",
							plan: () => ({
								ok: false,
								reason: "Already the start of this section",
							}),
						},
					],
				};
			}
			if (atIndex >= children.length) {
				return {
					context,
					offersKinds: true,
					insertLabel: "Insert field",
					items: [
						{
							key: "add-section",
							label: "New section after this one",
							plan: (current) =>
								formUuid === undefined
									? { ok: false, reason: "This section isn't in a form." }
									: addSection(current, formUuid, { after: parentUuid }),
						},
					],
				};
			}
			const atFieldUuid = children[atIndex] as Uuid;
			return {
				context,
				offersKinds: true,
				insertLabel: "Insert field",
				items: [
					{
						key: "split-section",
						label: "Split section here",
						plan: (current) => splitSection(current, parentUuid, atFieldUuid),
					},
				],
			};
		}
		case "nested":
			return {
				context,
				offersKinds: true,
				insertLabel: "Insert field",
				items: [],
			};
	}
}
