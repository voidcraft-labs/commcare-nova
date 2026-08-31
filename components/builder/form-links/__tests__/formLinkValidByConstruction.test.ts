// components/builder/form-links/__tests__/formLinkValidByConstruction.test.ts
//
// The after-submit surface's headline invariant, stated once: everything
// the workspace OFFERS, the commit gate ACCEPTS. The candidates are the
// surface's own — the target picker's rows filtered by its own verdict,
// the add control's two intents, the seeds it lands, the rail's retarget
// and conversion, the reorder map the keyboard and the drag both read —
// and the oracle is `mutationCommitVerdict`, the same gate every dispatch
// runs through. A candidate the surface would not offer is skipped by the
// surface's own predicate, so this can only fail on a genuine
// offer-then-refuse.

import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { planKeyboardReorder } from "@/components/builder/shared/keyboardReorderPlan";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { parseXPathForForm } from "@/lib/doc/expressionText";
import {
	type FormLinkCommitPlan,
	planFormLinkAdd,
	planFormLinkUpdate,
} from "@/lib/doc/formLinkMutations";
import {
	formLinkAddChoices,
	formLinkCarryVerdict,
	formLinkManualCarryVerdict,
	formLinkMoveVerdicts,
	formLinkRequiredDatums,
	formLinkTargetVerdict,
} from "@/lib/doc/formLinkReview";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { applyMutations } from "@/lib/doc/mutations";
import type {
	BlueprintDoc,
	FormLink,
	FormLinkTarget,
	Uuid,
} from "@/lib/domain";
import { readsForm } from "../LinkConditionEditor";
import {
	moveRefusal,
	otherwiseUnavailableReason,
	targetRefusal,
} from "../refusalCopy";
import {
	retargetLink,
	SEED_CONDITION_TEXT,
	seedConditionalLink,
	seedOtherwiseLink,
} from "../seeds";
import {
	CARE,
	fixture,
	HOUSEHOLDS,
	INTAKE,
	SOURCE,
	toInspect,
	toNote,
	toVisit,
	VISIT,
} from "./fixture";

/** Replay an ok plan through the gate and the reducers; return the doc. */
function commit(doc: BlueprintDoc, plan: FormLinkCommitPlan): BlueprintDoc {
	if (!plan.ok) throw new Error(`refused: ${JSON.stringify(plan.reason)}`);
	const verdict = mutationCommitVerdict(
		doc,
		[...plan.mutations],
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	if (!verdict.ok) {
		throw new Error(
			`gate refused: ${verdict.findings.map((e) => e.code).join(", ")}`,
		);
	}
	return produce(doc, (draft) => {
		applyMutations(draft, [...plan.mutations]);
	});
}

/** Every destination the picker lists: each module, each of its forms. */
function pickerTargets(doc: BlueprintDoc): FormLinkTarget[] {
	return doc.moduleOrder.flatMap((moduleUuid) => [
		{ type: "module" as const, moduleUuid },
		...(doc.formOrder[moduleUuid] ?? []).map((formUuid) => ({
			type: "form" as const,
			moduleUuid,
			formUuid,
		})),
	]);
}

const seedFor = (doc: BlueprintDoc, source: Uuid, target: FormLinkTarget) => ({
	target,
	carry: formLinkCarryVerdict(doc, source, target),
	required: formLinkRequiredDatums(doc, source, target),
});

const parserFor = (doc: BlueprintDoc, source: Uuid) => (text: string) =>
	parseXPathForForm(doc, source, text);

describe("every destination the picker offers lands a link the gate accepts", () => {
	const doc = fixture();
	const nameOf = (uuid: Uuid) => doc.forms[uuid]?.name;

	it("reaches all three carry answers from one source form", () => {
		const kinds = new Set(
			pickerTargets(doc)
				.filter(
					(target) => formLinkTargetVerdict(doc, SOURCE, undefined, target).ok,
				)
				.map((target) => formLinkCarryVerdict(doc, SOURCE, target).kind),
		);
		expect([...kinds].sort()).toEqual([
			"automatic",
			"manual-required",
			"nothing-needed",
		]);
	});

	for (const source of [SOURCE, VISIT]) {
		it(`from ${source === SOURCE ? "the registration form" : "the follow-up form"}: conditional and otherwise seeds both pass`, () => {
			const parse = parserFor(doc, source);
			let offered = 0;
			for (const target of pickerTargets(doc)) {
				const verdict = formLinkTargetVerdict(doc, source, undefined, target);
				// The picker's own predicate: a refused row is disabled with its
				// reason, and never chosen.
				if (!verdict.ok) {
					expect(targetRefusal(verdict, nameOf)).toEqual(expect.any(String));
					continue;
				}
				expect(targetRefusal(verdict, nameOf)).toBeUndefined();
				offered += 1;
				const seed = seedFor(doc, source, target);
				const conditional = seedConditionalLink(
					seed,
					parse,
					testUuid(`c-${offered}`),
				);
				commit(doc, planFormLinkAdd(doc, source, conditional));
				const otherwise = seedOtherwiseLink(
					seed,
					parse,
					testUuid(`o-${offered}`),
				);
				commit(doc, planFormLinkAdd(doc, source, otherwise));
			}
			expect(offered).toBeGreaterThan(0);
		});
	}

	it("refuses the source form itself and says so", () => {
		const self = {
			type: "form",
			moduleUuid: doc.moduleOrder[0],
			formUuid: SOURCE,
		} as const;
		const verdict = formLinkTargetVerdict(doc, SOURCE, undefined, self);
		expect(verdict.ok).toBe(false);
		expect(targetRefusal(verdict, nameOf)).toBe(
			"This form can't send the person straight back into itself.",
		);
	});

	it("withholds a manual-required destination when a collection cannot be split into explicit values", () => {
		const nested = produce(doc, (draft) => {
			const source = draft.modules[INTAKE]?.caseListConfig;
			const target = draft.modules[CARE]?.caseListConfig;
			if (source === undefined || target === undefined) {
				throw new Error("fixture");
			}
			source.selection = { kind: "multiple", maximum: 10 };
			target.selection = { kind: "multiple", maximum: 10 };
			draft.forms[SOURCE].type = "followup";
			draft.modules[CARE].parentModuleUuid = HOUSEHOLDS;
			draft.moduleOrder = [HOUSEHOLDS, CARE, INTAKE];
			for (const formUuid of [SOURCE, VISIT]) {
				for (const fieldUuid of draft.fieldOrder[formUuid] ?? []) {
					const field = draft.fields[fieldUuid];
					if (field !== undefined && "caseWrite" in field) {
						delete field.caseWrite;
					}
				}
			}
		});

		expect(formLinkCarryVerdict(nested, SOURCE, toVisit)).toEqual({
			kind: "manual-required",
			datumIds: ["case_id"],
		});
		const manualVerdict = formLinkManualCarryVerdict(
			nested,
			SOURCE,
			testUuid("prospective-nested-link"),
			toVisit,
		);
		expect(manualVerdict).toMatchObject({
			ok: false,
			reason: "selection-cardinality",
		});
		expect(formLinkTargetVerdict(nested, SOURCE, undefined, toVisit)).toEqual(
			manualVerdict,
		);

		const parse = parserFor(nested, SOURCE);
		let offered = 0;
		for (const target of pickerTargets(nested)) {
			if (!formLinkTargetVerdict(nested, SOURCE, undefined, target).ok)
				continue;
			offered += 1;
			const seed = seedFor(nested, SOURCE, target);
			commit(
				nested,
				planFormLinkAdd(
					nested,
					SOURCE,
					seedConditionalLink(seed, parse, testUuid(`nested-c-${offered}`)),
				),
			);
			commit(
				nested,
				planFormLinkAdd(
					nested,
					SOURCE,
					seedOtherwiseLink(seed, parse, testUuid(`nested-o-${offered}`)),
				),
			);
		}
		expect(offered).toBeGreaterThan(0);
	});

	it("explains why a form that changes selected case types cannot carry the collection", () => {
		expect(
			targetRefusal(
				{
					ok: false,
					reason: "selection-case-type",
					expectedCaseType: "patient",
					possibleFinalCaseTypes: ["patient", "visit"],
				},
				nameOf,
			),
		).toBe(
			"This form can change the selected cases' type before they get there. Open the destination's form list so the person can choose matching cases, or keep every selected case as “patient”.",
		);
	});

	it("names the chain for a destination whose links lead back here", () => {
		const looped = fixture([], {
			visitLinks: [
				{
					uuid: "lnk-back",
					target: {
						type: "form",
						moduleUuid: looped_intake(),
						formUuid: SOURCE,
					},
				},
			],
		});
		const verdict = formLinkTargetVerdict(looped, SOURCE, undefined, toVisit);
		expect(verdict.ok).toBe(false);
		expect(targetRefusal(verdict, (uuid) => looped.forms[uuid]?.name)).toBe(
			"Going there would lead back here: “Visit” → this form.",
		);
	});

	it("withholds a form that cannot receive the complete case selection", () => {
		const multiple = produce(doc, (draft) => {
			const config = draft.modules[CARE]?.caseListConfig;
			if (config === undefined) throw new Error("fixture");
			config.selection = { kind: "multiple", maximum: 10 };
		});
		const verdict = formLinkTargetVerdict(
			multiple,
			VISIT,
			undefined,
			toInspect,
		);

		expect(verdict).toMatchObject({
			ok: false,
			reason: "selection-cardinality",
			sourceCardinality: "multiple",
			targetCardinality: "single",
		});
		expect(targetRefusal(verdict, nameOf)).toBe(
			"This form can't carry its complete case selection there. Open the destination's form list so the person can choose again.",
		);
		const link = seedConditionalLink(
			seedFor(multiple, VISIT, toInspect),
			parserFor(multiple, VISIT),
			testUuid("incompatible-selection"),
		);
		expect(planFormLinkAdd(multiple, VISIT, link)).toEqual({
			ok: false,
			reason: { kind: "selection-cardinality" },
		});
	});
});

function looped_intake(): Uuid {
	return testUuid("mod-intake");
}

describe("a conditional seed never fires until edited, and never reads the form", () => {
	it("seeds false() and a link that reads the form is refused before the gate", () => {
		const doc = fixture();
		const parse = parserFor(doc, SOURCE);
		const link = seedConditionalLink(seedFor(doc, SOURCE, toNote), parse);
		expect(link.condition).toEqual(parse(SEED_CONDITION_TEXT));
		expect(readsForm(parse("#form/case_name = 'x'"))).toBe(true);
		expect(readsForm(parse("/data/case_name = 'x'"))).toBe(true);
		expect(readsForm(parse("#patient/mood = 'good'"))).toBe(false);
		expect(readsForm(parse("#user/username = 'a'"))).toBe(false);
	});
});

describe("the add control offers the otherwise intent exactly when the planner admits it", () => {
	it("is on offer without an otherwise link and refused with one", () => {
		const parse = parserFor(fixture(), SOURCE);
		const bare = fixture([
			{ uuid: "lnk-1", condition: "1 = 1", target: toNote },
		]);
		expect(
			otherwiseUnavailableReason(formLinkAddChoices(bare, SOURCE)),
		).toBeUndefined();
		// The offered seed lands.
		commit(
			bare,
			planFormLinkAdd(
				bare,
				SOURCE,
				seedOtherwiseLink(seedFor(bare, SOURCE, toVisit), parse, testUuid("o")),
			),
		);
		const withElse = fixture([
			{ uuid: "lnk-1", condition: "1 = 1", target: toNote },
			{ uuid: "lnk-else", target: toVisit },
		]);
		expect(
			otherwiseUnavailableReason(formLinkAddChoices(withElse, SOURCE)),
		).toEqual(expect.any(String));
		expect(
			planFormLinkAdd(
				withElse,
				SOURCE,
				seedOtherwiseLink(
					seedFor(withElse, SOURCE, toNote),
					parse,
					testUuid("o2"),
				),
			).ok,
		).toBe(false);
	});
});

describe("the rail's retarget reseeds carried values for the new destination", () => {
	it("passes the gate in every direction", () => {
		const doc = fixture([
			{ uuid: "lnk-1", condition: "1 = 1", target: toVisit },
		]);
		const parse = parserFor(doc, SOURCE);
		const link = doc.forms[SOURCE]?.formLinks?.[0] as FormLink;
		// automatic → manual-required: seeded values appear.
		const toManual = retargetLink(link, seedFor(doc, SOURCE, toInspect), parse);
		expect(toManual.datums?.map((d) => d.name)).toEqual(
			formLinkRequiredDatums(doc, SOURCE, toInspect).map((d) => d.id),
		);
		const manualDoc = commit(
			doc,
			planFormLinkUpdate(doc, SOURCE, toManual, link),
		);
		// manual-required → nothing-needed: values dropped.
		const held = manualDoc.forms[SOURCE]?.formLinks?.[0] as FormLink;
		const toNothing = retargetLink(
			held,
			seedFor(manualDoc, SOURCE, toNote),
			parse,
		);
		expect(toNothing.datums).toBeUndefined();
		commit(manualDoc, planFormLinkUpdate(manualDoc, SOURCE, toNothing, held));
		// nothing-needed → automatic: still nothing stored.
		const toAuto = retargetLink(
			held,
			seedFor(manualDoc, SOURCE, toVisit),
			parse,
		);
		expect(toAuto.datums).toBeUndefined();
		commit(manualDoc, planFormLinkUpdate(manualDoc, SOURCE, toAuto, held));
	});
});

describe("the rail's conversions pass the gate where they are offered", () => {
	it("the last conditional link becomes the otherwise link", () => {
		const doc = fixture([
			{ uuid: "lnk-1", condition: "1 = 1", target: toNote },
			{ uuid: "lnk-2", condition: "2 = 2", target: toVisit },
		]);
		const last = doc.forms[SOURCE]?.formLinks?.[1] as FormLink;
		const { condition: _c, ...rest } = last;
		commit(doc, planFormLinkUpdate(doc, SOURCE, rest, last));
	});

	it("the otherwise link takes a condition, pinning the fallback", () => {
		const doc = fixture([
			{ uuid: "lnk-1", condition: "1 = 1", target: toNote },
			{ uuid: "lnk-else", target: toVisit },
		]);
		const parse = parserFor(doc, SOURCE);
		const elseLink = doc.forms[SOURCE]?.formLinks?.[1] as FormLink;
		const plan = planFormLinkUpdate(
			doc,
			SOURCE,
			{ ...elseLink, condition: parse(SEED_CONDITION_TEXT) },
			elseLink,
		);
		expect(plan.ok && plan.pinsFallback).toBe("app_home");
		commit(doc, plan);
	});
});

describe("keyboard and drag read one move map", () => {
	it("the keyboard refuses exactly the positions the map refuses, with the map's reason", () => {
		const doc = fixture([
			{ uuid: "lnk-1", condition: "1 = 1", target: toNote },
			{ uuid: "lnk-2", condition: "2 = 2", target: toVisit },
			{
				uuid: "lnk-else",
				target: toInspect,
				datums: [{ name: "case_id", xpath: "''" }],
			},
		]);
		const links = doc.forms[SOURCE]?.formLinks ?? [];
		const reorderable = links.slice(0, -1);
		const order = reorderable.map((link) => link.uuid);
		for (const [index, link] of reorderable.entries()) {
			const verdicts = formLinkMoveVerdicts(doc, SOURCE, link.uuid);
			for (const key of ["ArrowUp", "ArrowDown", "Home", "End"] as const) {
				const outcome = planKeyboardReorder({
					order,
					index,
					key,
					verdicts,
					name: "link",
					refusalOf: moveRefusal,
				});
				if (outcome?.kind !== "move") continue;
				expect(verdicts.get(outcome.toIndex)?.ok).not.toBe(false);
			}
			// Every refused position has a sentence; every available one has none.
			for (const [position, verdict] of verdicts) {
				expect(moveRefusal(verdict) === undefined).toBe(verdict.ok);
				expect(position).toBeLessThan(links.length);
			}
		}
	});
});
