import AdmZip from "adm-zip";
import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { TEST_RUNTIME_TARGET } from "@/lib/commcare/__tests__/runtimeTargetFixture";
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
import { moduleExpressionContexts } from "@/lib/commcare/expressionContext";
import { serializeXml } from "@/lib/commcare/serializeXml";
import { runValidation } from "@/lib/commcare/validator/runner";
import { serializeWire } from "@/lib/commcare/xpath/wire/serialize";
import {
	advancedSearchInputDef,
	isSelectSearchInput,
	makeTranslationUnitId,
} from "@/lib/domain";
import {
	and,
	eq,
	input,
	literal,
	matchAll,
	prop,
	whenInput,
} from "@/lib/domain/expression";
import { buildSearchPrompts, searchPromptWire } from "../searchPrompts";
import {
	buildRuntimeCsqlPromptValidations,
	composeXPathQueryEmission,
} from "../xpathQuery";

function projection(scenario: (typeof promptScenarios)[number]) {
	const doc = searchPromptFixture(scenario);
	const config = doc.modules[doc.moduleOrder[0]].caseListConfig;
	if (!config) throw new Error("Fixture has a case list");
	const expressions = moduleExpressionContexts(
		doc,
		doc.moduleOrder[0],
		promptLookupNaming,
	);
	const validations = buildRuntimeCsqlPromptValidations(
		composeXPathQueryEmission(
			config,
			"patient",
			expressions({ slot: "case_list_filter" }),
			promptLookupNaming,
		),
	);
	return {
		doc,
		config,
		expressions,
		validations,
		emission: buildSearchPrompts(
			config.searchInputs,
			"m0",
			validations,
			expressions,
			promptLookupNaming,
		),
	};
}
const field = (name: string) =>
	`instance('search-input:results')/input/field[@name = '${name}']`;

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
	expect(emission.instances.map(({ id }) => id)).toEqual([
		"commcaresession",
		"item-list:regions",
		"search-input:results",
	]);
});
it("prints receivers from the current address field name and retains their fallback order", () => {
	const { doc, config, expressions } = projection("prompt-widgets");
	const source = {
		kind: "address",
		type: "address",
		uuid: testUuid("search-address"),
		name: "address",
		label: "Address",
	} as const;
	const receiver = config.searchInputs[0];
	if (
		receiver.kind === "hidden" ||
		receiver.kind === "address" ||
		receiver.type !== "text"
	)
		throw new Error("The fixture starts with a text search field");
	const linked = {
		...receiver,
		addressReceiver: {
			kind: "address",
			source: source.uuid,
			parts: ["us_state", "city"] as ("us_state" | "city")[],
		},
	} as const;
	config.searchInputs = [source, linked];
	const elements = () =>
		buildSearchPrompts(
			config.searchInputs,
			"m0",
			undefined,
			expressions,
		).elements.map((element) => element.attribs);
	expect(runValidation(doc, promptLookupContext)).toEqual([]);
	expect(elements()).toEqual([
		{ key: "address", input: "address" },
		{ key: receiver.name, receive: "address-us_state||city" },
	]);
	config.searchInputs[0] = { ...source, name: "visit_address" };
	expect(elements()[1]).toMatchObject({
		receive: "visit_address-us_state||city",
	});
	config.searchInputs.shift();
	expect(runValidation(doc, promptLookupContext)).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				code: "CASE_LIST_SEARCH_ADDRESS_FIELD",
				details: expect.objectContaining({ reason: "source-link" }),
			}),
		]),
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
		test: `string-length(string(if(count(instance('search-input:results')/input/field) > 0, ${field("first_name")}, ''))) = 0`,
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
			["sort", { ref: "label" }],
		]);
	}
});
it("sorts lookup choices by the chosen column, the label column by default", () => {
	const { config, expressions, validations } = projection("prompt-widgets");
	const sortedByCode = config.searchInputs.map((searchInput) =>
		isSelectSearchInput(searchInput) && searchInput.options.kind === "lookup"
			? {
					...searchInput,
					options: {
						...searchInput.options,
						sortColumnId: searchInput.options.valueColumnId,
					},
				}
			: searchInput,
	);
	const emission = buildSearchPrompts(
		sortedByCode,
		"m0",
		validations,
		expressions,
		promptLookupNaming,
	);
	const sortRefs = emission.elements
		.filter((element) => ["region", "regions"].includes(element.attribs.key))
		.map(
			(element) =>
				onlyXml(
					xmlChildren(
						onlyXml(
							xmlChildren(readXmlEvidence(serializeXml(element)), "itemset"),
						),
						"sort",
					),
				).attributes,
		);
	expect(sortRefs).toEqual([{ ref: "code" }, { ref: "code" }]);
});
it.each(promptScenarios)(
	"carries %s prompt trees, instance declarations and locale messages through both complete exports",
	(scenario) => {
		const { doc, config, expressions, validations, emission } =
			projection(scenario);
		const hq = expandDoc(doc, { lookupNaming: promptLookupNaming });
		const zip = new AdmZip(
			compileCcz(hq, doc.appName, doc, {
				runtimeTarget: TEST_RUNTIME_TARGET,
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
			const promptValidations = xmlChildren(prompts[i], "validation");
			const input = config.searchInputs[i];
			const wire = searchPromptWire(
				input,
				validations.get(input.name),
				expressions,
				promptLookupNaming,
			);
			// HQ's validation slot interpolates hashtags without dot expansion;
			// the HQ source and the direct suite use their respective modes.
			expect(
				(properties[i].validations ?? []).map((validation) => validation.test),
			).toEqual(
				wire.validation === undefined
					? []
					: [
							serializeWire(wire.validation.test, {
								target: "hq-json",
								interpolation: "no-dots",
							}).text,
						],
			);
			expect(promptValidations.length).toBeLessThanOrEqual(1);
		}
		const instances = new Set(
			xmlChildren(remote, "instance").map((instance) => instance.attributes.id),
		);
		for (const { id } of emission.instances)
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
	const { doc, config, expressions } = projection("prompt-guards");
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
		composeXPathQueryEmission(
			config,
			"patient",
			expressions({ slot: "case_list_filter" }),
		),
	);
	expect([...validations.keys()]).toEqual(["filter_value", "sibling"]);
	for (const [name, validation] of validations)
		expect({
			...validation,
			test: serializeWire(validation.test, { target: "suite" }).text,
		}).toEqual({
			test: `not(count(${field(name)}) and contains(${field(name)}, "'") and contains(${field(name)}, '"'))`,
			message:
				"This search can't use both single and double quotation marks. Remove one kind and try again",
			messageKey: "quote",
		});
});
it("refuses an internal lookup emission without the required naming snapshot", () => {
	const { config, expressions } = projection("prompt-widgets");
	expect(() =>
		buildSearchPrompts(config.searchInputs, "m0", undefined, expressions),
	).toThrow(
		/^searchPromptWire: a lookup-backed choice input reached wire emission with no lookup wire naming\./,
	);
});

it("uses readable label and required-message fallbacks without inventing a hint", () => {
	const { doc, config, expressions } = projection("prompt-widgets");
	const first = config.searchInputs[0];
	if (first.kind === "hidden" || first.kind === "address")
		throw new Error("Fixture starts with a visible prompt");
	const { hint: _hint, ...withoutHint } = first;
	config.searchInputs = [{ ...withoutHint, label: "", required: {} }];
	expect(runValidation(doc, promptLookupContext)).toEqual([]);
	const emission = buildSearchPrompts(
		config.searchInputs,
		"m0",
		undefined,
		expressions,
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

// HQ's build writes a requirement whose text is blank in every language as a blank app string
// (`remote_requests.py::build_query_prompts` writes its `<text>` whenever the test exists;
// `app_strings.py` gives it `clean_trans({})`), so Core reports a blank message
// (`QueryPrompt.getRequiredMessage`); a validation with no text gets none
// (`if validation.has_text`), and Core reports its own sentence
// (`QueryPrompt.getValidationMessage`). Nova's suite writes each the same way.
it("writes a requirement with no message blank and a check with none of its own with no text", () => {
	const { doc, config, expressions } = projection("prompt-widgets");
	const first = config.searchInputs[0];
	if (first.kind === "hidden" || first.kind === "address")
		throw new Error("Fixture starts with a visible prompt");
	const { hint: _hint, ...withoutHint } = first;
	config.searchInputs = [
		{
			...withoutHint,
			required: { noMessage: true },
			validation: { rule: eq(input(first.uuid), literal("north")) },
		},
	];
	expect(runValidation(doc, promptLookupContext)).toEqual([]);
	const prompts = buildSearchPrompts(
		config.searchInputs,
		"m0",
		new Map(),
		expressions,
	);
	const key = `search_property.m0.${first.name}`;
	expect(prompts.strings[`${key}.required.text`]).toBe("");
	expect(prompts.translationUnits[`${key}.required.text`]).toEqual([]);
	expect(prompts.strings).not.toHaveProperty(`${key}.validation.0.text`);
	const prompt = readXmlEvidence(serializeXml(prompts.elements[0]));
	expect(
		onlyXml(xmlChildren(prompt, "required")).children.map(
			(child) => child.name,
		),
	).toEqual(["text"]);
	expect(onlyXml(xmlChildren(prompt, "validation")).children).toEqual([]);
});

// A field that lets workers search for blank carries HQ's `allow_blank_value`
// on both wires: the suite prompt's attribute Core and Formplayer read
// (`QueryPromptParser`), and the Case List page's stored flag HQ's build reads
// (`remote_requests.py::build_query_prompts`).
it("marks a field that searches for blank on both wires", () => {
	const doc = searchPromptFixture("prompt-widgets");
	const moduleUuid = doc.moduleOrder[0];
	const expressions = moduleExpressionContexts(
		doc,
		moduleUuid,
		promptLookupNaming,
	);
	const village = {
		uuid: testUuid("village"),
		name: "village",
		label: "Village",
		kind: "simple",
		type: "text",
		property: "village",
		allowBlank: true,
	} as const;
	expect(searchPromptWire(village, undefined, expressions).allowBlank).toBe(
		true,
	);
	const { allowBlank: _allowBlank, ...plain } = village;
	expect(searchPromptWire(plain, undefined, expressions).allowBlank).toBe(
		false,
	);
	const prompts = buildSearchPrompts([village], "m0", new Map(), expressions);
	expect(serializeXml(prompts.elements[0])).toContain(
		'allow_blank_value="true"',
	);
	const bare = buildSearchPrompts([plain], "m0", new Map(), expressions);
	expect(serializeXml(bare.elements[0])).not.toContain("allow_blank_value");
});

// A hidden field with no value is a hidden, excluded prompt with no `default`: Core seeds no
// answer for it (`RemoteQuerySessionManager.initUserAnswers`), and HQ's Case List page writes the
// same prompt for a field hidden and left out of the request with no starting value.
it("emits a hidden field with no value as a hidden prompt with no default", () => {
	const { doc, config, expressions } = projection("prompt-widgets");
	config.searchInputs = config.searchInputs.map((one) => {
		if (one.kind !== "hidden") return one;
		const { value: _value, ...rest } = one;
		return rest;
	});
	expect(runValidation(doc, promptLookupContext)).toEqual([]);
	const emission = buildSearchPrompts(
		config.searchInputs,
		"m0",
		undefined,
		expressions,
		promptLookupNaming,
	);
	expect(emission.elements.at(-1)?.attribs).toEqual({
		key: "hidden",
		hidden: "true",
		exclude: "true()",
	});
});

// A field Web Apps does not draw keeps its widget, its match and its starting value, with
// `hidden="true"` beside them: matched by its own name it rides the bare prompt, so Core sends its
// starting value as a filter (`RemoteQuerySessionManager.getRawQueryParams`).
it("emits a field Web Apps does not draw as its prompt with hidden beside it", () => {
	const { doc, config, expressions } = projection("prompt-widgets");
	config.searchInputs = config.searchInputs.map((one) =>
		one.kind === "simple" && one.name === "first_name"
			? (() => {
					const { hint: _hint, required: _required, ...rest } = one;
					return { ...rest, hidden: true as const };
				})()
			: one.kind === "simple" && one.name === "region"
				? { ...one, hidden: true as const }
				: one,
	);
	expect(runValidation(doc, promptLookupContext)).toEqual([]);
	const emission = buildSearchPrompts(
		config.searchInputs,
		"m0",
		undefined,
		expressions,
		promptLookupNaming,
	);
	const attribs = emission.elements.map((element) => element.attribs);
	expect(attribs.find((one) => one.key === "first_name")).toEqual({
		key: "first_name",
		hidden: "true",
	});
	expect(attribs.find((one) => one.key === "region")).toEqual({
		key: "region",
		hidden: "true",
		input: "select1",
		default: "'north'",
	});
});
