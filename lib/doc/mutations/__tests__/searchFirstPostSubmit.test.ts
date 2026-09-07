/**
 * The after-submit cascade that rides a Search-first flip: the absent
 * `postSubmit` slot means the module while Search first is on and the
 * previous screen otherwise, so the reducer keeps every case form's
 * destination meaning what it meant, whichever writer flipped the setting.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	buildDoc,
	caseListConfig,
	type FormSpec,
	f,
} from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
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
