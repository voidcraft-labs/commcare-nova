import * as fc from "fast-check";
import type { MockAgent } from "undici";
import { expect, it } from "vitest";
import { withHttpPeer } from "@/__tests__/helpers/httpPeer";
import { rebuildFieldParent } from "@/lib/doc/fieldParent";
import type { BlueprintDoc, Module } from "@/lib/domain";
import {
	ancestorPath,
	count,
	eq,
	exists,
	gt,
	literal,
	prop,
	relationStep,
	subcasePath,
	term,
} from "@/lib/domain/predicate";
import type { Predicate } from "@/lib/domain/predicate/types";
import {
	projectSpaceAdvisoryUse,
	projectSpaceCapabilityUse,
} from "@/lib/publish/projectSpaceCompatibility";
import { probeHqProjectSpaceCompatibility } from "../client";
import { expandDoc } from "../expander";
import {
	type HqProjectSpaceCompatibilityProbePlan,
	projectSpaceCompatibilityProbePlan,
} from "../projectSpaceCompatibility";
import { parser } from "../xpath/parser";
import { assertGenerated, manifestFor } from "./compilerEvidence";
import { suiteDocArbitrary } from "./suiteDocArbitrary";
import { blueprintDocArbitrary } from "./xformDocArbitrary";

const CREDS = {
	username: "account",
	apiKey: "fixture-key",
	server: "india",
} as const;
const HOST = "https://india.commcarehq.org";
const DOMAINS = "/api/user_domains/v1/?limit=100";
const SEARCH = "/a/clinic/phone/search/?case_type=__nova_compatibility_probe__";
const capability = projectSpaceCapabilityUse("case-search", [
	"The Patients module uses Search.",
]);
const advisory = projectSpaceAdvisoryUse("large-search-performance", [
	"The Patients module uses Search.",
]);
const baseFlag = {
	id: "case-search-base",
	slug: "search_claim",
	namespace: "domain",
} as const;
const advancedFlag = {
	id: "advanced-case-search",
	slug: "case_search_advanced",
	namespace: "domain",
} as const;
const performanceFlag = {
	id: "large-search-performance",
	slug: "custom_properties",
	namespace: "domain",
} as const;
const visible = {
	meta: { total_count: 1 },
	objects: [{ domain_name: "clinic", project_name: "Clinic" }],
};
const empty = { meta: { total_count: 0 }, objects: [] };
function plan(
	advanced = false,
	optimization = false,
): HqProjectSpaceCompatibilityProbePlan {
	return {
		capabilities: [
			{
				capability,
				featureFlags: [baseFlag, ...(advanced ? [advancedFlag] : [])],
				runtimeProbes: ["case-search"],
			},
		],
		advisories: optimization
			? [{ advisory, featureFlags: [performanceFlag], runtimeProbes: [] }]
			: [],
	};
}
function request(peer: MockAgent, path: string) {
	return peer.get(HOST).intercept({
		method: "GET",
		path,
		headers: { authorization: "ApiKey account:fixture-key" },
	});
}
function flags(peer: MockAgent, base: object = visible) {
	request(peer, DOMAINS).reply(200, visible);
	request(peer, `${DOMAINS}&feature_flag=search_claim`).reply(200, base);
}
function urls(peer: MockAgent) {
	return (
		peer
			.getCallHistory()
			?.calls()
			.map((call) => call.fullUrl) ?? []
	);
}

it("combines exact flag and runtime evidence without leaking private settings into the report", async () => {
	await withHttpPeer(async (peer) => {
		flags(peer);
		request(peer, `${DOMAINS}&feature_flag=case_search_advanced`).reply(
			200,
			empty,
		);
		request(peer, `${DOMAINS}&feature_flag=custom_properties`).reply(
			200,
			visible,
		);
		request(peer, SEARCH).reply(200, "<fixture/>", {
			headers: { "content-type": "text/xml; charset=utf-8" },
		});
		const result = await probeHqProjectSpaceCompatibility(
			CREDS,
			"clinic",
			plan(true, true),
		);
		expect(result.capabilities).toEqual([{ capability, state: "missing" }]);
		expect(result.advisories).toEqual([{ advisory, state: "available" }]);
		expect(result.availableAdvisories).toEqual(["large-search-performance"]);
		expect(result.report.status).toBe("blocked");
		expect(result.report.blockers).toEqual([
			{ ...capability, state: "missing" },
		]);
		for (const privateValue of [
			"featureFlags",
			"runtimeProbes",
			"search_claim",
			"case_search_advanced",
			"custom_properties",
		])
			expect(JSON.stringify(result)).not.toContain(privateValue);
		expect(urls(peer).sort()).toEqual(
			[
				DOMAINS,
				`${DOMAINS}&feature_flag=search_claim`,
				`${DOMAINS}&feature_flag=case_search_advanced`,
				`${DOMAINS}&feature_flag=custom_properties`,
				SEARCH,
			]
				.map((path) => HOST + path)
				.sort(),
		);
	});
});

it.each([
	{
		status: 200,
		type: "text/xml; charset=utf-8",
		body: "<fixture/>",
		state: "available",
	},
	{
		status: 200,
		type: "application/xml",
		body: "<fixture/>",
		state: "available",
	},
	{
		status: 200,
		type: "text/html",
		body: "<html>Sign in</html>",
		state: "unverified",
	},
	{ status: 201, type: "text/xml", body: "<fixture/>", state: "unverified" },
	{ status: 302, type: "text/html", body: "Redirect", state: "unverified" },
	{
		status: 404,
		type: "text/plain",
		body: "Case search is not enabled for this project",
		state: "missing",
	},
	{
		status: 404,
		type: "text/plain",
		body: "Case search is not enabled for this project\n",
		state: "unverified",
	},
	{
		status: 404,
		type: "text/plain",
		body: "Application not found",
		state: "unverified",
	},
	{
		status: 403,
		type: "text/html",
		body: "<html><title>CommCare HQ</title>Permission denied</html>",
		state: "unverified",
		issue: "connected-account-permission",
	},
	{
		status: 403,
		type: "text/html",
		body: "<html><title>403 Forbidden</title>Proxy refusal</html>",
		state: "unverified",
	},
	{
		status: 401,
		type: "text/plain",
		body: "Unauthorized",
		state: "unverified",
	},
	{
		status: 503,
		type: "text/plain",
		body: "Service Temporarily Unavailable",
		state: "unverified",
	},
] as const)("Search $status ($body) yields $state", async (scenario) => {
	await withHttpPeer(async (peer) => {
		flags(peer);
		request(peer, SEARCH).reply(scenario.status, scenario.body, {
			headers: {
				"content-type": scenario.type,
				location: "https://elsewhere.example/search",
			},
		});
		const result = await probeHqProjectSpaceCompatibility(
			CREDS,
			"clinic",
			plan(),
		);
		const assessment = {
			capability,
			state: scenario.state,
			...("issue" in scenario ? { issue: scenario.issue } : {}),
		};
		expect(result.capabilities).toEqual([assessment]);
		expect(result.report.status).toBe(
			scenario.state === "available" ? "ready" : "blocked",
		);
		expect(result.report.message.includes("Mobile App Access")).toBe(
			"issue" in scenario,
		);
		expect(urls(peer)).toHaveLength(3);
		expect(urls(peer).every((url) => url.startsWith(`${HOST}/`))).toBe(true);
	});
});

it.each([
	{
		name: "missing domain identity",
		body: { meta: { total_count: 1 }, objects: [{ project_name: "Clinic" }] },
	},
	{
		name: "null count",
		body: { meta: { total_count: null }, objects: visible.objects },
	},
	{
		name: "foreign page",
		body: {
			meta: { total_count: 2, next: "https://elsewhere.example/list" },
			objects: visible.objects,
		},
	},
])("$name cannot establish that a setting is missing", async ({ body }) => {
	await withHttpPeer(async (peer) => {
		request(peer, DOMAINS).reply(200, body);
		const result = await probeHqProjectSpaceCompatibility(
			CREDS,
			"clinic",
			plan(true, true),
		);
		expect(result.capabilities).toEqual([{ capability, state: "unverified" }]);
		expect(result.advisories).toEqual([{ advisory, state: "unverified" }]);
		expect(result.availableAdvisories).toEqual([]);
		expect(urls(peer)).toEqual([HOST + DOMAINS]);
	});
});

it.each(["missing", "unverified"] as const)(
	"a %s optimization does not block available Search",
	async (state) => {
		await withHttpPeer(async (peer) => {
			flags(peer);
			request(peer, `${DOMAINS}&feature_flag=custom_properties`).reply(
				state === "missing" ? 200 : 400,
				state === "missing" ? empty : { error: "unknown flag" },
			);
			request(peer, SEARCH).reply(200, "<fixture/>", {
				headers: { "content-type": "text/xml" },
			});
			const result = await probeHqProjectSpaceCompatibility(
				CREDS,
				"clinic",
				plan(false, true),
			);
			expect(result.capabilities).toEqual([{ capability, state: "available" }]);
			expect(result.advisories).toEqual([{ advisory, state }]);
			expect(result.availableAdvisories).toEqual([]);
			expect(result.report.status).toBe("ready");
		});
	},
);

it("a retired required setting is unverified even if the runtime answers", async () => {
	await withHttpPeer(async (peer) => {
		request(peer, DOMAINS).reply(200, visible);
		request(peer, `${DOMAINS}&feature_flag=search_claim`).reply(400, {
			error: "unknown flag",
		});
		request(peer, SEARCH).reply(200, "<fixture/>", {
			headers: { "content-type": "text/xml" },
		});
		const result = await probeHqProjectSpaceCompatibility(
			CREDS,
			"clinic",
			plan(),
		);
		expect(result.capabilities).toEqual([{ capability, state: "unverified" }]);
	});
});

it("a confirmed missing flag takes precedence over unavailable runtime evidence", async () => {
	await withHttpPeer(async (peer) => {
		flags(peer, empty);
		request(peer, SEARCH).reply(503, "Unavailable");
		const result = await probeHqProjectSpaceCompatibility(
			CREDS,
			"clinic",
			plan(),
		);
		expect(result.capabilities).toEqual([{ capability, state: "missing" }]);
	});
});

it("no requirements and an invalid target issue no HTTP requests", async () => {
	await withHttpPeer(async (peer) => {
		const none = await probeHqProjectSpaceCompatibility(CREDS, "clinic", {
			capabilities: [],
			advisories: [],
		});
		expect(none.report.status).toBe("not_needed");
		expect(none.capabilities).toEqual([]);
		const invalid = await probeHqProjectSpaceCompatibility(
			CREDS,
			"../foreign",
			plan(),
		);
		expect(invalid.capabilities).toEqual([{ capability, state: "unverified" }]);
		expect(urls(peer)).toEqual([]);
	});
});

/*
 * The probe plan held to Nova's own emitted wire over the fuzz corpora: each
 * shape HQ's editors offer only under a flag is read off `expandDoc`'s HQ
 * JSON, and the plan asks for that flag exactly where the wire holds one.
 */
function flagsOf(doc: BlueprintDoc): Set<string> {
	return new Set(
		projectSpaceCompatibilityProbePlan(doc).capabilities.flatMap((plan) =>
			plan.featureFlags.map((flag) => flag.id),
		),
	);
}

function holdsWire(doc: BlueprintDoc): void {
	rebuildFieldParent(doc);
	const hq = expandDoc(doc, { assets: manifestFor(doc) });
	const flags = flagsOf(doc);
	const searched = hq.modules.filter(
		(module) =>
			module.search_config.properties.length > 0 ||
			module.search_config.default_properties.length > 0,
	);
	const advanced = searched.some(
		(module) =>
			module.search_config.inline_search ||
			module.search_config.properties.some(
				(property) =>
					property.exclude === true ||
					property.hidden === true ||
					(property.default_value ?? "") !== "" ||
					property.input_ === "date",
			),
	);
	expect({ advanced: flags.has("advanced-case-search") }).toEqual({
		advanced:
			advanced ||
			hq.modules.some((module) => module.case_details.short.multi_select),
	});
	expect({
		tiles: flags.has("case-tiles") && flags.has("custom-case-tiles"),
	}).toEqual({
		tiles: hq.modules.some(
			(module) => module.case_details.short.case_tile_template === "custom",
		),
	});
	expect({ related: flags.has("related-case-lookups") }).toEqual({
		related: searched.some(
			(module) =>
				module.search_config.include_all_related_cases ||
				module.search_config.default_properties.some((property) =>
					queryCallsRelatedCases(property.defaultValue),
				) ||
				(module.search_config.inline_search && module.parent_select.active),
		),
	});
}

/**
 * The CSQL functions HQ's case search refuses without its related-case
 * lookups (`case_search/filter_dsl.py::build_filter_from_ast`).
 */
const RELATED_CASE_CALLS = [
	"ancestor-exists(",
	"subcase-exists(",
	"subcase-count(",
] as const;

/**
 * Whether one `_xpath_query` value calls a related-case function. The value
 * is an on-device expression that builds the CSQL text from string literals
 * and runtime values; Nova's XPath grammar finds the literals, and a
 * function's name and opening parenthesis never straddle two of them, since
 * the emitter splits a constant only at a quote character.
 */
function queryCallsRelatedCases(source: string): boolean {
	let calls = false;
	parser.parse(source).iterate({
		enter(node) {
			if (node.name !== "StringLiteral") return;
			const text = source.slice(node.from + 1, node.to - 1);
			if (RELATED_CASE_CALLS.some((call) => text.includes(call))) calls = true;
		},
	});
	return calls;
}

/**
 * The search filters that do and do not read related cases, as a valid
 * document can hold them. The generator writes only a filter on the case's
 * own property, so the probe fuzz swaps one of these in where the module's
 * case type has the relation it reads.
 */
type FilterShape =
	| "own"
	| "ancestor-case-id"
	| "ancestor-property"
	| "subcase-exists"
	| "subcase-count";

const FILTER_SHAPES: readonly FilterShape[] = [
	"own",
	"ancestor-case-id",
	"ancestor-property",
	"subcase-exists",
	"subcase-count",
];

function relationFilter(
	doc: BlueprintDoc,
	module: Module,
	shape: FilterShape,
): Predicate | undefined {
	const caseType = module.caseType;
	if (caseType === undefined) return undefined;
	const types = doc.caseTypes ?? [];
	const parentType = types.find((type) => type.name === caseType)?.parent_type;
	const childType = types.find((type) => type.parent_type === caseType)?.name;
	const parent = ancestorPath(relationStep("parent"));
	switch (shape) {
		case "own":
			return undefined;
		case "ancestor-case-id":
			return parentType === undefined
				? undefined
				: eq(term(prop(parentType, "case_id", parent)), literal("abc"));
		case "ancestor-property":
			return parentType === undefined
				? undefined
				: eq(term(prop(parentType, "age", parent)), literal(18));
		case "subcase-exists":
			return childType === undefined
				? undefined
				: exists(subcasePath("parent", childType));
		case "subcase-count":
			return childType === undefined
				? undefined
				: gt(count(subcasePath("parent", childType)), literal(1));
	}
}

function withRelationFilters(
	doc: BlueprintDoc,
	shapes: readonly FilterShape[],
): BlueprintDoc {
	const modules = { ...doc.modules };
	doc.moduleOrder.forEach((uuid, index) => {
		const module = modules[uuid];
		const list = module.caseListConfig;
		if (list?.filter === undefined) return;
		const filter = relationFilter(doc, module, shapes[index % shapes.length]);
		if (filter === undefined) return;
		modules[uuid] = { ...module, caseListConfig: { ...list, filter } };
	});
	return { ...doc, modules };
}

const relationFilterDocArbitrary = fc
	.tuple(
		suiteDocArbitrary,
		fc.array(fc.constantFrom(...FILTER_SHAPES), {
			minLength: 4,
			maxLength: 4,
		}),
	)
	.map(([doc, shapes]) => withRelationFilters(doc, shapes));

it("asks for each flag exactly where Nova's emitted wire holds what HQ's editors offer only under it", {
	timeout: 120_000,
}, () => {
	assertGenerated(fc.property(relationFilterDocArbitrary, holdsWire), {
		seed: 20261016,
		numRuns: 200,
	});
	assertGenerated(fc.property(blueprintDocArbitrary, holdsWire), {
		seed: 20261016,
		numRuns: 100,
	});
});
