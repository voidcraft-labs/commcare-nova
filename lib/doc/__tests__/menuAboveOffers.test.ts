/**
 * Every place the builder offers a choice around a menu that shows its
 * forms in the menu above, held to the commit gate: what a picker offers
 * lands, and what it shows disabled the gate refuses. The offering sites are
 * the link target picker's choices (`formLinkTargetChoices`), the
 * after-submit and otherwise choosers' built-in destinations
 * (`postSubmitDestinationChoices`, `menuAboveWithheldDestinations`) and the
 * entry point controls' disabled reasons (`entryPointDestinations`). Each is
 * the production reader over documents built by `buildDoc`, judged by
 * `mutationCommitVerdict`.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { planEntryPointAdd } from "@/lib/doc/entryPointMutations";
import { entryPointDestinations } from "@/lib/doc/entryPointReview";
import {
	formLinkTargetChoices,
	menuAboveWithheldDestinations,
} from "@/lib/doc/formLinkTargetChoices";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { Mutation } from "@/lib/doc/types";
import {
	type BlueprintDoc,
	type FormLinkTarget,
	type PostSubmitDestination,
	postSubmitDestinationChoices,
	suggestEntryPointId,
	type Uuid,
} from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { assertAdmittedDoc } from "./admittedDoc";

const HOUSEHOLDS = testUuid("offers-households");
const MEMBERS = testUuid("offers-members");
const REGISTER = testUuid("offers-register");
const VISIT = testUuid("offers-visit");
const CHECK = testUuid("offers-check");

function registration() {
	return {
		uuid: "offers-register",
		name: "Register household",
		type: "registration" as const,
		fields: [
			f({
				kind: "text",
				id: "case_name",
				label: proseText("Name"),
				caseWrite: { caseType: "household", property: "case_name" },
			}),
		],
	};
}

/** A household menu with a registration and a follow-up, a submenu that
 *  shows its follow-up on the household screen, and a survey menu. With
 *  `householdsAbove` the household menu shows its forms on the app's first
 *  menu too, where its registration keeps the first menu sharing no case;
 *  without `withRegistration` every form listed there opens one case. With
 *  `membersAbove` false the submenu keeps its screen. */
function app(
	householdsAbove = false,
	withRegistration = true,
	membersAbove = true,
): BlueprintDoc {
	const doc = buildDoc({
		caseTypes: [{ name: "household", properties: [] }],
		modules: [
			{
				uuid: "offers-households",
				name: "Households",
				caseType: "household",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					...(withRegistration ? [registration()] : []),
					{
						uuid: "offers-visit",
						name: "Visit household",
						type: "followup",
						fields: [f({ kind: "text", id: "note", label: proseText("Note") })],
					},
				],
			},
			{
				uuid: "offers-members",
				name: "Members",
				caseType: "household",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: "offers-check",
						name: "Check members",
						type: "followup",
						fields: [f({ kind: "text", id: "note", label: proseText("Note") })],
					},
				],
			},
			{
				uuid: "offers-reports",
				name: "Reports",
				forms: [
					{
						uuid: "offers-weekly",
						name: "Weekly report",
						type: "survey",
						fields: [f({ kind: "text", id: "note", label: proseText("Note") })],
					},
				],
			},
		],
	});
	doc.modules[MEMBERS].parentModuleUuid = HOUSEHOLDS;
	if (membersAbove) doc.modules[MEMBERS].formsInMenuAbove = true;
	if (householdsAbove) doc.modules[HOUSEHOLDS].formsInMenuAbove = true;
	assertAdmittedDoc(doc);
	return doc;
}

function gate(doc: BlueprintDoc, mutations: readonly Mutation[]) {
	return mutationCommitVerdict(doc, [...mutations], LOOKUP_CONTEXT_UNAVAILABLE);
}

function linkTo(source: Uuid, target: FormLinkTarget, key: string): Mutation {
	return {
		kind: "addFormLink",
		formUuid: source,
		link: { uuid: testUuid(`offers-link-${key}`), target },
	};
}

function goTo(formUuid: Uuid, destination: PostSubmitDestination): Mutation {
	return {
		kind: "updateForm",
		uuid: formUuid,
		patch: { postSubmit: destination },
	};
}

describe("offers around a menu that shows its forms in the menu above", () => {
	for (const householdsAbove of [false, true]) {
		const shape = householdsAbove
			? "under a parent that shows its forms above too"
			: "under a parent that keeps its screen";
		it(`lands every link target the picker offers, and refuses every menu it shows disabled, ${shape}`, () => {
			const doc = app(householdsAbove);
			/* A follow-up carries its case, so every case form it targets can
			 * open with it. */
			const choices = formLinkTargetChoices(doc, VISIT);
			const members = choices.menus.find((menu) => menu.uuid === MEMBERS);
			expect(members).toMatchObject({
				offered: false,
				reason: "forms-in-menu-above",
			});
			let admitted = 0;
			for (const menu of choices.menus) {
				const verdict = gate(doc, [linkTo(VISIT, menu.target, menu.uuid)]);
				if (menu.offered && menu.verdict.ok) {
					expect(verdict.ok, menu.name).toBe(true);
					admitted += 1;
				} else expect(verdict.ok, menu.name).toBe(false);
				for (const form of menu.forms) {
					if (!form.verdict.ok) continue;
					expect(
						gate(doc, [linkTo(VISIT, form.target, form.uuid)]).ok,
						form.name,
					).toBe(true);
					admitted += 1;
				}
			}
			/* The submenu's own form stays a destination. */
			expect(
				members?.forms.find((form) => form.uuid === CHECK)?.verdict.ok,
			).toBe(true);
			expect(admitted).toBeGreaterThan(2);
		});

		it(`lands every built-in destination offered after submit, and refuses each one shown disabled, ${shape}`, () => {
			const doc = app(householdsAbove);
			for (const formUuid of [REGISTER, VISIT, CHECK]) {
				const offered = postSubmitDestinationChoices(doc, formUuid);
				for (const destination of offered)
					expect(
						gate(doc, [goTo(formUuid, destination)]).ok,
						`${formUuid} ${destination}`,
					).toBe(true);
				for (const withheld of menuAboveWithheldDestinations(doc, formUuid)) {
					expect(offered).not.toContain(withheld.destination);
					expect(
						gate(doc, [goTo(formUuid, withheld.destination)]).ok,
						`${formUuid} ${withheld.destination}`,
					).toBe(false);
				}
			}
			expect(
				menuAboveWithheldDestinations(doc, CHECK).map(
					(withheld) => withheld.destination,
				),
			).toContain("module");
			if (householdsAbove)
				expect(menuAboveWithheldDestinations(doc, VISIT)).toEqual([
					{ destination: "module", reason: "menu-forms-in-menu-above" },
					{ destination: "previous", reason: "menu-forms-on-first-menu" },
				]);
			else expect(menuAboveWithheldDestinations(doc, VISIT)).toEqual([]);
		});

		it(`lands every entry point the builder offers, and refuses each one it shows disabled, ${shape}`, () => {
			const doc = app(householdsAbove);
			const destinations = entryPointDestinations(doc);
			let admitted = 0;
			for (const destination of destinations) {
				const plan = planEntryPointAdd(doc, destination.target, {
					uuid: testUuid(`offers-entry-${destination.label}`),
					id: suggestEntryPointId(doc, destination.target),
				});
				const landed = plan.ok && gate(doc, [...plan.mutations]).ok;
				if (destination.issue === undefined) {
					expect(landed, destination.label).toBe(true);
					admitted += 1;
				} else expect(landed, destination.label).toBe(false);
			}
			/* The submenu shown above has no screen for its own entry point,
			 * and its form keeps one. */
			const members = destinations.filter(
				(destination) => destination.target.moduleUuid === MEMBERS,
			);
			const ofKind = (kind: string) =>
				members.find((destination) => destination.target.kind === kind);
			expect(ofKind("module")?.issue).toContain(
				"shows its forms in the menu above",
			);
			expect(ofKind("case-list")?.issue).toContain(
				"shows its forms in the menu above",
			);
			expect(ofKind("form")?.issue).toBeUndefined();
			expect(admitted).toBeGreaterThan(2);
		});
	}

	it("refuses the module destination a submenu's screen opens with the first menu's shared case, as the chooser shows it", () => {
		const doc = app(true, false, false);
		const offered = postSubmitDestinationChoices(doc, CHECK);
		expect(offered).not.toContain("module");
		for (const destination of offered)
			expect(gate(doc, [goTo(CHECK, destination)]).ok, destination).toBe(true);
		const withheld = menuAboveWithheldDestinations(doc, CHECK);
		expect(withheld).toContainEqual({
			destination: "module",
			reason: "menu-opens-with-first-menu-case",
		});
		for (const { destination } of withheld)
			expect(gate(doc, [goTo(CHECK, destination)]).ok, destination).toBe(false);
	});

	it("refuses an entry point the first menu's shared case would open, as the builder shows it", () => {
		const doc = app(true, false);
		const destinations = entryPointDestinations(doc);
		let refusedShared = 0;
		for (const destination of destinations) {
			const plan = planEntryPointAdd(doc, destination.target, {
				uuid: testUuid(`offers-shared-entry-${destination.label}`),
				id: suggestEntryPointId(doc, destination.target),
			});
			const landed = plan.ok && gate(doc, [...plan.mutations]).ok;
			expect(landed, destination.label).toBe(destination.issue === undefined);
			if (destination.issue?.includes("CommCare would keep that case"))
				refusedShared += 1;
		}
		expect(refusedShared).toBeGreaterThan(0);
	});
});
