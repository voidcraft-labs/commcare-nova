/** Every choice the after-submit surfaces offer, replayed through the
 * shared planners, the commit gate and the reducer: the add control's three
 * kinds over every target the picker offers (Start this form again first),
 * the otherwise chooser's built-ins, app home and links, Make this the
 * otherwise, Make this a destination, the rail's condition conversions,
 * removal and every move. A choice the surfaces show disabled is refused by
 * the planner with a sentence. Proves these local app transitions, not
 * native device execution. */

import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { assertAdmittedDoc } from "@/lib/doc/__tests__/admittedDoc";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import {
	afterSubmitPlan,
	type FormLinkCommitPlan,
	planFormLinkAdd,
	planFormLinkMove,
	planFormLinkRemove,
	planFormLinkUpdate,
	planMakeDestination,
	planMakeOtherwise,
	planSetOtherwise,
} from "@/lib/doc/formLinkMutations";
import {
	formLinkAddChoices,
	formLinkCarryVerdict,
	formLinkRequiredDatums,
	formLinkTargetVerdict,
} from "@/lib/doc/formLinkReview";
import { formLinkTargetChoices } from "@/lib/doc/formLinkTargetChoices";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { applyMutations } from "@/lib/doc/mutations";
import {
	type BlueprintDoc,
	type FormLink,
	type FormLinkTarget,
	type FormOtherwise,
	otherwiseDestinationsOffered,
	type Uuid,
} from "@/lib/domain";
import { eq, formField, literal } from "@/lib/domain/expression/builders";
import {
	formLinkRefusalReason,
	otherwiseUnavailableReason,
	planRefusal,
	submenuNotOfferedReason,
	targetRefusal,
} from "../refusalCopy";
import {
	retargetLink,
	seedConditionalLink,
	seedEveryTimeLink,
	seedOtherwiseLink,
} from "../seeds";
import {
	CARE,
	fixture,
	HOUSEHOLDS,
	INTAKE,
	type LinkSpec,
	SOURCE,
	toCare,
	toInspect,
	toNote,
	toVisit,
	VISIT,
	withoutCaseValueStarts,
} from "./fixture";

/** Replay an ok plan through the gate and the reducers; return the doc. */
function commit(doc: BlueprintDoc, plan: FormLinkCommitPlan): BlueprintDoc {
	assertAdmittedDoc(doc);
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
	const next = produce(doc, (draft) => {
		applyMutations(draft, [...plan.mutations]);
	});
	assertAdmittedDoc(next);
	return next;
}

/** The picker's ordered rows, as `LinkTargetPickerContent` lists them:
 *  Start this form again, then each menu (unless omitted) and its forms,
 *  each with the reason it is disabled, if it is. */
function pickerRows(
	doc: BlueprintDoc,
	source: Uuid,
	omitMenuUuid?: Uuid,
): { target: FormLinkTarget; reason: string | undefined }[] {
	const choices = formLinkTargetChoices(doc, source);
	const menuNameOf = (uuid: Uuid) =>
		choices.menus.find((menu) => menu.uuid === uuid)?.name;
	return [
		{
			target: choices.thisForm.target,
			reason: targetRefusal(choices.thisForm.verdict, menuNameOf),
		},
		...choices.menus.flatMap((menu) => [
			...(menu.uuid === omitMenuUuid
				? []
				: [
						{
							target: menu.target as FormLinkTarget,
							reason: menu.offered
								? targetRefusal(menu.verdict, menuNameOf)
								: submenuNotOfferedReason(
										menu.parentUuid === undefined
											? undefined
											: menuNameOf(menu.parentUuid),
									),
						},
					]),
			...menu.forms.map((form) => ({
				target: form.target as FormLinkTarget,
				reason: targetRefusal(form.verdict, menuNameOf),
			})),
		]),
	];
}

const offeredTargets = (doc: BlueprintDoc, source: Uuid, omit?: Uuid) =>
	pickerRows(doc, source, omit)
		.filter((row) => row.reason === undefined)
		.map((row) => row.target);

const seedFor = (doc: BlueprintDoc, source: Uuid, target: FormLinkTarget) => ({
	target,
	carry: formLinkCarryVerdict(doc, source, target),
	required: formLinkRequiredDatums(doc, source, target),
});

const withOtherwise = (doc: BlueprintDoc, otherwise: FormOtherwise) =>
	produce(doc, (draft) => {
		draft.forms[SOURCE].otherwise = otherwise;
	});

const linksOf = (doc: BlueprintDoc, form: Uuid = SOURCE): FormLink[] =>
	doc.forms[form]?.formLinks ?? [];

const menuNameIn = (doc: BlueprintDoc) => (uuid: Uuid) =>
	doc.modules[uuid]?.name;

describe("the target picker", () => {
	it("lists Start this form again first and offers it", () => {
		const doc = fixture();
		const rows = pickerRows(doc, SOURCE);
		expect(rows[0]).toEqual({
			target: { type: "this-form" },
			reason: undefined,
		});
	});

	it("disables a submenu CommCare HQ doesn't offer from here, naming its menu, and the planner refuses it", () => {
		const nested = produce(fixture(), (draft) => {
			draft.modules[CARE].parentModuleUuid = HOUSEHOLDS;
			draft.moduleOrder = [HOUSEHOLDS, CARE, INTAKE];
		});
		const row = pickerRows(nested, SOURCE).find(
			(candidate) =>
				candidate.target.type === "module" &&
				candidate.target.moduleUuid === CARE,
		);
		expect(row?.reason).toBe(
			"CommCare HQ can't link to this submenu from here. You can choose Households or a form inside it.",
		);
		const plan = planFormLinkAdd(
			nested,
			SOURCE,
			seedEveryTimeLink(seedFor(nested, SOURCE, toCare), testUuid("sub")),
		);
		expect(plan).toEqual({
			ok: false,
			reason: {
				kind: "target-not-offered",
				menuUuid: CARE,
				parentUuid: HOUSEHOLDS,
			},
		});
		if (plan.ok) throw new Error("refused above");
		expect(formLinkRefusalReason(plan.reason, menuNameIn(nested))).toBe(
			row?.reason,
		);
		// Its forms stay offered: HQ lists every form.
		expect(offeredTargets(nested, SOURCE)).toContainEqual(toVisit);
	});

	it("offers a form whose own links lead back here: cycles are admitted", () => {
		const looped = fixture([], {
			visitLinks: [
				{
					uuid: "lnk-back",
					target: { type: "form", moduleUuid: INTAKE, formUuid: SOURCE },
				},
			],
		});
		expect(offeredTargets(looped, SOURCE)).toContainEqual(toVisit);
		commit(
			looped,
			planFormLinkAdd(
				looped,
				SOURCE,
				seedEveryTimeLink(seedFor(looped, SOURCE, toVisit), testUuid("c")),
			),
		);
	});

	it("refuses the source form spelled as a form, pointing at Start this form again", () => {
		const doc = fixture();
		const verdict = formLinkTargetVerdict(doc, SOURCE, {
			type: "form",
			moduleUuid: INTAKE,
			formUuid: SOURCE,
		});
		expect(targetRefusal(verdict, menuNameIn(doc))).toBe(
			"A link can't name this form by itself. You can choose Start this form again instead.",
		);
	});
});

describe("every add choice over every offered target lands a valid app", () => {
	const shapes: {
		name: string;
		links: LinkSpec[];
		postSubmit?: "module" | "previous" | "app_home";
	}[] = [
		{ name: "a form without destinations", links: [] },
		{
			name: "a form without destinations that stores where it goes",
			links: [],
			postSubmit: "module",
		},
		{
			name: "a form with a destination that has a condition",
			links: [{ uuid: "lnk-1", condition: "1 = 1", target: toNote }],
		},
		{
			name: "a form with a destination that runs every time",
			links: [{ uuid: "lnk-1", target: toNote }],
		},
	];

	for (const shape of shapes) {
		for (const source of [SOURCE, VISIT]) {
			it(`${shape.name}, from ${source === SOURCE ? "the registration form" : "the follow-up form"}`, () => {
				const doc = fixture(source === SOURCE ? shape.links : [], {
					...(shape.postSubmit !== undefined &&
						source === SOURCE && { postSubmit: shape.postSubmit }),
					...(source === VISIT && { visitLinks: shape.links }),
				});
				const choices = formLinkAddChoices(doc, source);
				expect(choices.everyTime.ok && choices.conditional.ok).toBe(true);
				let offered = 0;
				for (const target of offeredTargets(doc, source)) {
					offered += 1;
					const seed = seedFor(doc, source, target);
					commit(
						doc,
						planFormLinkAdd(
							doc,
							source,
							seedEveryTimeLink(seed, testUuid(`e-${offered}`)),
						),
					);
					const conditional = commit(
						doc,
						planFormLinkAdd(
							doc,
							source,
							seedConditionalLink(seed, testUuid(`c-${offered}`)),
						),
					);
					// A conditional first destination makes the Otherwise offered.
					expect(afterSubmitPlan(conditional, source)?.otherwiseOffered).toBe(
						true,
					);
				}
				expect(offered).toBeGreaterThan(2);
			});
		}
	}

	it("moves a stored after-submit into the Otherwise, and says so", () => {
		const doc = fixture([], { postSubmit: "module" });
		const plan = planFormLinkAdd(
			doc,
			SOURCE,
			seedConditionalLink(seedFor(doc, SOURCE, toNote), testUuid("c")),
		);
		expect(plan.ok && plan.movedToOtherwise).toBe("module");
		const next = commit(doc, plan);
		expect(next.forms[SOURCE]?.otherwise).toEqual({
			kind: "destination",
			destination: "module",
		});
	});

	it("withholds a form that cannot receive the complete case selection, in words", () => {
		const multiple = produce(fixture(), (draft) => {
			const config = draft.modules[CARE]?.caseListConfig;
			if (config === undefined) throw new Error("fixture");
			config.selection = { kind: "multiple", maximum: 10 };
			// Choosing several cases runs in Web Apps alone.
			draft.appSettings.runsOnlyOn = "web-apps";
			withoutCaseValueStarts(draft, [VISIT]);
		});
		const row = pickerRows(multiple, VISIT).find(
			(candidate) =>
				candidate.target.type === "form" &&
				candidate.target.formUuid === toInspect.formUuid,
		);
		expect(row?.reason).toBe(
			"This form can't carry its complete case selection there. Open the destination's form list so the person can choose again.",
		);
		expect(
			planFormLinkAdd(
				multiple,
				VISIT,
				seedConditionalLink(
					seedFor(multiple, VISIT, toInspect),
					testUuid("incompatible-selection"),
				),
			),
		).toEqual({ ok: false, reason: { kind: "selection-cardinality" } });
	});

	it("seeds false() and a condition that reads the form is refused before the gate", () => {
		const doc = fixture();
		const link = seedConditionalLink(seedFor(doc, SOURCE, toNote));
		expect(link.condition).toStrictEqual({ kind: "match-none" });
		const answer = Object.values(doc.fields).find(
			(field) => field.id === "case_name",
		);
		if (answer === undefined) throw new Error("Fixture needs an answer");
		const verdict = mutationCommitVerdict(
			doc,
			[
				{
					kind: "addFormLink",
					formUuid: SOURCE,
					link: {
						...link,
						condition: eq(formField(answer.uuid), literal("x")),
					},
				},
			],
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(verdict.ok).toBe(false);
		if (verdict.ok) throw new Error("A closed form cannot supply answers");
		expect(verdict.findings.map((finding) => finding.code)).toContain(
			"INVALID_REF",
		);
	});
});

describe("the add control offers the Otherwise exactly when the planner admits it", () => {
	it("is refused while every destination runs every time, offered once one may not run, and refused once one is stored", () => {
		const everyTime = fixture([{ uuid: "lnk-1", target: toNote }]);
		expect(
			otherwiseUnavailableReason(formLinkAddChoices(everyTime, SOURCE)),
		).toBe(
			"Give a destination a condition first, so there is a time when none runs.",
		);
		expect(
			planSetOtherwise(everyTime, SOURCE, {
				kind: "destination",
				destination: "module",
			}),
		).toEqual({
			ok: false,
			reason: { kind: "otherwise-unreachable" },
		});

		const conditional = fixture([
			{ uuid: "lnk-1", condition: "1 = 1", target: toNote },
		]);
		expect(
			otherwiseUnavailableReason(formLinkAddChoices(conditional, SOURCE)),
		).toBeUndefined();

		const stored = withOtherwise(conditional, {
			kind: "destination",
			destination: "module",
		});
		expect(otherwiseUnavailableReason(formLinkAddChoices(stored, SOURCE))).toBe(
			"This form already has an Otherwise. You can change it in the last row.",
		);
	});
});

describe("every otherwise choice lands a valid app", () => {
	const base = fixture([
		{ uuid: "lnk-1", condition: "1 = 1", target: toNote },
		{ uuid: "lnk-2", target: toVisit },
	]);
	const linkOtherwise = withOtherwise(base, {
		kind: "link",
		uuid: testUuid("ow"),
		target: toCare,
	});

	for (const [name, doc] of [
		["with no Otherwise", base],
		[
			"with a built-in Otherwise",
			withOtherwise(base, { kind: "destination", destination: "module" }),
		],
		["with an otherwise link", linkOtherwise],
	] as const) {
		it(name, () => {
			const offered = otherwiseDestinationsOffered(doc, SOURCE);
			expect(offered.length).toBeGreaterThan(0);
			for (const destination of offered) {
				commit(
					doc,
					planSetOtherwise(doc, SOURCE, { kind: "destination", destination }),
				);
			}
			// The app home: no Otherwise.
			commit(doc, planSetOtherwise(doc, SOURCE, null));
			// Another form or module, leaving out the form's own menu where This
			// module is offered.
			const current = doc.forms[SOURCE]?.otherwise;
			const omit = offered.includes("module") ? INTAKE : undefined;
			let targets = 0;
			for (const target of offeredTargets(doc, SOURCE, omit)) {
				targets += 1;
				const seed = seedFor(doc, SOURCE, target);
				const next =
					current?.kind === "link"
						? retargetLink(current, seed)
						: seedOtherwiseLink(seed, testUuid(`ow-${targets}`));
				commit(doc, planSetOtherwise(doc, SOURCE, next));
			}
			expect(targets).toBeGreaterThan(2);
		});
	}

	it("refuses a built-in the form's menu doesn't offer, in words", () => {
		const plan = planSetOtherwise(base, SOURCE, {
			kind: "destination",
			destination: "parentMenu",
		});
		expect(plan.ok).toBe(false);
		expect(planRefusal(plan, menuNameIn(base))).toMatch(
			/^This form's menu doesn't offer Parent module after submit\./,
		);
	});
});

describe("the rail's conversions pass the gate where they are offered", () => {
	it("Make this the otherwise, offered by its refusals", () => {
		const doc = fixture([
			{ uuid: "lnk-1", condition: "1 = 1", target: toNote },
			{ uuid: "lnk-2", condition: "2 = 2", target: toVisit },
			{ uuid: "lnk-3", target: toCare },
		]);
		for (const link of linksOf(doc)) {
			commit(doc, planMakeOtherwise(doc, SOURCE, link.uuid));
		}
		// With one destination that may not run, it can't become the
		// Otherwise: nothing would be left that might not run.
		const single = fixture([
			{ uuid: "lnk-1", condition: "1 = 1", target: toNote },
			{ uuid: "lnk-2", target: toVisit },
		]);
		const [conditional, everyTime] = linksOf(single);
		if (conditional === undefined || everyTime === undefined)
			throw new Error("fixture");
		expect(
			planRefusal(
				planMakeOtherwise(single, SOURCE, conditional.uuid),
				menuNameIn(single),
			),
		).toBe(
			"Give a destination a condition first, so there is a time when none runs.",
		);
		const made = commit(
			single,
			planMakeOtherwise(single, SOURCE, everyTime.uuid),
		);
		// And once one is stored, the others are refused with its sentence.
		expect(
			planRefusal(
				planMakeOtherwise(made, SOURCE, conditional.uuid),
				menuNameIn(made),
			),
		).toBe("This form already has an Otherwise. You can change it instead.");
	});

	it("Make this a destination, on the otherwise link only", () => {
		const doc = withOtherwise(
			fixture([{ uuid: "lnk-1", condition: "1 = 1", target: toNote }]),
			{ kind: "link", uuid: testUuid("ow"), target: toVisit },
		);
		const next = commit(doc, planMakeDestination(doc, SOURCE));
		expect(linksOf(next).map((link) => link.uuid)).toContain(testUuid("ow"));
		expect(next.forms[SOURCE]?.otherwise).toBeUndefined();
		const builtIn = withOtherwise(
			fixture([{ uuid: "lnk-1", condition: "1 = 1", target: toNote }]),
			{ kind: "destination", destination: "module" },
		);
		expect(
			planRefusal(planMakeDestination(builtIn, SOURCE), menuNameIn(builtIn)),
		).toBe(
			"This form's Otherwise isn't a link, so there's no destination to make from it.",
		);
	});

	it("Run it every time drops an Otherwise nothing could reach, and says so", () => {
		const doc = withOtherwise(
			fixture([{ uuid: "lnk-1", condition: "1 = 1", target: toNote }]),
			{ kind: "destination", destination: "module" },
		);
		const [link] = linksOf(doc);
		if (link === undefined) throw new Error("fixture");
		const { condition: _dropped, ...everyTime } = link;
		const plan = planFormLinkUpdate(doc, SOURCE, everyTime, link);
		expect(plan.ok && plan.droppedOtherwise).toEqual({
			kind: "destination",
			destination: "module",
		});
		commit(doc, plan);
	});

	it("Give it a condition lands the false() seed", () => {
		const doc = fixture([{ uuid: "lnk-1", target: toNote }]);
		const [link] = linksOf(doc);
		if (link === undefined) throw new Error("fixture");
		commit(
			doc,
			planFormLinkUpdate(
				doc,
				SOURCE,
				{ ...link, condition: { kind: "match-none" } },
				link,
			),
		);
	});

	it("retargets reseed carried values in every direction", () => {
		const doc = fixture([
			{ uuid: "lnk-1", condition: "1 = 1", target: toVisit },
		]);
		const [link] = linksOf(doc);
		if (link === undefined) throw new Error("fixture");
		const toManual = retargetLink(link, seedFor(doc, SOURCE, toInspect));
		expect(toManual.datums?.map((datum) => datum.name)).toEqual(
			formLinkRequiredDatums(doc, SOURCE, toInspect).map((datum) => datum.name),
		);
		const manualDoc = commit(
			doc,
			planFormLinkUpdate(doc, SOURCE, toManual, link),
		);
		const [held] = linksOf(manualDoc);
		if (held === undefined) throw new Error("fixture");
		for (const target of [
			toNote,
			toVisit,
			toCare,
			{ type: "this-form" } as const,
		]) {
			commit(
				manualDoc,
				planFormLinkUpdate(
					manualDoc,
					SOURCE,
					retargetLink(held, seedFor(manualDoc, SOURCE, target)),
					held,
				),
			);
		}
	});
});

describe("removal and every move pass the gate", () => {
	it("removing each destination, including the last beside each Otherwise", () => {
		const doc = fixture([
			{ uuid: "lnk-1", condition: "1 = 1", target: toNote },
			{ uuid: "lnk-2", target: toVisit },
		]);
		for (const link of linksOf(doc)) {
			commit(doc, planFormLinkRemove(doc, SOURCE, link.uuid));
		}
		for (const otherwise of [
			{ kind: "destination", destination: "module" },
			{ kind: "link", uuid: testUuid("ow"), target: toCare },
		] as const) {
			const sole = withOtherwise(
				fixture([{ uuid: "lnk-1", condition: "1 = 1", target: toNote }]),
				otherwise,
			);
			const [link] = linksOf(sole);
			if (link === undefined) throw new Error("fixture");
			const plan = planFormLinkRemove(sole, SOURCE, link.uuid);
			expect(
				plan.ok &&
					(plan.otherwiseToPostSubmit !== undefined ||
						plan.otherwiseToDestination !== undefined),
			).toBe(true);
			commit(sole, plan);
		}
	});

	it("every destination moves to every position", () => {
		const doc = fixture([
			{ uuid: "lnk-1", condition: "1 = 1", target: toNote },
			{ uuid: "lnk-2", target: toVisit },
			{ uuid: "lnk-3", target: { type: "this-form" } },
		]);
		const links = linksOf(doc);
		for (const link of links) {
			for (let index = 0; index < links.length; index += 1) {
				commit(doc, planFormLinkMove(doc, SOURCE, link.uuid, index));
			}
		}
	});
});
