import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	promptLookupContext,
	searchPromptFixture,
} from "@/lib/commcare/__tests__/searchPromptFixture";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import {
	blueprintDocSchema,
	hiddenSearchInputDef,
	type SearchInputDef,
	searchInputOptions,
	simpleSearchInputDef,
} from "@/lib/domain";
import {
	and,
	eq,
	gt,
	input,
	isBlank,
	literal,
	matchesPattern,
	type Predicate,
	prop,
	sessionContext,
	term,
} from "@/lib/domain/predicate";
import { runValidation } from "../../../runner";
import {
	admittedCaseListDoc,
	findings,
	withSearchInputs,
} from "./caseListRuleFixture";

const first = simpleSearchInputDef(
	testUuid("first"),
	"name",
	"Name",
	"text",
	"case_name",
);
const second = testUuid("second");
const run = (inputs: SearchInputDef[]) =>
	findings(withSearchInputs(admittedCaseListDoc(), inputs));

describe("search-screen slot admission", () => {
	it("admits sibling presence and self pattern checks with no case data", () => {
		const prompt = simpleSearchInputDef(
			second,
			"other",
			"Other",
			"text",
			"case_name",
			{
				required: { when: isBlank(input(first.uuid)) },
				validation: {
					rule: matchesPattern(input(second), "^[0-9]{10}$"),
					message: "Ten digits",
				},
			},
		);
		expect(run([first, prompt])).toEqual([]);
	});
	it.each(["required", "validation"] as const)(
		"refuses case data and operand-type errors in %s with exact slot identities",
		(slot) => {
			for (const [predicate, reason] of [
				[
					eq(prop("patient", "case_name"), literal("A")),
					"CASE_DATA_UNAVAILABLE",
				],
				[gt(input(second), literal("5")), "TYPE_ERROR"],
			] as const) {
				const prompt = simpleSearchInputDef(
					second,
					"other",
					"Other",
					"text",
					"case_name",
					slot === "required"
						? { required: { when: predicate } }
						: { validation: { rule: predicate, message: "Check" } },
				);
				const errors = run([first, prompt]);
				expect(errors.map((error) => error.code)).toEqual([
					`CASE_LIST_SEARCH_INPUT_${slot === "required" ? "REQUIRED_CONDITION" : "VALIDATION_RULE"}_${reason}`,
				]);
				expect(errors[0].details).toMatchObject({
					inputUuid: second,
					slot: `caseListConfig.searchInputs[1].${slot === "required" ? "required.when" : "validation.rule"}`,
				});
			}
		},
	);
	it("admits session hidden values, refuses case reads before typing, and rejects unknown input identities", () => {
		expect(
			run([
				first,
				hiddenSearchInputDef(
					second,
					"hidden",
					"Hidden",
					term(sessionContext("username")),
				),
			]),
		).toEqual([]);
		const errors = run([
			first,
			hiddenSearchInputDef(
				second,
				"hidden",
				"Hidden",
				term(prop("patient", "case_name")),
			),
		]);
		expect(errors.map((error) => error.code)).toEqual([
			"CASE_LIST_SEARCH_INPUT_HIDDEN_VALUE_CASE_DATA_UNAVAILABLE",
		]);
		const unknown = run([
			first,
			hiddenSearchInputDef(
				second,
				"hidden",
				"Hidden",
				term(input(testUuid("ghost"))),
			),
		]);
		expect(unknown.map((error) => error.code)).toEqual([
			"CASE_LIST_SEARCH_INPUT_HIDDEN_VALUE_TYPE_ERROR",
			"CASE_LIST_BARE_SEARCH_INPUT_REF",
		]);
	});
	it.each([
		{
			name: "case scope",
			predicate: eq(prop("patient", "first_name"), literal("A")),
			code: "CASE_LIST_SEARCH_INPUT_OPTIONS_FILTER_SCOPE",
			reason: "case-data",
		},
		{
			name: "answer scope",
			predicate: and(
				eq(input(testUuid("unknown")), literal("A")),
				eq(input(testUuid("unknown")), literal("B")),
			),
			code: "CASE_LIST_SEARCH_INPUT_OPTIONS_FILTER_SCOPE",
			reason: "search-input",
		},
		{
			name: "operand types",
			predicate: gt(literal("A"), literal("B")),
			code: "CASE_LIST_SEARCH_INPUT_OPTIONS_FILTER_TYPE_ERROR",
		},
	] satisfies {
		name: string;
		predicate: Predicate;
		code: string;
		reason?: string;
	}[])(
		"refuses lookup choice filter $name without duplicate generic findings",
		({ predicate, code, reason }) => {
			const base = searchPromptFixture("prompt-widgets");
			const moduleId = base.moduleOrder[0];
			const module = base.modules[moduleId];
			const config = module.caseListConfig;
			if (!config) throw new Error("Missing admitted config");
			const searchInputs = config.searchInputs.map((prompt) => {
				if (prompt.name !== "region") return prompt;
				const options = searchInputOptions(prompt);
				if (!options || prompt.kind !== "simple" || prompt.type !== "select")
					throw new Error("Missing choice prompt");
				return { ...prompt, options: { ...options, filter: predicate } };
			});
			const doc = {
				...base,
				modules: {
					...base.modules,
					[moduleId]: {
						...module,
						caseListConfig: { ...config, searchInputs },
					},
				},
			};
			blueprintDocSchema.parse(toPersistableDoc(doc));
			const errors = runValidation(doc, promptLookupContext);
			expect(errors.map((error) => error.code)).toEqual([code]);
			if (reason) expect(errors[0].details?.reason).toBe(reason);
		},
	);
});
