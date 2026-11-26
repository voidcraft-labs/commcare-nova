import { DeploymentSessionEndedError } from "@/lib/deployment/sessionManagementGrant";
/**
 * The two bring-in routes as shells over their services: who may call them,
 * the bodies they accept, that every answer rides the stream's one last line,
 * that a throw ends the stream in one `failed` line and one log, which signal
 * each hands its service, and the hosts that reach them.
 *
 * The services are replaced, since what a read and a create answer is
 * `lib/deployment/reading/__tests__`'s. An unauthenticated read, a refusal
 * answered as a stream, a parser's message shown to a person, a stop thrown
 * away as an error status, two last lines, a stream that ends with none, a
 * closed tab that leaves a read running or cancels a create, and the
 * deploy-time 404 of a route the main host's allowlist does not reach are
 * what these cases would catch.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { ApiError, HQ_READING_REQUEST_MAX_BYTES } from "@/lib/apiError";
import type {
	AdoptedAppReceipt,
	BringInInput,
	CreateAnswer,
	ReadingAnswer,
	ReadingEvent,
	ReadingKey,
} from "@/lib/deployment";
import {
	authorizeBringIn,
	type BringInActor,
	createFromReview,
	readHqAppForReview,
} from "@/lib/deployment/reading";
import { broughtInAppId } from "@/lib/deployment/reading/appId";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { HOSTNAMES, isPathAllowedOnHost } from "@/lib/hostnames";
import { log } from "@/lib/logger";
import { circumstanceFinding } from "@/lib/publish/hqFindings";
import { READING_REFUSAL_COPY } from "@/lib/publish/hqReadingCopy";
import { POST as createPost } from "../create/route";
import { POST as readPost } from "../read/route";

const { requireSessionMock } = vi.hoisted(() => ({
	requireSessionMock: vi.fn(),
}));

vi.mock("@/lib/auth-utils", () => ({ requireSession: requireSessionMock }));
vi.mock("@/lib/deployment/reading", () => ({
	authorizeBringIn: vi.fn(),
	readHqAppForReview: vi.fn(),
	createFromReview: vi.fn(),
}));

const USER = "bring-in-user";
const PROJECT = "project-1";
/** Only `authorizeBringIn` makes an actor; the service is replaced, so any object stands in. */
const ACTOR = { userId: USER, projectId: PROJECT } as BringInActor;

const KEY: ReadingKey = {
	projectId: PROJECT,
	server: "india",
	domain: "clinic-2",
	remoteAppId: "a".repeat(32),
};
const INPUT: BringInInput = {
	...KEY,
	readingId: "01936a52-7c00-7000-8000-000000000001",
	reviewDigest: "f".repeat(64),
	appName: "Visits",
	runsOnlyOn: null,
	splitDatetime: false,
	tableChoices: { districts: "use-project" },
};

type Route = "read" | "create";
const ROUTES: readonly Route[] = ["read", "create"];
const BODY: Record<Route, unknown> = { read: KEY, create: INPUT };

function request(route: Route, body: unknown, signal?: AbortSignal): Request {
	return new Request(`http://localhost/api/commcare/bring-in/${route}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: typeof body === "string" ? body : JSON.stringify(body),
		...(signal !== undefined && { signal }),
	});
}

function post(route: Route, req: Request): Promise<Response> {
	return route === "read" ? readPost(req) : createPost(req);
}

/** The route's service, as the test controls it. */
function service(route: Route) {
	return route === "read"
		? vi.mocked(readHqAppForReview)
		: vi.mocked(createFromReview);
}

/** Make the route's service run `body` with the `onEvent` it was handed, then answer
 *  `ROUTE_ANSWER`'s answer for the route. */
function serviceRuns(
	route: Route,
	body: (onEvent: (event: ReadingEvent) => void) => void,
): void {
	if (route === "read")
		vi.mocked(readHqAppForReview).mockImplementation(
			async (_actor, _key, { onEvent }) => {
				body(onEvent);
				return ROUTE_ANSWER.read;
			},
		);
	else
		vi.mocked(createFromReview).mockImplementation(
			async (_actor, _input, { onEvent }) => {
				body(onEvent);
				return ROUTE_ANSWER.create;
			},
		);
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

const STAGES: readonly ReadingEvent[] = [
	{ type: "stage", stage: "connecting" },
	{ type: "stage", stage: "reading-app" },
	{ type: "stage", stage: "checking-media" },
	{ type: "files", done: 2, total: 5 },
	{ type: "files", done: 5, total: 5 },
	{ type: "stage", stage: "checking" },
];

const STOP = circumstanceFinding("hq-unavailable", { kind: "app" }, {});

/** One answer of each route's own kind. */
const ROUTE_ANSWER = {
	read: { kind: "stop", finding: STOP },
	create: { kind: "read-again" },
} as const satisfies Record<Route, ReadingAnswer | CreateAnswer>;

const READ_ANSWERS: readonly [string, ReadingAnswer][] = [
	["a stop", { kind: "stop", finding: STOP }],
	[
		"an account",
		{
			kind: "account",
			appName: "Visits",
			findings: [],
			more: 0,
			counts: { notYet: 1, never: 0, fixInHq: 0 },
			mediaChecked: true,
		},
	],
	[
		"a review",
		{
			kind: "review",
			readingId: INPUT.readingId,
			reviewDigest: INPUT.reviewDigest,
			review: {
				appName: "Visits",
				readAt: "2026-11-15T10:00:00.000Z",
				creates: {
					menus: 1,
					forms: 2,
					questions: 9,
					caseTypes: ["patient"],
					languages: ["en"],
					mediaFiles: 0,
				},
				runsOn: [
					{
						runsOnlyOn: null,
						splitDatetime: false,
						preselected: true,
						recordedFeatures: [],
						firstPublish: {
							ids: [],
							touchesWorkers: false,
							of: "first-publish",
						},
					},
				],
				runsOnWhy: "content",
				webAppsOnInHq: true,
				datetimeQuestions: 0,
				platformsOut: [],
				kept: [],
				tables: [],
				places: null,
				mediaLeftOut: 0,
				firstPublish: { ids: [], touchesWorkers: false, of: "first-publish" },
			},
		},
	],
];

const RECEIPT: AdoptedAppReceipt = {
	eventVersion: 1,
	designSessionId: null,
	appId: broughtInAppId(USER, KEY, INPUT.readingId),
	projectId: PROJECT,
	role: "editor",
	canEdit: true,
	seq: 1,
	batchId: "batch-1",
	changeSetId: null,
	snapshotDigest: "d".repeat(64),
	blueprint: toPersistableDoc(buildDoc({ appName: "Visits" })),
	starter: null,
	adoption: {
		server: KEY.server,
		domain: KEY.domain,
		remoteAppId: KEY.remoteAppId,
	},
};

const CREATE_ANSWERS: readonly [string, CreateAnswer][] = [
	["created", { kind: "created", receipt: RECEIPT }],
	["changed", { kind: "changed", now: { kind: "stop", finding: STOP } }],
	["read-again", { kind: "read-again" }],
	[
		"check-failed",
		{
			kind: "check-failed",
			finding: circumstanceFinding(
				"read-back-differs",
				{ kind: "app" },
				{ name: "birth-gate" },
			),
		},
	],
	["held", { kind: "held", finding: STOP }],
	["refused", { kind: "refused", refusal: "choice_missing" }],
];

beforeEach(() => {
	requireSessionMock.mockReset();
	requireSessionMock.mockResolvedValue({ user: { id: USER }, session: { id: "test-session" } });
	vi.mocked(authorizeBringIn).mockReset();
	vi.mocked(authorizeBringIn).mockResolvedValue(ACTOR);
	vi.mocked(readHqAppForReview).mockReset();
	vi.mocked(createFromReview).mockReset();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe.each(ROUTES)(
	"POST /api/commcare/bring-in/%s before its stream",
	(route) => {
		it("answers 401 without a session, as JSON, and asks nothing", async () => {
			requireSessionMock.mockRejectedValue(
				new ApiError("Authentication required", 401),
			);
			const response = await post(route, request(route, BODY[route]));
			expect(response.status).toBe(401);
			expect(response.headers.get("Content-Type")).toContain(
				"application/json",
			);
			expect(await response.json()).toEqual({
				error: "Authentication required",
			});
			expect(authorizeBringIn).not.toHaveBeenCalled();
			expect(service(route)).not.toHaveBeenCalled();
		});

		it("answers 413 for a body over the bound, as JSON, and asks nothing", async () => {
			const over = JSON.stringify({
				...(BODY[route] as object),
				padding: "x".repeat(HQ_READING_REQUEST_MAX_BYTES),
			});
			const response = await post(route, request(route, over));
			expect(response.status).toBe(413);
			expect(response.headers.get("Content-Type")).toContain(
				"application/json",
			);
			expect(await response.json()).toEqual({
				error: `Request body is too large, this endpoint accepts at most ${HQ_READING_REQUEST_MAX_BYTES} bytes.`,
			});
			expect(authorizeBringIn).not.toHaveBeenCalled();
			expect(service(route)).not.toHaveBeenCalled();
		});

		it.each([
			["a body that is no JSON", "{not json", "body: invalid_type"],
			[
				"a key the schema does not hold",
				{ ...(BODY[route] as object), plantedKey: "planted-value" },
				"body: unrecognized_keys",
			],
			[
				"a remote app id that is no HQ id",
				{ ...(BODY[route] as object), remoteAppId: "planted/value" },
				"remoteAppId: invalid_format",
			],
			[
				"a server that is not one of CommCare HQ's",
				{ ...(BODY[route] as object), server: "planted-server" },
				"server: invalid_value",
			],
			[
				"a domain that is no project space slug",
				{ ...(BODY[route] as object), domain: "planted/value" },
				"domain: not_a_project_space",
			],
		])(
			"answers 400 invalid_input for %s, with the sentence and no part of the issue",
			async (_, body, issue) => {
				const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
				const response = await post(route, request(route, body));
				expect(response.status).toBe(400);
				expect(response.headers.get("Content-Type")).toContain(
					"application/json",
				);
				expect(await response.json()).toEqual({
					error: READING_REFUSAL_COPY.invalid_input,
					code: "invalid_input",
				});
				expect(warn).toHaveBeenCalledTimes(1);
				expect(warn).toHaveBeenCalledWith("[reading] request refused", {
					userId: USER,
					operation: route,
					phase: route,
					issue,
				});
				expect(JSON.stringify(warn.mock.calls)).not.toContain("planted");
				expect(authorizeBringIn).not.toHaveBeenCalled();
				expect(service(route)).not.toHaveBeenCalled();
			},
		);

		it("answers 403 no_project_access where the person may not edit the Project", async () => {
			vi.mocked(authorizeBringIn).mockResolvedValue(null);
			const response = await post(route, request(route, BODY[route]));
			expect(response.status).toBe(403);
			expect(response.headers.get("Content-Type")).toContain(
				"application/json",
			);
			expect(await response.json()).toEqual({
				error: READING_REFUSAL_COPY.no_project_access,
				code: "no_project_access",
			});
			expect(authorizeBringIn).toHaveBeenCalledWith(USER, PROJECT);
			expect(service(route)).not.toHaveBeenCalled();
		});
	},
);

describe("a create's body", () => {
	it("is refused by its top-level key where a table's answer is no answer, never by the table's tag", async () => {
		const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
		const response = await createPost(
			request("create", {
				...INPUT,
				tableChoices: { "planted-tag": "planted-answer" },
			}),
		);
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: READING_REFUSAL_COPY.invalid_input,
			code: "invalid_input",
		});
		expect(warn).toHaveBeenCalledWith("[reading] request refused", {
			userId: USER,
			operation: "create",
			phase: "create",
			issue: "tableChoices: invalid_value",
		});
		expect(JSON.stringify(warn.mock.calls)).not.toContain("planted");
	});
});

describe("the stream", () => {
	it.each(READ_ANSWERS)(
		"a read answers %s on 200, after its stage lines, in one done line",
		async (_, answer) => {
			vi.mocked(readHqAppForReview).mockImplementation(
				async (_actor, _key, { onEvent }) => {
					for (const event of STAGES) onEvent(event);
					return answer;
				},
			);
			const response = await readPost(request("read", KEY));
			expect(response.status).toBe(200);
			expect(response.headers.get("Content-Type")).toBe(
				"application/x-ndjson; charset=utf-8",
			);
			expect(response.headers.get("Cache-Control")).toBe("private, no-store");
			expect(await lines(response)).toEqual([
				...STAGES,
				{ type: "done", answer },
			]);
			expect(readHqAppForReview).toHaveBeenCalledWith(ACTOR, KEY, {
				onEvent: expect.any(Function),
				cancel: expect.any(AbortSignal),
			});
		},
	);

	it.each(CREATE_ANSWERS)(
		"a create answers %s on 200, after its stage lines, in one done line",
		async (_, answer) => {
			vi.mocked(createFromReview).mockImplementation(
				async (_actor, _input, { onEvent }) => {
					for (const event of STAGES) onEvent(event);
					onEvent({ type: "stage", stage: "creating" });
					return answer;
				},
			);
			const response = await createPost(request("create", INPUT));
			expect(response.status).toBe(200);
			expect(response.headers.get("Content-Type")).toBe(
				"application/x-ndjson; charset=utf-8",
			);
			expect(await lines(response)).toEqual([
				...STAGES,
				{ type: "stage", stage: "creating" },
				{ type: "done", answer },
			]);
			expect(createFromReview).toHaveBeenCalledWith(ACTOR, INPUT, {
				onEvent: expect.any(Function),
				requireInstallationManagement: expect.any(Function),
			});
		},
	);

	it.each(ROUTES)(
		"%s writes the last line itself, so a service's own done or failed event makes no second one",
		async (route) => {
			const answer = ROUTE_ANSWER[route];
			serviceRuns(route, (onEvent) => {
				onEvent({ type: "stage", stage: "connecting" });
				onEvent({ type: "failed" });
				onEvent({ type: "done", answer });
			});
			const response = await post(route, request(route, BODY[route]));
			expect(await lines(response)).toEqual([
				{ type: "stage", stage: "connecting" },
				{ type: "done", answer },
			]);
		},
	);

	it.each(ROUTES)(
		"%s ends in one failed line where its service throws, and logs it once with the stage that was running",
		async (route) => {
			const error = new Error("the database went away");
			const failed = vi.spyOn(log, "error").mockImplementation(() => {});
			serviceRuns(route, (onEvent) => {
				onEvent({ type: "stage", stage: "connecting" });
				onEvent({ type: "stage", stage: "reading-project-data" });
				throw error;
			});
			const response = await post(route, request(route, BODY[route]));
			expect(response.status).toBe(200);
			expect(await lines(response)).toEqual([
				{ type: "stage", stage: "connecting" },
				{ type: "stage", stage: "reading-project-data" },
				{ type: "failed" },
			]);
			expect(failed).toHaveBeenCalledTimes(1);
			expect(failed).toHaveBeenCalledWith("[reading] failed", error, {
				...(route === "create" && {
					appId: broughtInAppId(USER, KEY, INPUT.readingId),
				}),
				projectId: PROJECT,
				userId: USER,
				operation: route,
				phase: "reading-project-data",
			});
		},
	);
});

describe("the signal each route hands its service", () => {
	it("hands a read a signal that aborts when the request's does", async () => {
		const client = new AbortController();
		let handed: AbortSignal | undefined;
		let answer: (value: ReadingAnswer) => void = () => {};
		const called = new Promise<void>((calledBack) => {
			vi.mocked(readHqAppForReview).mockImplementation(
				(_actor, _key, options) => {
					handed = options.cancel;
					calledBack();
					return new Promise<ReadingAnswer>((resolve) => {
						answer = resolve;
					});
				},
			);
		});
		const response = await readPost(request("read", KEY, client.signal));
		await called;
		expect(handed?.aborted).toBe(false);
		client.abort();
		expect(handed?.aborted).toBe(true);
		const stop: ReadingAnswer = { kind: "stop", finding: STOP };
		answer(stop);
		expect(await lines(response)).toEqual([{ type: "done", answer: stop }]);
	});

	it("hands a create no signal", async () => {
		const client = new AbortController();
		vi.mocked(createFromReview).mockResolvedValue({ kind: "read-again" });
		const response = await createPost(request("create", INPUT, client.signal));
		expect(await lines(response)).toEqual([
			{ type: "done", answer: { kind: "read-again" } },
		]);
		const [, , options] = vi.mocked(createFromReview).mock.calls[0] ?? [];
		expect(options).toEqual({ onEvent: expect.any(Function), requireInstallationManagement: expect.any(Function) });
	});

	it("runs a create to its end where the client stops reading mid-stream, and logs nothing", async () => {
		const failed = vi.spyOn(log, "error").mockImplementation(() => {});
		let release: () => void = () => {};
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		/* The shell serializes the done line in the same synchronous run that
		 * enqueues it, so once the answer has been serialized, whatever an enqueue
		 * into a gone client's stream throws has already happened. */
		let serialized: () => void = () => {};
		const doneWritten = new Promise<void>((resolve) => {
			serialized = resolve;
		});
		const created: CreateAnswer = { kind: "created", receipt: RECEIPT };
		Object.defineProperty(created, "toJSON", {
			enumerable: false,
			value(this: CreateAnswer) {
				serialized();
				return { ...this };
			},
		});
		const reached: string[] = [];
		vi.mocked(createFromReview).mockImplementation(
			async (_actor, _input, { onEvent }) => {
				onEvent({ type: "stage", stage: "connecting" });
				await released;
				onEvent({ type: "files", done: 1, total: 1 });
				reached.push("files");
				onEvent({ type: "stage", stage: "creating" });
				reached.push("creating");
				return created;
			},
		);

		const response = await createPost(request("create", INPUT));
		const body = response.body;
		if (body === null) throw new Error("The create answered no stream.");
		const reader = body.getReader();
		const first = await reader.read();
		expect(JSON.parse(new TextDecoder().decode(first.value))).toEqual({
			type: "stage",
			stage: "connecting",
		});
		await reader.cancel();
		release();

		await expect(
			vi.mocked(createFromReview).mock.results[0]?.value,
		).resolves.toBe(created);
		await doneWritten;
		expect(reached).toEqual(["files", "creating"]);
		expect(failed).not.toHaveBeenCalled();
	});
});

describe("the hosts that reach the bring-in routes", () => {
	it.each(["/api/commcare/bring-in/read", "/api/commcare/bring-in/create"])(
		"admits %s on the main host and refuses it on the MCP and docs hosts",
		(path) => {
			expect(isPathAllowedOnHost(HOSTNAMES.main, path)).toBe(true);
			expect(isPathAllowedOnHost(HOSTNAMES.mcp, path)).toBe(false);
			expect(isPathAllowedOnHost(HOSTNAMES.docs, path)).toBe(false);
		},
	);
});

it("returns sign-in recovery when the checked session ends during creation", async () => {
	vi.mocked(createFromReview).mockRejectedValueOnce(new DeploymentSessionEndedError());
	const response=await createPost(request("create",INPUT));
	expect(await lines(response)).toEqual([{type:"done",answer:{kind:"refused",refusal:"session_ended"}}]);
});
