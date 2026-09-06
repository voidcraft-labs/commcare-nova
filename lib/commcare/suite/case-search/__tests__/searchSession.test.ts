import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { searchEmissionFixture } from "@/lib/commcare/__tests__/searchEmissionFixture";
import {
	onlyXml,
	readXmlEvidence,
	xmlChildren,
} from "@/lib/commcare/__tests__/xmlEvidence";
import { serializeXml } from "@/lib/commcare/serializeXml";
import { runValidation } from "@/lib/commcare/validator/runner";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	advancedSearchInputDef,
	blueprintDocSchema,
	calculatedColumn,
	proseText,
	simpleSearchInputDef,
} from "@/lib/domain";
import {
	ancestorPath,
	and,
	arith,
	dateAdd,
	dateCoerce,
	datetimeCoerce,
	double,
	eq,
	exists,
	gte,
	input,
	literal,
	lt,
	match,
	matchAll,
	or,
	prop,
	relationStep,
	term,
	whenInput,
} from "@/lib/domain/predicate";
import {
	buildSearchQuery,
	buildSearchSession,
	type SearchQueryArgs,
} from "../searchSession";
import {
	composeXPathQueryEmission,
	composeXPathQueryPredicate,
} from "../xpathQuery";

const ID = testUuid("query-contract");
const parent = ancestorPath(relationStep("parent", "patient"));
function fixture() {
	const doc = searchEmissionFixture("remote");
	const module = doc.modules[doc.moduleOrder[0]];
	const config = module.caseListConfig;
	if (!config || !doc.caseTypes?.[0])
		throw new Error("Fixture has a typed case list");
	doc.caseTypes[0].properties.push(
		{ name: "region", label: proseText("Region"), data_type: "text" },
		{ name: "age", label: proseText("Age"), data_type: "int" },
		{ name: "visit_date", label: proseText("Visit date"), data_type: "date" },
		{ name: "last_seen", label: proseText("Last seen"), data_type: "datetime" },
	);
	config.searchInputs = [];
	const args: SearchQueryArgs = {
		caseListConfig: config,
		caseSearchConfig: {},
		caseType: "patient",
		moduleIndex: 0,
		wire: { autoLaunch: false, defaultSearch: false, inlineSearch: false },
		typeContext: {
			caseTypes: doc.caseTypes,
			currentCaseType: "patient",
			knownInputs: [],
		},
	};
	return {
		doc,
		config,
		args,
		admitted() {
			blueprintDocSchema.parse(toPersistableDoc(doc));
			expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
			return args;
		},
	};
}
const queries = (args: SearchQueryArgs) =>
	xmlChildren(
		readXmlEvidence(serializeXml(buildSearchQuery(args).element)),
		"data",
	).map((node) => node.attributes);

// Private composition and dependency contracts. Full export/native session
// acceptance is owned by searchEmission and the native SearchRuntimeTest.
it("splits top-level conjunctions while preserving an OR as one complete clause", () => {
	const f = fixture();
	const regions = or(
		eq(prop("patient", "region"), literal("North")),
		eq(prop("patient", "region"), literal("South")),
	);
	const name = eq(prop("patient", "first_name"), literal("Ada"));
	f.config.filter = and(matchAll(), regions);
	f.config.searchInputs = [
		advancedSearchInputDef(ID, "name_query", "Name", "text", name),
	];
	const args = f.admitted();
	expect(
		composeXPathQueryPredicate(f.config, "patient", args.typeContext),
	).toEqual(and(regions, name));
	expect(queries(args)).toEqual([
		{ key: "case_type", ref: "'patient'" },
		{ key: "_xpath_query", ref: "\"region = 'North' or region = 'South'\"" },
		{ key: "_xpath_query", ref: "\"first_name = 'Ada'\"" },
	]);
});
it("removes an identity without changing the complete remaining fuzzy query and validation", () => {
	const f = fixture();
	f.config.searchInputs = [
		simpleSearchInputDef(ID, "name_query", "Name", "text", "first_name", {
			mode: { kind: "fuzzy" },
		}),
	];
	const without = buildSearchQuery(f.admitted());
	f.config.filter = and(
		matchAll(),
		or(matchAll(), eq(prop("patient", "region"), literal("North"))),
	);
	const withIdentity = buildSearchQuery(f.admitted());
	expect(serializeXml(withIdentity.element)).toBe(
		serializeXml(without.element),
	);
	expect(withIdentity.strings).toEqual(without.strings);
	expect(withIdentity.translationUnits).toEqual(without.translationUnits);
	expect(withIdentity.instances).toEqual(without.instances);
	expect(
		composeXPathQueryPredicate(f.config, "patient", f.args.typeContext),
	).toEqual(
		whenInput(
			input(ID),
			match(prop("patient", "first_name"), input(ID), "fuzzy"),
		),
	);
});
it.each(["exact", "fuzzy", "starts-with", "phonetic", "fuzzy-date"] as const)(
	"routes %s from the authored target and input identities",
	(mode) => {
		const f = fixture();
		const property = mode === "fuzzy-date" ? "visit_date" : "first_name";
		f.config.searchInputs = [
			simpleSearchInputDef(
				ID,
				"query_value",
				"Value",
				mode === "fuzzy-date" ? "date" : "text",
				property,
				{ mode: { kind: mode } },
			),
		];
		f.admitted();
		expect(
			composeXPathQueryPredicate(f.config, "patient", f.args.typeContext),
		).toEqual(
			whenInput(
				input(ID),
				mode === "exact"
					? eq(prop("patient", property), input(ID))
					: match(prop("patient", property), input(ID), mode),
			),
		);
		const query = readXmlEvidence(
			serializeXml(buildSearchQuery(f.args).element),
		);
		expect(onlyXml(xmlChildren(query, "prompt")).attributes.exclude).toBe(
			"true()",
		);
	},
);
it.each(["first_name", "visit_date"] as const)(
	"keeps the faithful bare-prompt route for %s",
	(property) => {
		const f = fixture();
		f.config.searchInputs = [
			simpleSearchInputDef(
				ID,
				property,
				"Value",
				property === "visit_date" ? "date-range" : "text",
				property,
			),
		];
		f.admitted();
		expect(
			composeXPathQueryPredicate(f.config, "patient", f.args.typeContext),
		).toBeUndefined();
		expect(queries(f.args)).toEqual([{ key: "case_type", ref: "'patient'" }]);
		const prompt = onlyXml(
			xmlChildren(
				readXmlEvidence(serializeXml(buildSearchQuery(f.args).element)),
				"prompt",
			),
		);
		expect(prompt.attributes).toEqual(
			property === "visit_date"
				? { key: property, input: "daterange" }
				: { key: property },
		);
	},
);
it.each(["visit_date", "last_seen"] as const)(
	"keeps both bounds of a related %s day under one quantifier",
	(property) => {
		const f = fixture();
		f.config.searchInputs = [
			simpleSearchInputDef(ID, "parent_day", "Parent day", "date", property, {
				via: parent,
			}),
		];
		f.admitted();
		const day = term(input(ID));
		const next = dateAdd(dateCoerce(day), "days", term(literal(1)));
		const bounds = and(
			gte(
				prop("patient", property),
				property === "visit_date" ? dateCoerce(day) : datetimeCoerce(day),
			),
			lt(
				prop("patient", property),
				property === "visit_date" ? next : datetimeCoerce(next),
			),
		);
		expect(
			composeXPathQueryPredicate(f.config, "patient", f.args.typeContext),
		).toEqual(whenInput(input(ID), exists(parent, bounds)));
		expect(queries(f.args).map((node) => node.key)).toEqual([
			"case_type",
			"_xpath_query",
		]);
	},
);
it("collects the input dependency inside a computed query value", () => {
	const f = fixture();
	f.config.filter = whenInput(
		input(ID),
		eq(
			prop("patient", "age"),
			arith("+", double(term(input(ID))), term(literal(1))),
		),
	);
	f.config.searchInputs = [
		advancedSearchInputDef(ID, "trigger", "Trigger", "text", matchAll()),
	];
	f.admitted();
	const query = buildSearchQuery(f.args);
	expect([...query.instances].sort()).toEqual([
		"casedb",
		"search-input:results",
	]);
	expect(queries(f.args).map((node) => node.key)).toEqual([
		"case_type",
		"_xpath_query",
	]);
	expect(
		composeXPathQueryPredicate(f.config, "patient", f.args.typeContext),
	).toEqual(f.config.filter);
});
it.each([false, true])(
	"collects emitted calculation dependencies and supporting cases, sorted=%s",
	(sorted) => {
		const f = fixture();
		const hidden = calculatedColumn(
			testUuid("hidden-parent"),
			"Parent name",
			term(prop("patient", "first_name", parent)),
			{
				visibleInList: false,
				visibleInDetail: false,
				...(sorted ? { sort: { direction: "asc" as const, priority: 0 } } : {}),
			},
		);
		f.config.columns.push(hidden);
		f.config.listColumnOrder.push(hidden.uuid);
		f.config.detailColumnOrder.push(hidden.uuid);
		f.admitted();
		const query = buildSearchQuery(f.args);
		expect([...query.instances]).toEqual(sorted ? ["casedb"] : []);
		expect(queries(f.args)).toEqual([
			{ key: "case_type", ref: "'patient'" },
			...(sorted
				? [{ key: "x_commcare_include_all_related_cases", ref: "'true'" }]
				: []),
		]);
	},
);
it("joins authored title/subtitle and prompt labels to their locale references", () => {
	const f = fixture();
	f.config.searchInputs = [
		simpleSearchInputDef(
			ID,
			"first_name",
			"Patient name",
			"text",
			"first_name",
		),
	];
	const args = {
		...f.admitted(),
		caseSearchConfig: {
			searchScreenTitle: "Find a patient",
			searchScreenSubtitle: "A name can help.",
		},
	};
	const result = buildSearchQuery(args);
	const query = readXmlEvidence(serializeXml(result.element));
	expect(query.children.map((node) => node.name)).toEqual([
		"title",
		"description",
		"data",
		"prompt",
	]);
	for (const [element, id] of [
		["title", "case_search.m0.inputs"],
		["description", "case_search.m0.description"],
	]) {
		expect(
			onlyXml(
				xmlChildren(
					onlyXml(xmlChildren(onlyXml(xmlChildren(query, element)), "text")),
					"locale",
				),
			).attributes,
		).toEqual({ id });
	}
	expect(result.strings).toEqual({
		"case_search.m0.inputs": "Find a patient",
		"case_search.m0.description": "A name can help.",
		"search_property.m0.first_name": "Patient name",
	});
	const uncustomized = buildSearchQuery(f.args);
	expect(uncustomized.strings).toEqual({
		"case_search.m0.inputs": "Search",
		"search_property.m0.first_name": "Patient name",
	});
	expect(
		xmlChildren(
			readXmlEvidence(serializeXml(uncustomized.element)),
			"description",
		),
	).toEqual([]);
});
it.each([false, true])(
	"carries a confirmation detail only when one is emitted: %s",
	(hasDetailScreen) => {
		const f = fixture();
		const result = buildSearchSession({ ...f.admitted(), hasDetailScreen });
		const session = readXmlEvidence(serializeXml(result.element));
		expect(session.children.map((node) => node.name)).toEqual([
			"query",
			"datum",
		]);
		expect(onlyXml(xmlChildren(session, "datum")).attributes).toEqual({
			id: "search_case_id",
			nodeset:
				"instance('results')/results/case[@case_type='patient'][not(commcare_is_related_case=true())]",
			value: "./@case_id",
			"detail-select": "m0_search_short",
			...(hasDetailScreen ? { "detail-confirm": "m0_search_long" } : {}),
		});
		expect([...result.instances]).toEqual([
			"casedb",
			"commcaresession",
			"results",
		]);
	},
);
it("refuses bare input references and property-to-property CSQL after an explicit validator bypass", () => {
	const f = fixture();
	f.config.searchInputs = [
		advancedSearchInputDef(ID, "query_value", "Value", "text", matchAll()),
	];
	f.admitted();
	f.config.filter = eq(prop("patient", "first_name"), input(ID));
	expect(() =>
		composeXPathQueryEmission(f.config, "patient", f.args.typeContext),
	).toThrow(/bare search-input reference/);
	f.config.filter = eq(
		prop("patient", "first_name"),
		prop("patient", "region"),
	);
	expect(() =>
		composeXPathQueryEmission(f.config, "patient", f.args.typeContext),
	).toThrow(/composed _xpath_query predicate is not representable/);
});
