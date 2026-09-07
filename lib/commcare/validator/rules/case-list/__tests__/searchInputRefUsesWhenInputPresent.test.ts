import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import {
	advancedSearchInputDef,
	type BlueprintDoc,
	blueprintDocSchema,
	type CaseListConfig,
	calculatedColumn,
	hiddenSearchInputDef,
	type Module,
	simpleSearchInputDef,
} from "@/lib/domain";
import {
	and,
	concat,
	eq,
	input,
	literal,
	type Predicate,
	prop,
	term,
	whenInput,
} from "@/lib/domain/predicate";
import {
	admittedCaseListDoc,
	findings,
	withSearchInputs,
} from "./caseListRuleFixture";

const first = simpleSearchInputDef(
	testUuid("first"),
	"first",
	"First",
	"text",
	"case_name",
);
const second = simpleSearchInputDef(
	testUuid("second"),
	"second",
	"Second",
	"text",
	"case_name",
);
const bare = "CASE_LIST_BARE_SEARCH_INPUT_REF";
function configured(
	change: (config: CaseListConfig, module: Module) => void,
): BlueprintDoc {
	const doc = structuredClone(
		withSearchInputs(admittedCaseListDoc(), [first, second]),
	);
	const module = doc.modules[doc.moduleOrder[0]];
	const config = module.caseListConfig;
	if (!config) throw new Error("Missing admitted config");
	change(config, module);
	blueprintDocSchema.parse(toPersistableDoc(doc));
	return doc;
}
const equal = (id = first.uuid) => eq(prop("patient", "case_name"), input(id));
describe("search input envelope scope", () => {
	it.each([
		{ name: "bare", predicate: equal(), refs: [first.uuid] },
		{
			name: "matching guard",
			predicate: whenInput(input(first.uuid), equal()),
			refs: [],
		},
		{
			name: "wrong guard",
			predicate: whenInput(input(second.uuid), equal()),
			refs: [first.uuid],
		},
		{
			name: "guard trigger only",
			predicate: whenInput(
				input(first.uuid),
				eq(prop("patient", "case_name"), literal("A")),
			),
			refs: [],
		},
		{
			name: "sibling isolation",
			predicate: and(whenInput(input(first.uuid), equal()), equal()),
			refs: [first.uuid],
		},
		{
			name: "nested same guard preserves outer scope",
			predicate: whenInput(
				input(first.uuid),
				and(whenInput(input(first.uuid), equal()), equal()),
			),
			refs: [],
		},
		{
			name: "two distinct refs",
			predicate: and(equal(), equal(second.uuid)),
			refs: [first.uuid, second.uuid],
		},
		{
			name: "nested value ref",
			predicate: eq(
				prop("patient", "case_name"),
				concat(term(input(first.uuid)), term(literal("x"))),
			),
			refs: [first.uuid],
		},
	] satisfies { name: string; predicate: Predicate; refs: string[] }[])(
		"$name",
		({ predicate, refs }) => {
			const errors = findings(
				configured((config) => {
					config.filter = predicate;
				}),
			);
			expect(
				errors.map((error) => ({
					code: error.code,
					ref: error.details?.inputUuid,
					slot: error.details?.slot,
				})),
			).toEqual(
				refs.map((ref) => ({ code: bare, ref, slot: "caseListConfig.filter" })),
			);
		},
	);
	it("checks an advanced predicate at its exact input location", () => {
		const errors = findings(
			configured((config) => {
				config.searchInputs.push(
					advancedSearchInputDef(
						testUuid("advanced"),
						"advanced",
						"Advanced",
						"text",
						equal(),
					),
				);
			}),
		);
		expect(errors.map((error) => error.code)).toEqual([bare]);
		expect(errors[0].details?.slot).toBe(
			"caseListConfig.searchInputs[2].predicate",
		);
	});
	it.each(["default", "hidden", "column", "button"] as const)(
		"refuses declared inputs in the %s slot without an answer context",
		(slot) => {
			const errors = findings(
				configured((config, module) => {
					if (slot === "default")
						config.searchInputs[1] = simpleSearchInputDef(
							second.uuid,
							"second",
							"Second",
							"text",
							"case_name",
							{ default: term(input(first.uuid)) },
						);
					if (slot === "hidden")
						config.searchInputs.push(
							hiddenSearchInputDef(
								testUuid("hidden"),
								"hidden",
								"Hidden",
								term(input(first.uuid)),
							),
						);
					if (slot === "column") {
						const column = calculatedColumn(
							testUuid("calc"),
							"Echo",
							term(input(first.uuid)),
						);
						config.columns.push(column);
						config.listColumnOrder.push(column.uuid);
						config.detailColumnOrder.push(column.uuid);
					}
					if (slot === "button")
						module.caseSearchConfig = {
							searchButtonDisplayCondition: whenInput(
								input(first.uuid),
								eq(literal("A"), literal("A")),
							),
						};
				}),
			);
			expect(errors.map((error) => error.code)).toEqual([bare]);
			expect(errors[0].details).toMatchObject({
				inputUuid: first.uuid,
				mode: "forbids-input-ref",
			});
		},
	);
	it("allows a search answer as the assigned-case exclusion identity", () => {
		expect(
			findings(
				configured((_config, module) => {
					module.caseSearchConfig = {
						excludedOwnerIds: term(input(first.uuid)),
					};
				}),
			),
		).toEqual([]);
	});
});
