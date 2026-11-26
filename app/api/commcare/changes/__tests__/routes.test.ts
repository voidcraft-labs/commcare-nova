/**
 * The three routes of changes made in CommCare HQ as shells over their
 * services: who may call them, the bodies they accept, that every answer of
 * a review and of a bring-in rides the stream's one last line, that a throw
 * ends the stream in one `failed` line, that the check answers a list on
 * every outcome past authorization, which signal each hands its service, and
 * the host that reaches them.
 *
 * The services are replaced, since what a review, a bring-in and a check
 * answer is `lib/deployment`'s to test. A caller with no `edit` who reaches a
 * read of CommCare HQ, an answer thrown away as an error status, a check
 * that fails loudly in the builder, two last lines, a closed tab that leaves
 * a review running or stops a bring-in, and the deploy-time 404 of a route
 * the main host's allowlist does not reach are what these cases would catch.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/apiError";
import { AppAccessError, resolveAppScope } from "@/lib/db/appAccess";
import type { DeploymentView } from "@/lib/deployment/actions";
import {
	bringInHqChanges,
	checkHqChangesForApp,
	type HqChangesOutcome,
	type HqChangesProgress,
	type HqChangesReview,
	reviewHqChanges,
} from "@/lib/deployment/hqChanges";
import { HOSTNAMES, isPathAllowedOnHost } from "@/lib/hostnames";
import { log } from "@/lib/logger";
import { circumstanceFinding } from "@/lib/publish/hqFindings";
import { READING_REFUSAL_COPY } from "@/lib/publish/hqReadingCopy";
import { POST as bringInPost } from "../bring-in/route";
import { POST as checkPost } from "../check/route";
import { POST as reviewPost } from "../review/route";

const { requireSessionMock } = vi.hoisted(() => ({
	requireSessionMock: vi.fn(),
}));

vi.mock("@/lib/auth-utils", () => ({ requireSession: requireSessionMock }));
vi.mock("@/lib/db/appAccess", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/db/appAccess")>()),
	resolveAppScope: vi.fn(),
}));
vi.mock("@/lib/deployment/hqChanges", () => ({
	reviewHqChanges: vi.fn(),
	bringInHqChanges: vi.fn(),
	checkHqChangesForApp: vi.fn(),
}));

const USER = "changes-member";
const PROJECT = "changes-project";
const APP = "changes-app";
const KEY = { appId: APP, server: "india", domain: "clinic-2" } as const;
const BRING_IN = {
	...KEY,
	readingId: "01936a52-7c00-7000-8000-000000000001",
	reviewDigest: "f".repeat(64),
	tableChoices: { districts: "use-project" },
	ownerRuleChoices: { clinic: "worker" },
} as const;
const SCOPE = {
	appId: APP,
	projectId: PROJECT,
	role: "editor",
	actorUserId: USER,
};
const TARGET = { server: KEY.server, domain: KEY.domain };

type Route = "review" | "bring-in" | "check";
const ROUTES: readonly Route[] = ["review", "bring-in", "check"];
const BODY: Record<Route, unknown> = {
	review: KEY,
	"bring-in": BRING_IN,
	check: { appId: APP },
};

function request(route: Route, body: unknown, signal?: AbortSignal): Request {
	return new Request(`http://localhost/api/commcare/changes/${route}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: typeof body === "string" ? body : JSON.stringify(body),
		...(signal !== undefined && { signal }),
	});
}

function post(route: Route, req: Request): Promise<Response> {
	switch (route) {
		case "review":
			return reviewPost(req);
		case "bring-in":
			return bringInPost(req);
		case "check":
			return checkPost(req);
	}
}

function service(route: Route) {
	switch (route) {
		case "review":
			return vi.mocked(reviewHqChanges);
		case "bring-in":
			return vi.mocked(bringInHqChanges);
		case "check":
			return vi.mocked(checkHqChangesForApp);
	}
}

/** Every line of a stream, parsed. Reads the whole body, so no stream is left open. */
async function lines(response: Response): Promise<unknown[]> {
	const text = await response.text();
	expect(text.endsWith("\n")).toBe(true);
	return text
		.slice(0, -1)
		.split("\n")
		.map((line) => JSON.parse(line) as unknown);
}

const STOP = circumstanceFinding("hq-unavailable", { kind: "app" }, {});

/** A record as the store reads it back stands in for the card's view: the shell passes it through. */
const VIEW = {
	deployment: { deployment: { id: "deployment-1" } },
	leftBehind: [],
	kept: null,
	firstPublish: null,
} as unknown as DeploymentView;

const REVIEWS: readonly [string, HqChangesReview][] = [
	[
		"nothing",
		{
			kind: "nothing",
			reason: "unchanged",
			since: { kind: "published" },
			hqChanges: [],
			publishChanges: [],
			readingId: null,
			reviewDigest: null,
		},
	],
	[
		"changes",
		{
			kind: "changes",
			since: { kind: "changes-brought-in" },
			hqChanges: ["The app's name"],
			novaChanges: [],
			madeBy: [],
			caseData: [],
			publishChanges: [],
			observedDigest: "a".repeat(64),
			renamedInNova: [],
			tables: [],
			ownerRules: [],
			projectName: "Field team",
			readingId: BRING_IN.readingId,
			reviewDigest: BRING_IN.reviewDigest,
		},
	],
	[
		"account",
		{
			kind: "account",
			findings: [],
			more: 0,
			counts: { notYet: 1, never: 0, fixInHq: 0 },
		},
	],
	[
		"held",
		{
			kind: "held",
			reason: "runs-elsewhere",
			runs: { app: ["android", "web-apps"], hq: ["android"] },
		},
	],
	[
		"unavailable",
		{
			kind: "unavailable",
			reason: "nova-defect",
			since: { kind: "published" },
		},
	],
	["stop", { kind: "stop", finding: STOP }],
];

const OUTCOMES: readonly [string, HqChangesOutcome][] = [
	[
		"brought-in",
		{ kind: "brought-in", seq: 7, discarded: false, deployment: VIEW },
	],
	["recorded", { kind: "recorded", deployment: VIEW }],
	[
		"changed",
		{
			kind: "changed",
			now: { kind: "unavailable", reason: "no-reference", since: null },
			editedBy: "Asha",
		},
	],
	[
		"gate",
		{
			kind: "gate",
			findings: ["An automation reads a property."],
			details: ["The automation reads the property `age`."],
		},
	],
	["refused", { kind: "refused", message: "Nova stopped publishing here." }],
];

const STAGES: readonly HqChangesProgress[] = [
	{ type: "stage", stage: "reading-app" },
	{ type: "stage", stage: "checking-media" },
	{ type: "files", done: 1, total: 2 },
	{ type: "stage", stage: "checking" },
];

beforeEach(() => {
	requireSessionMock.mockReset();
	requireSessionMock.mockResolvedValue({
		user: { id: USER },
		session: { id: "browser-session" },
	});
	vi.mocked(resolveAppScope).mockReset();
	vi.mocked(resolveAppScope).mockResolvedValue({
		projectId: PROJECT,
		role: "editor",
		actorUserId: USER,
	});
	vi.mocked(reviewHqChanges).mockReset();
	vi.mocked(bringInHqChanges).mockReset();
	vi.mocked(checkHqChangesForApp).mockReset();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe.each(ROUTES)("the %s route before any read", (route) => {
	it("answers 401 without a session and asks nothing", async () => {
		requireSessionMock.mockRejectedValue(
			new ApiError("Authentication required", 401),
		);
		const response = await post(route, request(route, BODY[route]));
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({
			error: "Authentication required",
		});
		expect(resolveAppScope).not.toHaveBeenCalled();
		expect(service(route)).not.toHaveBeenCalled();
	});

	it("refuses a caller with no edit on the app as not found, before any read", async () => {
		vi.mocked(resolveAppScope).mockRejectedValue(
			new AppAccessError("insufficient_role"),
		);
		const response = await post(route, request(route, BODY[route]));
		expect(response.status).toBe(404);
		expect(vi.mocked(resolveAppScope).mock.calls).toEqual([
			[APP, USER, "edit"],
		]);
		expect(service(route)).not.toHaveBeenCalled();
	});

	it("answers 400 for a body that holds a key the route does not take, and asks nothing", async () => {
		vi.spyOn(log, "warn").mockImplementation(() => {});
		const response = await post(
			route,
			request(route, { ...(BODY[route] as object), planted: "value" }),
		);
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: READING_REFUSAL_COPY.invalid_input,
			code: "invalid_input",
		});
		expect(resolveAppScope).not.toHaveBeenCalled();
		expect(service(route)).not.toHaveBeenCalled();
	});
});

describe("the review route", () => {
	it.each(REVIEWS)(
		"answers 200 with the stages and then %s on the one last line",
		async (_, review) => {
			vi.mocked(reviewHqChanges).mockImplementation(
				async (_scope, _target, { onEvent }) => {
					for (const event of STAGES) onEvent(event);
					return review;
				},
			);
			const response = await post("review", request("review", KEY));
			expect(response.status).toBe(200);
			expect(response.headers.get("Content-Type")).toBe(
				"application/x-ndjson; charset=utf-8",
			);
			expect(await lines(response)).toEqual([
				...STAGES,
				{ type: "done", answer: review },
			]);
		},
	);

	it("hands the review the scope, the target and the request's own signal", async () => {
		vi.mocked(reviewHqChanges).mockResolvedValue(REVIEWS[0][1]);
		const controller = new AbortController();
		const req = request("review", KEY, controller.signal);
		await lines(await post("review", req));
		const [scope, target, options] =
			vi.mocked(reviewHqChanges).mock.calls[0] ?? [];
		expect(scope).toEqual({ ...SCOPE, requireOperation: expect.any(Function) });
		expect(target).toEqual(TARGET);
		expect(options?.cancel).toBe(req.signal);
	});

	it("ends a review that throws in one failed line and one error log", async () => {
		const error = vi.spyOn(log, "error").mockImplementation(() => {});
		vi.mocked(reviewHqChanges).mockImplementation(
			async (_scope, _target, { onEvent }) => {
				onEvent({ type: "stage", stage: "reading-app" });
				throw new Error("the store went away");
			},
		);
		const response = await post("review", request("review", KEY));
		expect(response.status).toBe(200);
		expect(await lines(response)).toEqual([
			{ type: "stage", stage: "reading-app" },
			{ type: "failed" },
		]);
		expect(error).toHaveBeenCalledTimes(1);
		expect(error.mock.calls[0]?.[2]).toEqual({
			appId: APP,
			projectId: PROJECT,
			userId: USER,
			operation: "review",
			phase: "reading-app",
		});
	});
});

describe("the bring-in route", () => {
	it.each(OUTCOMES)(
		"answers 200 with the stages and then %s on the one last line",
		async (_, outcome) => {
			vi.mocked(bringInHqChanges).mockImplementation(
				async (_scope, _target, _input, { onEvent }) => {
					for (const event of STAGES) onEvent(event);
					onEvent({ type: "stage", stage: "adding-media" });
					onEvent({ type: "stage", stage: "bringing-in" });
					return outcome;
				},
			);
			const response = await post("bring-in", request("bring-in", BRING_IN));
			expect(response.status).toBe(200);
			expect(await lines(response)).toEqual([
				...STAGES,
				{ type: "stage", stage: "adding-media" },
				{ type: "stage", stage: "bringing-in" },
				{ type: "done", answer: outcome },
			]);
		},
	);

	it("hands the bring-in the reviewed reading, its digest and the answers, and no signal", async () => {
		vi.mocked(bringInHqChanges).mockResolvedValue(OUTCOMES[0][1]);
		await lines(await post("bring-in", request("bring-in", BRING_IN)));
		const call = vi.mocked(bringInHqChanges).mock.calls[0];
		expect(call?.[0]).toEqual({
			...SCOPE,
			requireOperation: expect.any(Function),
		});
		expect(call?.[1]).toEqual(TARGET);
		expect(call?.[2]).toEqual({
			readingId: BRING_IN.readingId,
			reviewDigest: BRING_IN.reviewDigest,
			tableChoices: BRING_IN.tableChoices,
			ownerRuleChoices: BRING_IN.ownerRuleChoices,
		});
		expect(Object.keys(call?.[3] ?? {})).toEqual(["onEvent"]);
	});

	it("answers 400 for a table answer that is no choice the review offers", async () => {
		vi.spyOn(log, "warn").mockImplementation(() => {});
		const response = await post(
			"bring-in",
			request("bring-in", {
				...BRING_IN,
				tableChoices: { districts: "planted" },
			}),
		);
		expect(response.status).toBe(400);
		expect(bringInHqChanges).not.toHaveBeenCalled();
	});
});

describe("the check route", () => {
	it("answers 200 with each changed project space", async () => {
		vi.mocked(checkHqChangesForApp).mockResolvedValue([
			{ server: "india", domain: "clinic-2" },
		]);
		const response = await post("check", request("check", { appId: APP }));
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			changed: [{ server: "india", domain: "clinic-2" }],
		});
	});

	it("answers 200 with an empty list where nothing changed", async () => {
		vi.mocked(checkHqChangesForApp).mockResolvedValue([]);
		const response = await post("check", request("check", { appId: APP }));
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ changed: [] });
	});

	it("answers 200 with an empty list when its service throws, and warns with the app's id alone", async () => {
		const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
		vi.mocked(checkHqChangesForApp).mockRejectedValue(
			new Error("the store went away"),
		);
		const response = await post("check", request("check", { appId: APP }));
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ changed: [] });
		expect(warn).toHaveBeenCalledWith("[hq-changes] check failed", {
			appId: APP,
		});
	});

	it("hands the check the scope and the request's own signal", async () => {
		vi.mocked(checkHqChangesForApp).mockResolvedValue([]);
		const controller = new AbortController();
		const req = request("check", { appId: APP }, controller.signal);
		await (await post("check", req)).json();
		const [scope, options] =
			vi.mocked(checkHqChangesForApp).mock.calls[0] ?? [];
		expect(scope).toEqual({ ...SCOPE, requireOperation: expect.any(Function) });
		expect(options?.cancel).toBe(req.signal);
	});
});

describe("the hosts", () => {
	it.each([
		"/api/commcare/changes/review",
		"/api/commcare/changes/bring-in",
		"/api/commcare/changes/check",
	])("serves %s on the main host alone", (path) => {
		expect(isPathAllowedOnHost(HOSTNAMES.main, path)).toBe(true);
		expect(isPathAllowedOnHost(HOSTNAMES.mcp, path)).toBe(false);
		expect(isPathAllowedOnHost(HOSTNAMES.docs, path)).toBe(false);
	});
});
