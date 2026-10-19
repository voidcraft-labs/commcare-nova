// A multiple select answer's tokens as Core casts them
// (`SelectMultiData.cast` over `DataUtil.splitOnSpaces`, Java's
// `split("[ ]+")`): a leading empty token survives and names no choice, so
// Core's `Selection.attachChoice` refuses it. Each refusal sits beside the
// neighbour that differs from it in one fact.

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { runValidation } from "@/lib/commcare/validator/runner";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { selectAnswerTokens } from "../choiceValue";
import { formFixture, ids } from "./formFixture";

describe("selectAnswerTokens", () => {
	it.each([
		["", []],
		["   ", []],
		[" a", ["", "a"]],
		["  a  b ", ["", "a", "b"]],
		["a ", ["a"]],
		["a  b", ["a", "b"]],
		["a\tb", ["a\tb"]],
	])("splits %j as Core does", (text, tokens) => {
		expect(selectAnswerTokens(text)).toEqual(tokens);
	});
});

function multiDefault(value: string): BlueprintDoc {
	const doc = formFixture();
	const field = doc.fields[ids.choice];
	if (field.kind !== "single_select")
		throw new Error("The choice fixture is missing.");
	doc.fields[ids.choice] = {
		...field,
		kind: "multi_select",
		optionsSource: {
			kind: "inline",
			options: ["a", "b"].map((option) => ({
				uuid: testUuid(`tokens-option-${option}`),
				value: option,
				label: proseText(option),
			})),
		},
		default_value: { kind: "term", term: { kind: "literal", value } },
	};
	return doc;
}

function preloadWrite(value: string): BlueprintDoc {
	return buildDoc({
		appName: "Tokens",
		caseTypes: [
			{ name: "patient", properties: [{ name: "stage", label: "Stage" }] },
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: testUuid("tokens-register"),
						name: "Register",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "name",
								label: "Name",
								caseWrite: { caseType: "patient", property: "case_name" },
							}),
							f({
								uuid: testUuid("tokens-writer"),
								kind: "hidden",
								id: "stage_value",
								calculate: {
									kind: "term",
									term: { kind: "literal", value },
								},
								caseWrite: { caseType: "patient", property: "stage" },
							}),
						],
					},
					{
						uuid: testUuid("tokens-visit"),
						name: "Visit",
						type: "followup",
						fields: [
							f({
								kind: "multi_select",
								id: "stage_question",
								label: "Stage",
								caseWrite: { caseType: "patient", property: "stage" },
								optionsSource: {
									kind: "inline",
									options: [
										{ value: "a", label: "A" },
										{ value: "b", label: "B" },
									],
								},
							}),
						],
					},
				],
			},
		],
	});
}

const codes = (doc: BlueprintDoc, code: string) =>
	runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)
		.filter((error) => error.code === code)
		.map((error) => error.code);

describe("a leading space in a multiple select's saved text", () => {
	it("refuses a starting value with a leading space, beside a trailing space and a double space", () => {
		expect(codes(multiDefault(" a"), "SELECT_DEFAULT_NOT_AN_OPTION")).toEqual([
			"SELECT_DEFAULT_NOT_AN_OPTION",
		]);
		expect(codes(multiDefault("a "), "SELECT_DEFAULT_NOT_AN_OPTION")).toEqual(
			[],
		);
		expect(codes(multiDefault("a  b"), "SELECT_DEFAULT_NOT_AN_OPTION")).toEqual(
			[],
		);
	});

	it("refuses a saved value with a leading space where the question starts on it, beside a trailing space and a double space", () => {
		const code = "SELECT_PRELOAD_WRITE_NOT_AN_OPTION";
		expect(codes(preloadWrite(" a"), code)).toEqual([code]);
		expect(codes(preloadWrite("a "), code)).toEqual([]);
		expect(codes(preloadWrite("a  b"), code)).toEqual([]);
	});
});
