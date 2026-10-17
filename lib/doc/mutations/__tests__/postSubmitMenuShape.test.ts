/**
 * The after-submit reconciliation that rides a change of menu shape
 * (`mutations/modules.ts::reconcilePostSubmitWithMenuShape`): Search first,
 * the selection mode, `hiddenFromMenu`, the module's parent, the form's
 * module, and whether the form holds links each change what a form is
 * offered or what its absent slot means, so the five reducer arms that
 * change one keep every destination admitted and meaning what it meant.
 */

import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	buildDoc,
	caseListConfig,
	type FormSpec,
	f,
	xp,
} from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { diffDocsToMutations } from "@/lib/doc/diffDocsToMutations";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { applyMutations } from "@/lib/doc/mutations";
import type { Mutation } from "@/lib/doc/types";
import {
	type BlueprintDoc,
	effectivePostSubmit,
	type PostSubmitDestination,
	simpleSearchInputDef,
} from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { assertAdmittedDoc } from "../../__tests__/admittedDoc";

const MODULE = testUuid("00000000-0000-4000-8000-0000000c0001");
const VISIT = testUuid("00000000-0000-4000-8000-0000000c0002");
const CLOSE = testUuid("00000000-0000-4000-8000-0000000c0003");
const REGISTER = testUuid("00000000-0000-4000-8000-0000000c0004");

function docWith(
	searchFirst: boolean,
	postSubmit: {
		visit?: PostSubmitDestination;
		close?: PostSubmitDestination;
		register?: PostSubmitDestination;
	} = {},
): BlueprintDoc {
	const config = caseListConfig([{ field: "case_name", header: "Name" }]);
	config.searchInputs = [
		simpleSearchInputDef(
			testUuid("00000000-0000-4000-8000-0000000c0010"),
			"case_name",
			"Name",
			"text",
			"case_name",
		),
	];
	const question = () =>
		f({ kind: "text", id: "question1", label: proseText("Question 1") });
	const forms: FormSpec[] = [
		{
			uuid: VISIT,
			name: "Visit",
			type: "followup",
			postSubmit: postSubmit.visit,
			fields: [question()],
		},
		{
			uuid: CLOSE,
			name: "Close",
			type: "close",
			postSubmit: postSubmit.close,
			fields: [question()],
		},
		{
			uuid: REGISTER,
			name: "Register",
			type: "registration",
			postSubmit: postSubmit.register,
			fields: [
				f({
					kind: "text",
					id: "case_name",
					label: proseText("Name"),
					caseWrite: { caseType: "patient", property: "case_name" },
				}),
			],
		},
	];
	const doc = buildDoc({
		appName: "T",
		modules: [
			{
				uuid: MODULE,
				name: "Cases",
				caseType: "patient",
				caseListConfig: config,
				caseSearchConfig: searchFirst ? { searchFirst: true } : {},
				forms: forms.slice(0, 2),
			},
			{
				name: "Register cases",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: forms.slice(2),
			},
		],
		caseTypes: [
			{
				name: "patient",
				properties: [{ name: "case_name", label: proseText("Name") }],
			},
		],
	});
	assertAdmittedDoc(doc);
	return doc;
}

function apply(
	doc: BlueprintDoc,
	mutations: readonly Mutation[],
): BlueprintDoc {
	const verdict = mutationCommitVerdict(
		doc,
		mutations,
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	expect(verdict.ok ? [] : verdict.findings).toEqual([]);
	return verdict.nextDoc;
}

const turnOn: Mutation = {
	kind: "updateModule",
	uuid: MODULE,
	patch: {},
	caseSearchConfigPatch: { searchFirst: true },
};
const turnOff: Mutation = {
	kind: "updateModule",
	uuid: MODULE,
	patch: {},
	caseSearchConfigPatch: { searchFirst: null },
};

describe("Search first and the after-submit slot", () => {
	it("rewrites an explicit previous to the module when Search first turns on", () => {
		const doc = docWith(false, { visit: "previous", close: "app_home" });
		const next = apply(doc, [turnOn]);
		expect(next.forms[VISIT]?.postSubmit).toBe("module");
		expect(next.forms[CLOSE]?.postSubmit).toBe("app_home");
		expect(next.forms[REGISTER]?.postSubmit).toBeUndefined();
	});

	it("leaves the absent slot alone when turning on: it now means the module", () => {
		const doc = docWith(false);
		const next = apply(doc, [turnOn]);
		expect(next.forms[VISIT]?.postSubmit).toBeUndefined();
		expect(effectivePostSubmit(next, VISIT)).toBe("module");
	});

	it("pins the module where the slot was absent when Search first turns off", () => {
		const doc = docWith(true, { close: "app_home" });
		expect(effectivePostSubmit(doc, VISIT)).toBe("module");
		const next = apply(doc, [turnOff]);
		expect(next.forms[VISIT]?.postSubmit).toBe("module");
		expect(effectivePostSubmit(next, VISIT)).toBe("module");
		expect(next.forms[CLOSE]?.postSubmit).toBe("app_home");
		expect(next.forms[REGISTER]?.postSubmit).toBeUndefined();
	});

	it("keeps automatic Search first after its final prompt is removed and only cascades an explicit clear", () => {
		const doc = docWith(true);
		const cleared = apply(doc, [
			{ kind: "updateModule", uuid: MODULE, patch: { caseSearchConfig: null } },
		]);
		expect(cleared.modules[MODULE]?.caseSearchConfig).toBeUndefined();
		expect(cleared.forms[VISIT]?.postSubmit).toBe("module");

		const cleanedUp = apply(doc, [
			{
				kind: "removeSearchInput",
				moduleUuid: MODULE,
				uuid: testUuid("00000000-0000-4000-8000-0000000c0010"),
			},
			{
				kind: "updateModule",
				uuid: MODULE,
				patch: {},
				caseSearchConfigOperation: "cleanup-after-final-input",
			},
		]);
		expect(cleanedUp.modules[MODULE]?.caseSearchConfig).toEqual({
			searchFirst: true,
		});
		expect(cleanedUp.forms[VISIT]?.postSubmit).toBeUndefined();
		expect(effectivePostSubmit(cleanedUp, VISIT)).toBe("module");
	});

	it("does nothing when the setting does not flip", () => {
		const doc = docWith(true, { visit: "app_home" });
		const next = apply(doc, [
			{
				kind: "updateModule",
				uuid: MODULE,
				patch: {},
				caseSearchConfigPatch: { searchScreenTitle: "Find" },
			},
		]);
		expect(next.forms[VISIT]?.postSubmit).toBe("app_home");
		expect(next.forms[CLOSE]?.postSubmit).toBeUndefined();
	});
});

/** The reducers alone, for the shapes whose other settings the gate judges
 * separately: what each arm leaves in every form's slot. */
function reduce(
	doc: BlueprintDoc,
	mutations: readonly Mutation[],
): BlueprintDoc {
	return produce(doc, (draft) => {
		applyMutations(draft, mutations);
	});
}

const PARENT = testUuid("00000000-0000-4000-8000-0000000c0101");
const PARENT_FORM = testUuid("00000000-0000-4000-8000-0000000c0102");
const CHILD = testUuid("00000000-0000-4000-8000-0000000c0103");
const CHILD_FORM = testUuid("00000000-0000-4000-8000-0000000c0104");
const OTHER = testUuid("00000000-0000-4000-8000-0000000c0105");
const OTHER_FORM = testUuid("00000000-0000-4000-8000-0000000c0106");
const LINK = testUuid("00000000-0000-4000-8000-0000000c0107");

/** "Households" (`PARENT`) with a follow-up, a child module "Members"
 * (`CHILD`) with a follow-up, and a top-level "Other" (`OTHER`). */
function nested(
	postSubmit: {
		parent?: PostSubmitDestination;
		child?: PostSubmitDestination;
		other?: PostSubmitDestination;
	} = {},
): BlueprintDoc {
	const followup = (
		uuid: string,
		name: string,
		destination: PostSubmitDestination | undefined,
	): FormSpec => ({
		uuid,
		name,
		type: "followup",
		postSubmit: destination,
		fields: [f({ kind: "text", id: "note", label: proseText("Note") })],
	});
	const list = () => caseListConfig([{ field: "case_name", header: "Name" }]);
	const doc = buildDoc({
		appName: "T",
		modules: [
			{
				uuid: PARENT,
				name: "Households",
				caseType: "patient",
				caseListConfig: list(),
				forms: [followup(PARENT_FORM, "Household visit", postSubmit.parent)],
			},
			{
				uuid: CHILD,
				name: "Members",
				caseType: "patient",
				caseListConfig: list(),
				forms: [followup(CHILD_FORM, "Member visit", postSubmit.child)],
			},
			{
				uuid: OTHER,
				name: "Other",
				caseType: "patient",
				caseListConfig: list(),
				forms: [followup(OTHER_FORM, "Other visit", postSubmit.other)],
			},
		],
		caseTypes: [
			{
				name: "patient",
				properties: [{ name: "case_name", label: proseText("Name") }],
			},
		],
	});
	doc.modules[CHILD].parentModuleUuid = PARENT;
	return doc;
}

const several = { kind: "multiple" as const, maximum: 5 };
const linkFrom = (doc: BlueprintDoc, formUuid: typeof PARENT_FORM) => {
	doc.forms[formUuid].formLinks = [
		{
			uuid: LINK,
			target: { type: "module", moduleUuid: OTHER },
			condition: xp("#user/username = 'reviewer'"),
		},
	];
};

describe("updateModule: a module taken off the menu", () => {
	it("moves its forms' previous and module, and its child modules' parentMenu, to firstMenu", () => {
		const doc = nested({ parent: "previous", child: "parentMenu" });
		const next = reduce(doc, [
			{ kind: "updateModule", uuid: PARENT, patch: { hiddenFromMenu: true } },
		]);
		expect(next.forms[PARENT_FORM].postSubmit).toBe("firstMenu");
		expect(next.forms[CHILD_FORM].postSubmit).toBe("firstMenu");
		const moduleDoc = nested({ parent: "module" });
		expect(
			reduce(moduleDoc, [
				{ kind: "updateModule", uuid: PARENT, patch: { hiddenFromMenu: true } },
			]).forms[PARENT_FORM].postSubmit,
		).toBe("firstMenu");
	});

	it("leaves an absent slot absent, to take the new default", () => {
		const next = reduce(nested(), [
			{ kind: "updateModule", uuid: PARENT, patch: { hiddenFromMenu: true } },
		]);
		expect(next.forms[PARENT_FORM].postSubmit).toBeUndefined();
		expect(effectivePostSubmit(next, PARENT_FORM)).toBe("firstMenu");
		expect(next.forms[CHILD_FORM].postSubmit).toBeUndefined();
	});

	it("leaves other modules' forms alone", () => {
		const next = reduce(nested({ other: "previous" }), [
			{ kind: "updateModule", uuid: PARENT, patch: { hiddenFromMenu: true } },
		]);
		expect(next.forms[OTHER_FORM].postSubmit).toBe("previous");
	});
});

describe("setCaseListMeta: the selection mode", () => {
	const multi: Mutation = {
		kind: "setCaseListMeta",
		uuid: PARENT,
		patch: { selection: several },
	};

	it("moves an explicit previous to module, and the child's module and parentMenu to firstMenu", () => {
		const next = reduce(nested({ parent: "previous", child: "parentMenu" }), [
			multi,
		]);
		expect(next.forms[PARENT_FORM].postSubmit).toBe("module");
		expect(next.forms[CHILD_FORM].postSubmit).toBe("firstMenu");
	});

	it("leaves an absent slot to its new default", () => {
		const next = reduce(nested(), [multi]);
		expect(next.forms[PARENT_FORM].postSubmit).toBeUndefined();
		expect(effectivePostSubmit(next, PARENT_FORM)).toBe("module");
	});

	it("pins previous on a form with links whose absent slot it still admits", () => {
		const doc = nested();
		linkFrom(doc, PARENT_FORM);
		const next = reduce(doc, [multi]);
		expect(next.forms[PARENT_FORM].postSubmit).toBe("previous");
	});

	it("keeps an explicit previous on a form with links", () => {
		const doc = nested({ parent: "previous" });
		linkFrom(doc, PARENT_FORM);
		expect(reduce(doc, [multi]).forms[PARENT_FORM].postSubmit).toBe("previous");
	});

	it("pins module where the slot was absent when the module returns to one case", () => {
		const doc = nested();
		doc.modules[PARENT].caseListConfig = {
			...(doc.modules[PARENT].caseListConfig ?? caseListConfig([])),
			selection: several,
		};
		expect(effectivePostSubmit(doc, PARENT_FORM)).toBe("module");
		const next = reduce(doc, [
			{ kind: "setCaseListMeta", uuid: PARENT, patch: { selection: null } },
		]);
		expect(next.forms[PARENT_FORM].postSubmit).toBe("module");
	});
});

describe("Search first on a form with links", () => {
	it("moves its explicit previous to module", () => {
		const doc = nested({ other: "previous" });
		linkFrom(doc, OTHER_FORM);
		const next = reduce(doc, [
			{
				kind: "updateModule",
				uuid: OTHER,
				patch: {},
				caseSearchConfigPatch: { searchFirst: true },
			},
		]);
		expect(next.forms[OTHER_FORM].postSubmit).toBe("module");
	});
});

describe("moveModule: the module's parent", () => {
	it("moves module to firstMenu under a parent that selects several cases", () => {
		const doc = nested({ other: "module" });
		doc.modules[PARENT].caseListConfig = {
			...(doc.modules[PARENT].caseListConfig ?? caseListConfig([])),
			selection: several,
		};
		const next = reduce(doc, [
			{
				kind: "moveModule",
				uuid: OTHER,
				parentModuleUuid: PARENT,
				after: null,
			},
		]);
		expect(next.modules[OTHER].parentModuleUuid).toBe(PARENT);
		expect(next.forms[OTHER_FORM].postSubmit).toBe("firstMenu");
	});

	it("moves parentMenu to firstMenu when the module becomes top-level", () => {
		const next = reduce(nested({ child: "parentMenu" }), [
			{ kind: "moveModule", uuid: CHILD, parentModuleUuid: null, after: null },
		]);
		expect(next.forms[CHILD_FORM].postSubmit).toBe("firstMenu");
	});
});

describe("moveForm: the form's module", () => {
	it("moves previous to firstMenu when the form lands in a module off the menu", () => {
		const doc = nested({ other: "previous" });
		doc.modules[PARENT].hiddenFromMenu = true;
		const next = reduce(doc, [
			{ kind: "moveForm", uuid: OTHER_FORM, toModuleUuid: PARENT, after: null },
		]);
		expect(next.forms[OTHER_FORM].postSubmit).toBe("firstMenu");
	});
});

describe("removeFormLink: the last link leaving", () => {
	it("ends the exemption, so a previous the menu does not offer moves to module", () => {
		const doc = nested({ parent: "previous" });
		linkFrom(doc, PARENT_FORM);
		doc.modules[PARENT].caseListConfig = {
			...(doc.modules[PARENT].caseListConfig ?? caseListConfig([])),
			selection: several,
		};
		const next = reduce(doc, [
			{ kind: "removeFormLink", formUuid: PARENT_FORM, uuid: LINK },
		]);
		expect(next.forms[PARENT_FORM].formLinks).toBeUndefined();
		expect(next.forms[PARENT_FORM].postSubmit).toBe("module");
	});
});

describe("diffDocsToMutations: a menu-shape write the target overrides", () => {
	it("lands the target's absent slot after the reducer pinned it", () => {
		const prev = nested();
		linkFrom(prev, PARENT_FORM);
		const next = produce(prev, (draft) => {
			draft.modules[PARENT].caseListConfig = {
				...(draft.modules[PARENT].caseListConfig ?? caseListConfig([])),
				selection: several,
			};
		});
		const mutations = diffDocsToMutations(prev, next);
		expect(mutations).toContainEqual({
			kind: "updateForm",
			uuid: PARENT_FORM,
			patch: { postSubmit: null },
		});
		const replayed = reduce(prev, mutations);
		expect(replayed.forms[PARENT_FORM].postSubmit).toBeUndefined();
		expect(replayed.modules[PARENT].caseListConfig?.selection).toEqual(several);
	});

	it("adds nothing when no write reconciles a destination", () => {
		const prev = nested({ parent: "previous" });
		const next = produce(prev, (draft) => {
			draft.forms[PARENT_FORM].postSubmit = "module";
		});
		expect(diffDocsToMutations(prev, next)).toEqual([
			{
				kind: "updateForm",
				uuid: PARENT_FORM,
				patch: { postSubmit: "module" },
			},
		]);
	});
});
