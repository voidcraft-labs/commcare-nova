import AdmZip from "adm-zip";
import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	PROMPT_IDS,
	promptLookupContext,
	promptLookupFixtures,
	promptLookupNaming,
	promptScenarios,
	searchPromptFixture,
} from "@/lib/commcare/__tests__/searchPromptFixture";
import {
	onlyXml,
	readXmlEvidence,
	xmlChildren,
} from "@/lib/commcare/__tests__/xmlEvidence";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import { serializeXml } from "@/lib/commcare/serializeXml";
import { runValidation } from "@/lib/commcare/validator/runner";
import { advancedSearchInputDef, makeTranslationUnitId } from "@/lib/domain";
import {
	and,
	eq,
	input,
	literal,
	matchAll,
	prop,
	whenInput,
} from "@/lib/domain/predicate";
import { buildSearchPrompts } from "../searchPrompts";
import {
	buildRuntimeCsqlPromptValidations,
	composeXPathQueryEmission,
} from "../xpathQuery";

function projection(scenario: (typeof promptScenarios)[number]) {
	const doc = searchPromptFixture(scenario);
	const config = doc.modules[doc.moduleOrder[0]].caseListConfig;
	if (!config) throw new Error("Fixture has a case list");
	const context = {
		caseTypes: doc.caseTypes ?? [],
		currentCaseType: "patient",
		knownInputs: [],
		lookupTables: new Map(
			promptLookupContext.kind === "available"
				? promptLookupContext.definitions.map((table) => [
						table.id,
						new Map(
							table.columns.map((column) => [column.id, column.dataType]),
						),
					])
				: [],
		),
	};
	const validations = buildRuntimeCsqlPromptValidations(
		composeXPathQueryEmission(config, "patient", context, promptLookupNaming),
	);
	return {
		doc,
		config,
		context,
		validations,
		emission: buildSearchPrompts(
			config.searchInputs,
			"m0",
			validations,
			context,
			promptLookupNaming,
		),
	};
}
const field = (name: string) =>
	`instance('search-input:results')/input/field[@name='${name}']`;

// Private metadata and dependency contracts. Native SearchPromptRuntimeTest
// evaluates the same admitted exports with Core's actual query manager.
it("projects all widget attributes and preserves authored prompt order", () => {
	const { emission } = projection("prompt-widgets");
	expect(emission.elements.map((element) => element.attribs)).toEqual([
		{ key: "first_name" },
		{ key: "name_query", exclude: "true()" },
		{
			key: "visit_date",
			input: "date",
			default: "'2026-01-31'",
			exclude: "true()",
		},
		{ key: "period", input: "daterange" },
		{ key: "barcode", appearance: "barcode_scan", default: "'00123'" },
		{ key: "region", input: "select1", default: "'north'" },
		{ key: "regions", input: "select" },
		{ key: "hidden", hidden: "true", default: "'secret'", exclude: "true()" },
	]);
	expect(emission.instances).toEqual(
		new Set(["search-input:results", "commcaresession", "item-list:regions"]),
	);
});
it("binds each display and assertion locale to its own stable translation units", () => {
	const { emission, config } = projection("prompt-widgets");
	const expectedStrings: Record<string, string> = {};
	const expectedUnits: Record<string, unknown> = {};
	for (const input of config.searchInputs) {
		const locale = `search_property.m0.${input.name}`;
		expectedStrings[locale] = input.label;
		expectedUnits[locale] = makeTranslationUnitId(
			"search-input",
			input.uuid,
			"label",
		);
	}
	for (const [name, suffix, text, slot] of [
		["first_name", ".hint", "Use the registered name", "hint"],
		["first_name", ".required.text", "Add a name", "required-message"],
		["name_query", ".required.text", "Add either name", "required-message"],
	] as const) {
		expectedStrings[`search_property.m0.${name}${suffix}`] = text;
		expectedUnits[`search_property.m0.${name}${suffix}`] =
			makeTranslationUnitId("search-input", PROMPT_IDS[name], slot);
	}
	expectedStrings["search_property.m0.name_query.validation.0.text"] =
		"Start with a capital letter This search can't use both single and double quotation marks. Remove one kind and try again";
	expectedUnits["search_property.m0.name_query.validation.0.text"] = [
		makeTranslationUnitId(
			"search-input",
			PROMPT_IDS.name_query,
			"validation-message",
		),
		makeTranslationUnitId("system", "search-validation", "quote"),
	];
	expect(emission.strings).toEqual(expectedStrings);
	expect(emission.translationUnits).toEqual(expectedUnits);
	const prompts = emission.elements.map((element) =>
		readXmlEvidence(serializeXml(element)),
	);
	expect(
		prompts.map((prompt) => prompt.children.map((child) => child.name)),
	).toEqual([
		["display", "required"],
		["display", "required", "validation"],
		["display"],
		["display"],
		["display"],
		["display", "itemset"],
		["display", "itemset"],
		["display"],
	]);
	expect(onlyXml(xmlChildren(prompts[0], "required")).attributes).toEqual({
		test: "true()",
	});
	expect(onlyXml(xmlChildren(prompts[1], "required")).attributes).toEqual({
		test: `${field("first_name")} = ''`,
	});
});
it("binds both choice widgets to the entire filtered fixture row contract", () => {
	const { emission } = projection("prompt-widgets");
	for (const element of emission.elements.filter((element) =>
		["region", "regions"].includes(element.attribs.key),
	)) {
		const itemset = onlyXml(
			xmlChildren(readXmlEvidence(serializeXml(element)), "itemset"),
		);
		expect(itemset.attributes).toEqual({
			nodeset:
				"instance('item-list:regions')/regions_list/regions[group_name = instance('commcaresession')/session/user/data/region_group]",
		});
		expect(
			itemset.children.map((child) => [child.name, child.attributes]),
		).toEqual([
			["label", { ref: "label" }],
			["value", { ref: "code" }],
		]);
	}
});
it.each(promptScenarios)(
	"carries %s prompt trees, instance declarations and locale messages through both complete exports",
	(scenario) => {
		const { doc, emission } = projection(scenario);
		const hq = expandDoc(doc, { lookupNaming: promptLookupNaming });
		const zip = new AdmZip(
			compileCcz(hq, doc.appName, doc, {
				lookup: { naming: promptLookupNaming, fixtures: promptLookupFixtures },
			}),
		);
		const suite = readXmlEvidence(zip.readAsText("suite.xml"));
		const remote = onlyXml(xmlChildren(suite, "remote-request"));
		const query = onlyXml(
			xmlChildren(onlyXml(xmlChildren(remote, "session")), "query"),
		);
		const prompts = xmlChildren(query, "prompt");
		expect(prompts).toEqual(
			emission.elements.map((element) =>
				readXmlEvidence(serializeXml(element)),
			),
		);
		const properties = hq.modules[0].search_config.properties;
		expect(properties.map((property) => property.name)).toEqual(
			prompts.map((prompt) => prompt.attributes.key),
		);
		for (let i = 0; i < prompts.length; i++) {
			const validations = xmlChildren(prompts[i], "validation");
			expect(
				validations.map((validation) => validation.attributes.test),
			).toEqual(
				(properties[i].validations ?? []).map((validation) => validation.test),
			);
			expect(validations.length).toBeLessThanOrEqual(1);
		}
		const instances = new Set(
			xmlChildren(remote, "instance").map((instance) => instance.attributes.id),
		);
		for (const id of emission.instances)
			expect(instances.has(id), id).toBe(true);
		const strings = Object.fromEntries(
			zip
				.readAsText("default/app_strings.txt")
				.trim()
				.split("\n")
				.map((line) => {
					const split = line.indexOf("=");
					return [line.slice(0, split), line.slice(split + 1)];
				}),
		);
		expect(
			Object.fromEntries(
				Object.keys(emission.strings).map((key) => [key, strings[key]]),
			),
		).toEqual(emission.strings);
	},
);
it("assigns runtime guards to value dependencies across filters and sibling arms, leaving presence-only triggers unrestricted", () => {
	const { doc, config, context } = projection("prompt-guards");
	const ids = ["filter_value", "sibling", "owner", "trigger"].map(testUuid);
	config.searchInputs = ids.map((id, index) =>
		advancedSearchInputDef(
			id,
			["filter_value", "sibling", "owner", "trigger"][index],
			"Value",
			"text",
			matchAll(),
		),
	);
	config.filter = whenInput(
		input(ids[0]),
		eq(prop("patient", "first_name"), input(ids[0])),
	);
	config.searchInputs[2] = advancedSearchInputDef(
		ids[2],
		"owner",
		"Owner",
		"text",
		and(
			whenInput(
				input(ids[1]),
				eq(prop("patient", "first_name"), input(ids[1])),
			),
			whenInput(
				input(ids[3]),
				eq(prop("patient", "first_name"), literal("Ada")),
			),
		),
	);
	expect(runValidation(doc, promptLookupContext)).toEqual([]);
	const validations = buildRuntimeCsqlPromptValidations(
		composeXPathQueryEmission(config, "patient", context),
	);
	expect([...validations.keys()]).toEqual(["filter_value", "sibling"]);
	for (const [name, validation] of validations)
		expect(validation).toEqual({
			test: `not(count(${field(name)}) and (contains(${field(name)}, "'") and contains(${field(name)}, '"')))`,
			message:
				"This search can't use both single and double quotation marks. Remove one kind and try again",
			messageKey: "quote",
		});
});
it("refuses an internal lookup emission without the required naming snapshot", () => {
	const { config, context } = projection("prompt-widgets");
	expect(() =>
		buildSearchPrompts(config.searchInputs, "m0", undefined, context),
	).toThrow(
		/^searchPromptWire: a lookup-backed choice input reached wire emission with no lookup wire naming\./,
	);
});

it("uses readable label and required-message fallbacks without inventing a hint", () => {
	const { doc, config, context } = projection("prompt-widgets");
	const first = config.searchInputs[0];
	if (first.kind === "hidden")
		throw new Error("Fixture starts with a visible prompt");
	const { hint: _hint, ...withoutHint } = first;
	config.searchInputs = [{ ...withoutHint, label: "", required: {} }];
	expect(runValidation(doc, promptLookupContext)).toEqual([]);
	const emission = buildSearchPrompts(
		config.searchInputs,
		"m0",
		undefined,
		context,
	);
	expect(emission.strings).toEqual({
		"search_property.m0.first_name": "first_name",
		"search_property.m0.first_name.required.text":
			"Fill in this answer before searching.",
	});
	expect(emission.translationUnits).toEqual({
		"search_property.m0.first_name": makeTranslationUnitId(
			"search-input",
			first.uuid,
			"label",
		),
		"search_property.m0.first_name.required.text": makeTranslationUnitId(
			"system",
			"search-required",
			"default",
		),
	});
	expect(
		onlyXml(
			xmlChildren(
				readXmlEvidence(serializeXml(emission.elements[0])),
				"display",
			),
		).children.map((child) => child.name),
	).toEqual(["text"]);
});
