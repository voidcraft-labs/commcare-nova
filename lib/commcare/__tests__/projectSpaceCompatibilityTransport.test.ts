import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { withSocketHttpPeer } from "@/__tests__/helpers/httpPeer";
import { log } from "@/lib/logger";
import { projectSpaceCapabilityUse } from "@/lib/publish/projectSpaceCompatibility";
import { probeHqProjectSpaceCompatibility } from "../client";
import type { HqProjectSpaceCompatibilityProbePlan } from "../projectSpaceCompatibility";

const CREDS = {
	username: "account",
	apiKey: "fixture-key",
	server: "india",
} as const;
const DOMAINS = "/api/user_domains/v1/?limit=100";
const FLAG = `${DOMAINS}&feature_flag=search_claim`;
const SEARCH = "/a/clinic/phone/search/?case_type=__nova_compatibility_probe__";
const plan: HqProjectSpaceCompatibilityProbePlan = {
	capabilities: [
		{
			capability: projectSpaceCapabilityUse("case-search", [
				"This app uses Search.",
			]),
			featureFlags: [
				{ id: "case-search-base", slug: "search_claim", namespace: "domain" },
			],
			runtimeProbes: ["case-search"],
		},
	],
	advisories: [],
};
const visible = JSON.stringify({
	meta: { total_count: 1 },
	objects: [{ domain_name: "clinic", project_name: "Clinic" }],
});
afterEach(() => vi.useRealTimers());

it.each([
	{ name: "visibility headers", path: DOMAINS, status: null },
	{ name: "visibility body", path: DOMAINS, status: 200 },
	{ name: "flag headers", path: FLAG, status: null },
	{ name: "flag body", path: FLAG, status: 200 },
	{ name: "runtime headers", path: SEARCH, status: null },
	{ name: "configured-off body", path: SEARCH, status: 404 },
	{ name: "permission-refusal body", path: SEARCH, status: 403 },
	{
		name: "successful runtime body is cancelled unread",
		path: SEARCH,
		status: 200,
	},
])(
	"$name owns its socket through the 5-second check",
	async ({ path, status }) => {
		vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
		const reached = Promise.withResolvers<void>(),
			closed = Promise.withResolvers<void>();
		const calls: {
			path: string | undefined;
			method: string | undefined;
			authorization: string | undefined;
		}[] = [];
		let pending:
			| ReturnType<typeof probeHqProjectSpaceCompatibility>
			| undefined;
		try {
			await withSocketHttpPeer(
				"india.commcarehq.org",
				(request, response) => {
					calls.push({
						path: request.url,
						method: request.method,
						authorization: request.headers.authorization,
					});
					request.resume();
					if (request.url === path) {
						response.once("close", closed.resolve);
						if (status !== null) {
							response.writeHead(status, {
								"content-type":
									path === SEARCH && status === 200
										? "text/xml; charset=utf-8"
										: "application/json",
							});
							response.write(
								path === SEARCH ? "never-report-case-data" : '{"meta":',
							);
						}
						reached.resolve();
					} else if (request.url === DOMAINS || request.url === FLAG) {
						response.writeHead(200, { "content-type": "application/json" });
						response.end(visible);
					} else if (request.url === SEARCH) {
						response.writeHead(200, {
							"content-type": "text/xml; charset=utf-8",
						});
						response.end("<fixture/>");
					} else {
						response.writeHead(500);
						response.end("Unexpected path");
					}
				},
				async () => {
					let settled = false;
					pending = probeHqProjectSpaceCompatibility(
						CREDS,
						"clinic",
						plan,
					).then((result) => {
						settled = true;
						return result;
					});
					await reached.promise;
					await setImmediate();
					const available = path === SEARCH && status === 200;
					if (available) {
						// Let native delivery progress within the owned clock. Reading
						// this never-ending body must reach the deadline and fail the
						// available verdict, without leaving an unbounded test promise.
						for (let elapsed = 0; !settled && elapsed < 5_000; elapsed++) {
							await setImmediate();
							await vi.advanceTimersByTimeAsync(1);
						}
					} else {
						await vi.advanceTimersByTimeAsync(4_999);
						expect(settled).toBe(false);
						await vi.advanceTimersByTimeAsync(1);
					}
					await setImmediate();
					expect(settled).toBe(true);
					const result = await pending;
					expect(result.capabilities).toEqual([
						{
							capability: plan.capabilities[0].capability,
							state: available ? "available" : "unverified",
						},
					]);
					await closed.promise;
					expect(calls.map((call) => call.path).sort()).toEqual(
						(path === DOMAINS ? [DOMAINS] : [DOMAINS, FLAG, SEARCH]).sort(),
					);
					expect(
						calls.every(
							(call) =>
								call.method === "GET" &&
								call.authorization === "ApiKey account:fixture-key",
						),
					).toBe(true);
					expect(
						JSON.stringify([
							result,
							vi.mocked(log.warn).mock.calls,
							vi.mocked(log.error).mock.calls,
						]),
					).not.toContain("never-report-case-data");
				},
			);
		} finally {
			await pending;
		}
	},
);
