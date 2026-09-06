import type { MockAgent } from "undici";
import { expect, it } from "vitest";
import { withHttpPeer } from "@/__tests__/helpers/httpPeer";
import {
	projectSpaceAdvisoryUse,
	projectSpaceCapabilityUse,
} from "@/lib/publish/projectSpaceCompatibility";
import { probeHqProjectSpaceCompatibility } from "../client";
import type { HqProjectSpaceCompatibilityProbePlan } from "../projectSpaceCompatibility";

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
		name: "lost membership",
		body: {
			meta: { total_count: 1 },
			objects: [{ domain_name: "elsewhere", project_name: "Elsewhere" }],
		},
	},
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
