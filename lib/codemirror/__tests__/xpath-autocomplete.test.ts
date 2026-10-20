/**
 * Coverage for the completion sources. First the case-type `#<type>/`
 * branch: a registration form surfaces only the own type's `#<type>/case_id` (mirroring
 * the `caseRefAcceptMap` registration-narrowing rule the validator also uses)
 * while other form types surface the full property list.
 *
 * The source is driven through `@codemirror/autocomplete`'s
 * `CompletionContext`, mounted on an EditorState that has the XPath language
 * extension attached (the source resolves the syntax tree at the cursor
 * position to find a `HashtagRef`, so a parsed state is required).
 */

import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { parseFormExpression } from "@/lib/commcare/xpath/expressionAst";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { ReachableCaseTypeIndex } from "@/lib/domain";
import type { ExpressionSlotRef } from "@/lib/domain/expression/types";
import {
	buildExpressionEditorContext,
	type ExpressionEditorContext,
} from "../expressionEditorContext";
import type { FormReferenceContext } from "../formReferenceContext";
import {
	hashtagSource,
	instanceSource,
	relativeSource,
} from "../xpath-autocomplete";
import { xpath } from "../xpath-language";
import { xpathDiagnostics } from "../xpath-lint";

/**
 * Build a CompletionContext at the end of `doc` against an EditorState
 * that has the XPath language attached. `explicit=false` mimics the
 * "user typed a character" trigger CodeMirror uses by default.
 */
function ctxFor(doc: string): CompletionContext {
	const state = EditorState.create({ doc, extensions: [xpath()] });
	return new CompletionContext(state, doc.length, false);
}

/** A reachable index with one own (depth 0) type `patient`. Seeds `case_id`
 *  (label "case id") the same way `toReachableIndex` does in production, so the
 *  fixture matches the real index shape. */
function patientIndex(
	properties: Array<[string, { label?: string }]>,
): ReachableCaseTypeIndex {
	const props = new Map(properties);
	if (!props.has("case_id")) props.set("case_id", { label: "case id" });
	return new Map([["patient", { depth: 0, properties: props }]]);
}

function makeLintContext(
	formType: FormReferenceContext["formType"],
	properties: Array<[string, { label?: string }]> = [
		["case_id", { label: "case id" }],
		["age", { label: "Age" }],
		["weight", { label: "Weight" }],
	],
): FormReferenceContext {
	return {
		formUuid: "test-form",
		validPaths: new Set(),
		reachableCaseTypes: patientIndex(properties),
		formEntries: [],
		formType,
	};
}

describe("hashtagSource — registration form filters to the own type's case_id only", () => {
	it("after typing `#patient/`, only `#patient/case_id` is offered", () => {
		const source = hashtagSource(() => makeLintContext("registration"));
		const result = source(ctxFor("#patient/"));
		expect(result).not.toBeNull();
		const labels = result?.options.map((o) => o.label) ?? [];
		expect(labels).toEqual(["#patient/case_id"]);
	});

	it("offers the seeded #patient/case_id with its 'case id' detail when the type declares nothing else", () => {
		// `case_id` is a seeded system property of every type, so it's offered
		// on a registration form even when the case-type record declares no
		// other properties.
		const source = hashtagSource(() => makeLintContext("registration", []));
		const result = source(ctxFor("#patient/"));
		expect(result?.options[0].label).toBe("#patient/case_id");
		expect(result?.options[0].detail).toBe("case id");
	});
});

describe("hashtagSource — case-loading forms surface all case properties", () => {
	for (const formType of ["followup", "close"] as const) {
		it(`offers every case property on a ${formType} form`, () => {
			const source = hashtagSource(() => makeLintContext(formType));
			const result = source(ctxFor("#patient/"));
			const labels = (result?.options.map((o) => o.label) ?? []).sort();
			expect(labels).toEqual([
				"#patient/age",
				"#patient/case_id",
				"#patient/weight",
			]);
		});
	}
});

describe("hashtagSource — survey forms offer no case properties", () => {
	it("offers nothing after `#patient/` (a survey loads no case)", () => {
		// A survey form's suite entry declares no `case_id` datum, so any
		// `#<type>/<prop>` would resolve against an empty session datum. The
		// accept map is empty for surveys (mirroring `caseRefAcceptMap`), so
		// the autocomplete offers no case properties even when the module the
		// survey sits in has a case type.
		const source = hashtagSource(() => makeLintContext("survey"));
		const result = source(ctxFor("#patient/"));
		expect(result).toBeNull();
	});
});

describe("hashtagSource — worker information", () => {
	it("offers custom worker labels while inserting their current slugs", () => {
		const source = hashtagSource(() => ({
			...makeLintContext("followup"),
			userProperties: [
				{
					uuid: testUuid("property-1"),
					slug: "supervisor_area",
					label: "Supervisor area",
				},
			],
		}));

		const result = source(ctxFor("#user/"));
		const custom = result?.options.find(
			(option) => option.label === "#user/supervisor_area",
		);
		expect(custom).toMatchObject({
			displayLabel: "Supervisor area",
			detail: "supervisor_area",
			type: "property",
			boost: 2,
		});
	});

	it("does not also offer a built-in when a custom property owns its slug", () => {
		const source = hashtagSource(() => ({
			...makeLintContext("followup"),
			userProperties: [
				{
					uuid: testUuid("property-1"),
					slug: "username",
					label: "Program username",
				},
			],
		}));

		const usernameOptions =
			source(ctxFor("#user/"))?.options.filter(
				(option) => option.label === "#user/username",
			) ?? [];
		expect(usernameOptions).toHaveLength(1);
		expect(usernameOptions[0]).toMatchObject({
			displayLabel: "Program username",
			detail: "username",
		});
	});
});

// ── The reads of a real slot ─────────────────────────────────────────────
//
// Contract: each source offers what the slot's own parse scope binds at that
// position, so every offer, once written, is a read the editor's parser
// accepts (and the representative reads below lint clean), and nothing is
// offered that the parser would refuse.

const MODULE = testUuid("ac-module");
const FORM = testUuid("ac-form");
const ATTENDING = testUuid("ac-attending");
const YES = testUuid("ac-yes");
const NO = testUuid("ac-no");
const GROUP = testUuid("ac-group");
const BEE = testUuid("ac-bee");
const CALC = testUuid("ac-calc");
const REGION = testUuid("ac-region");

const readsDoc = buildDoc(
	{
		caseTypes: [
			{
				name: "household",
				properties: [{ name: "village", label: "Village" }],
			},
			{
				name: "patient",
				parent_type: "household",
				properties: [{ name: "status_note", label: "Status note" }],
			},
		],
		modules: [
			{
				uuid: MODULE,
				name: "Patients",
				caseType: "patient",
				forms: [
					{
						uuid: FORM,
						name: "Visit",
						type: "followup",
						fields: [
							f({
								uuid: ATTENDING,
								id: "a",
								kind: "single_select",
								label: "Attending",
								options: [
									{ uuid: YES, value: "yes", label: "Yes" },
									{ uuid: NO, value: "no", label: "No" },
								],
							}),
							f({
								uuid: GROUP,
								id: "grp",
								kind: "group",
								label: "Household",
								children: [
									f({ uuid: BEE, id: "b", kind: "text", label: "Bee" }),
								],
							}),
							f({ uuid: CALC, id: "calc", kind: "hidden" }),
						],
					},
				],
			},
		],
	},
	(doc) => {
		doc.userProperties = {
			[REGION]: { uuid: REGION, slug: "region", label: "Region" },
		};
		doc.userPropertyOrder = [REGION];
	},
);

const RELEVANT: ExpressionSlotRef = {
	entity: "field",
	uuid: CALC,
	slot: "relevant",
};
const DEFAULT: ExpressionSlotRef = {
	entity: "field",
	uuid: ATTENDING,
	slot: "default_value",
};

function editorContext(slot: ExpressionSlotRef): ExpressionEditorContext {
	const built = buildExpressionEditorContext(
		readsDoc,
		slot,
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	if (built === undefined) throw new Error("The slot has no editor context");
	return built;
}

/** Every option the reads sources offer at the end of `written`. */
function offered(slot: ExpressionSlotRef, written: string) {
	const ctx = editorContext(slot);
	const state = EditorState.create({ doc: written, extensions: [xpath()] });
	const at = new CompletionContext(state, written.length, false);
	return [instanceSource, relativeSource].flatMap(
		(source) => source(() => ctx.reads)(at)?.options ?? [],
	);
}

function labels(slot: ExpressionSlotRef, written: string): string[] {
	return offered(slot, written).map((option) => option.label);
}

function parses(slot: ExpressionSlotRef, text: string) {
	const parsed = parseFormExpression(text, editorContext(slot).scope);
	expect(parsed.ok, text).toBe(true);
}

function lintsClean(slot: ExpressionSlotRef, text: string) {
	expect(xpathDiagnostics(text, editorContext(slot)), text).toEqual([]);
}

describe("records queries", () => {
	const ROW = "count(instance('casedb')/casedb/case";

	it("walks to the rows and asks for their record type first", () => {
		expect(labels(RELEVANT, "count(instance('casedb')/")).toEqual(["casedb/"]);
		expect(labels(RELEVANT, "count(instance('casedb')/casedb/")).toEqual([
			"case",
		]);
		expect(labels(RELEVANT, `${ROW}[`)).toEqual(["@case_type = '"]);
	});

	it("offers the record types opposite @case_type", () => {
		const types = labels(RELEVANT, `${ROW}[@case_type = '`);
		expect(types).toEqual(expect.arrayContaining(["household", "patient"]));
		for (const type of types)
			parses(RELEVANT, `${ROW}[@case_type = '${type}'])`);
	});

	it("offers a typed row's properties and relations, in a later predicate or a later clause", () => {
		const later = labels(RELEVANT, `${ROW}[@case_type = 'patient'][`);
		expect(later).toEqual(
			expect.arrayContaining(["status_note", "@case_id", "index/parent"]),
		);
		expect(later).not.toContain("village");
		expect(labels(RELEVANT, `${ROW}[@case_type = 'patient' and st`)).toEqual(
			later,
		);
		for (const value of later)
			parses(RELEVANT, `${ROW}[@case_type = 'patient'][${value} = 'x'])`);
		lintsClean(
			RELEVANT,
			`${ROW}[@case_type = 'patient'][status_note = 'x']) > 0`,
		);
	});
});

describe("session values", () => {
	const SESSION = "instance('commcaresession')/session/";

	it("offers the session's branches, its context fields and worker information", () => {
		expect(labels(RELEVANT, SESSION)).toEqual(
			expect.arrayContaining(["context/", "user/"]),
		);
		expect(labels(RELEVANT, `${SESSION}context/`)).toEqual([
			"userid",
			"username",
			"deviceid",
			"appversion",
		]);
		expect(labels(RELEVANT, `${SESSION}user/`)).toEqual(["data/"]);
		const workers = labels(RELEVANT, `${SESSION}user/data/`);
		expect(workers[0]).toBe("region");
		for (const field of labels(RELEVANT, `${SESSION}context/`))
			lintsClean(RELEVANT, `${SESSION}context/${field} != ''`);
		for (const worker of workers)
			parses(RELEVANT, `${SESSION}user/data/${worker} != ''`);
		lintsClean(RELEVANT, `${SESSION}user/data/region = 'north'`);
	});
});

describe("relative steps", () => {
	it("offers the questions ../ reaches, a group ending in /, and the questions below it", () => {
		const siblings = offered(RELEVANT, "../");
		expect(siblings.map((option) => option.label)).toEqual([
			"a",
			"grp/",
			"calc",
		]);
		expect(siblings[0].detail).toBe("Attending");
		expect(labels(RELEVANT, "../grp/")).toEqual(["b"]);
		expect(labels(RELEVANT, "./")).toEqual([]);
		lintsClean(RELEVANT, "../a = 'yes'");
		lintsClean(RELEVANT, "../grp/b = 'x'");
	});

	it("stands aside inside a predicate, where the context node moves", () => {
		expect(
			labels(
				RELEVANT,
				"count(instance('casedb')/casedb/case[@case_type = 'patient'][../",
			),
		).toEqual([]);
	});
});

describe("a static select's choices", () => {
	it("offers its values with their labels opposite its answer, in any spelling", () => {
		for (const written of ["../a = '", "#form/a != '", "/data/a = '"]) {
			const options = offered(RELEVANT, written);
			expect(
				options.map((option) => option.label),
				written,
			).toEqual(["yes", "no"]);
			expect(options.map((option) => option.detail)).toEqual(["Yes", "No"]);
		}
		lintsClean(RELEVANT, "../a = 'yes'");
		expect(labels(RELEVANT, "../grp/b = '")).toEqual([]);
	});

	it("offers them as the select's starting value", () => {
		expect(labels(DEFAULT, "'")).toEqual(["yes", "no"]);
		lintsClean(DEFAULT, "'yes'");
	});
});
