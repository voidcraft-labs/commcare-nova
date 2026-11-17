/**
 * A whole-document pass (the validator run, the emission plan, the HQ JSON
 * with every form's source) remembers structural answers by settled document
 * parts (`lib/domain/settled.ts`): which menus list a form, what each menu
 * screen lists, the case types the modules name, the emission plan. Over the
 * documents the oracle corpora draw, a settled copy must give every answer an
 * open copy gives, and a draft written between two questions must get the
 * draft's answers, never the settled document's it was made from.
 *
 * The open and the settled copy are each a `structuredClone` of the draw, so
 * freezing is the one difference between them. The membership oracle is the
 * scan each fast path replaced (`structuralScans.ts`).
 */
import * as fc from "fast-check";
import { current, freeze, produce } from "immer";
import { describe, expect, it } from "vitest";
import { emissionPlan } from "@/lib/commcare/emissionPlan";
import { expandDoc } from "@/lib/commcare/expander";
import { runValidation } from "@/lib/commcare/validator/runner";
import { rebuildFieldParent } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	expectScreensAgree,
	scan,
} from "@/lib/domain/__tests__/structuralScans";
import { caseSlotFacts } from "@/lib/domain/basicCaseSlots";
import type { BlueprintDoc } from "@/lib/domain/blueprint";
import {
	firstModuleListingForm,
	firstOrderedModuleListingForm,
	firstSortedModuleListingForm,
	modulesListingForm,
} from "@/lib/domain/formMembership";
import { operationCaseType, orderedCaseOperations } from "@/lib/domain/forms";
import { moduleUuidOfForm } from "@/lib/domain/postSubmit";
import type { Uuid } from "@/lib/domain/uuid";
import { advancedDocArbitrary } from "./advancedDocArbitrary";
import { manifestFor } from "./compilerEvidence";
import { menuScreenDocArbitrary } from "./menuScreenDocArbitrary";
import { suiteDocArbitrary } from "./suiteDocArbitrary";
import { blueprintDocArbitrary } from "./xformDocArbitrary";

function outcome<T>(run: () => T): { value: T } | { threw: string } {
	try {
		return { value: run() };
	} catch (error) {
		return { threw: error instanceof Error ? error.message : String(error) };
	}
}

/** The plan with its maps as plain entries, for comparison. */
function planOf(doc: BlueprintDoc) {
	const plan = emissionPlan(doc);
	return {
		doc: {
			modules: plan.doc.modules,
			moduleOrder: plan.doc.moduleOrder,
			formOrder: plan.doc.formOrder,
		},
		synthetic: [...plan.synthetic],
		caseListRegistrationOf: [...plan.caseListRegistrationOf],
	};
}

/** Every per-form lookup of `doc` answers as the scan over `oracle` does. */
function expectFormLookupsAgree(doc: BlueprintDoc, oracle: BlueprintDoc) {
	for (const formUuid of Object.keys(oracle.forms) as Uuid[]) {
		expect(firstModuleListingForm(doc.formOrder, formUuid)).toBe(
			scan.first(oracle.formOrder, formUuid),
		);
		expect([...modulesListingForm(doc.formOrder, formUuid)]).toEqual(
			scan.all(oracle.formOrder, formUuid),
		);
		expect(firstSortedModuleListingForm(doc.formOrder, formUuid)).toBe(
			scan.sorted(oracle.formOrder, formUuid),
		);
		expect(firstOrderedModuleListingForm(doc, formUuid)).toBe(
			scan.ordered(oracle, formUuid),
		);
		expect(moduleUuidOfForm(doc, formUuid)).toBe(
			scan.first(oracle.formOrder, formUuid),
		);
		const form = doc.forms[formUuid];
		if (form === undefined) continue;
		for (const operation of orderedCaseOperations(form)) {
			const owner = scan.first(oracle.formOrder, formUuid);
			expect(operationCaseType(doc, formUuid, operation)).toBe(
				operation.action === "own"
					? owner === undefined
						? undefined
						: oracle.modules[owner as Uuid]?.caseType
					: operation.caseType,
			);
		}
		expect([...caseSlotFacts(doc, formUuid).moduleCaseTypes].sort()).toEqual(
			[
				...new Set(
					Object.values(oracle.modules).flatMap((mod) =>
						mod.caseType ? [mod.caseType] : [],
					),
				),
			].sort(),
		);
	}
}

/** A write that moves the first listed form of the first menu listing one
 *  to the last menu, and gives that menu another case type. */
function rearrange(draft: BlueprintDoc): void {
	const from = draft.moduleOrder.find(
		(moduleUuid) => (draft.formOrder[moduleUuid]?.length ?? 0) > 0,
	);
	const to = draft.moduleOrder[draft.moduleOrder.length - 1];
	if (from === undefined || to === undefined || from === to) return;
	const [formUuid] = draft.formOrder[from] ?? [];
	if (formUuid === undefined) return;
	draft.formOrder[from]?.splice(0, 1);
	draft.formOrder[to]?.push(formUuid);
	const mod = draft.modules[to];
	if (mod !== undefined) mod.caseType = `${mod.caseType ?? "case"}_moved`;
}

const corpora: readonly [string, fc.Arbitrary<BlueprintDoc>, number][] = [
	["workflow", suiteDocArbitrary, 30],
	["menu screens", menuScreenDocArbitrary, 30],
	["advanced menus", advancedDocArbitrary, 15],
	["form fields", blueprintDocArbitrary, 30],
];

describe("a whole-document pass over a settled document", () => {
	it.each(corpora)(
		"answers over a settled %s document as over its open copy, and a draft's own after a write",
		async (_name, arbitrary, numRuns) => {
			await fc.assert(
				fc.property(arbitrary, (draw) => {
					rebuildFieldParent(draw);
					const open = structuredClone(draw);
					const settled = freeze(structuredClone(draw), true);

					expectFormLookupsAgree(settled, open);
					expectFormLookupsAgree(settled, open);
					expectScreensAgree(settled, open);

					expect(planOf(settled)).toEqual(planOf(open));
					expect(emissionPlan(settled)).toBe(emissionPlan(settled));

					expect(
						outcome(() => runValidation(settled, LOOKUP_CONTEXT_UNAVAILABLE)),
					).toEqual(
						outcome(() => runValidation(open, LOOKUP_CONTEXT_UNAVAILABLE)),
					);
					expect(
						outcome(() => expandDoc(settled, { assets: manifestFor(settled) })),
					).toEqual(
						outcome(() => expandDoc(open, { assets: manifestFor(open) })),
					);

					produce(settled, (draft) => {
						const doc = draft as unknown as BlueprintDoc;
						expectFormLookupsAgree(doc, current(draft) as BlueprintDoc);
						expectScreensAgree(doc, current(draft) as BlueprintDoc);
						rearrange(doc);
						const written = current(draft) as BlueprintDoc;
						expectFormLookupsAgree(doc, written);
						expectScreensAgree(doc, written);
						expect(planOf(doc)).toEqual(planOf(written));
						expect(
							outcome(() => runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)),
						).toEqual(
							outcome(() => runValidation(written, LOOKUP_CONTEXT_UNAVAILABLE)),
						);
					});
				}),
				{ numRuns, seed: 20261119 },
			);
		},
		60_000,
	);
});
