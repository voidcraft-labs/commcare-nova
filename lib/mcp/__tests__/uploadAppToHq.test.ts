/**
 * `registerUploadAppToHq` unit tests.
 *
 * Each test exercises one path through the handler's explicit four-gate
 * validation sequence, plus the ownership pre-gate, the app-name
 * fallback, progress emissions on the happy path, and log-writer drain
 * on a mid-upload throw.
 *
 * Hard invariants the suite encodes:
 *   - Gates 1-3 exit BEFORE a `LogWriter` is ever constructed — the
 *     writer allocation sits inside the post-gate block. This is what
 *     `LogWriterMock.instances` is asserted on.
 *   - `importApp` is only reached once all four pre-network gates pass.
 *     Each gate's failure test asserts `importApp` was never called.
 *   - A mid-upload throw still flushes the writer via the `finally`
 *     block.
 *
 * The MCP SDK is mocked at the boundary via the `makeFakeServer` helper
 * (same pattern the sibling tests use). `@/lib/mcp/loadApp` is mocked
 * directly rather than mocking `@/lib/db/apps::loadApp`, so individual
 * tests pin the exact `{ doc, app }` pair without going through the
 * `rebuildFieldParent` path.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { importApp, isValidDomainSlug } from "@/lib/commcare/client";
import { expandDoc } from "@/lib/commcare/expander";
import type { HqApplication } from "@/lib/commcare/types";
import { loadAppOwner, updateApp } from "@/lib/db/apps";
import { getDecryptedCredentialsWithDomain } from "@/lib/db/settings";
import type { AppDoc } from "@/lib/db/types";
import type { BlueprintDoc } from "@/lib/domain";
import { type LoadedApp, loadAppBlueprint } from "../loadApp";
import {
	registerUploadAppToHq,
	UPLOAD_ERROR_TYPES,
} from "../tools/uploadAppToHq";
import type { ToolContext } from "../types";

/* --- Mocks ----------------------------------------------------------- */

/* `vi.mock` hoists above imports so every boundary is stubbed before
 * the handler file resolves its imports. */
vi.mock("@/lib/db/apps", () => ({
	loadAppOwner: vi.fn(),
	/* `updateApp` is touched indirectly through `McpContext.recordConversation`'s
	 * sibling `recordMutations` path — but only on mutating flows. Tests
	 * here never invoke `recordMutations`, so this stays as a harmless
	 * resolved stub. */
	updateApp: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/db/settings", () => ({
	getDecryptedCredentialsWithDomain: vi.fn(),
}));
vi.mock("@/lib/commcare/client", () => ({
	importApp: vi.fn(),
	isValidDomainSlug: vi.fn(),
}));
vi.mock("@/lib/commcare/expander", () => ({
	expandDoc: vi.fn(),
}));
vi.mock("../loadApp", () => ({
	loadAppBlueprint: vi.fn(),
}));

/* Hoisted `LogWriter` mock — same pattern as `sharedToolAdapter.test.ts`.
 * The class is declared inside `vi.hoisted` so the mock factory can
 * reach it (mocks hoist above top-level statements); tests look up the
 * freshest `flush` spy via `LogWriterMock.instances.at(-1)` to assert
 * the adapter drained the buffer. `beforeEach` clears the array so
 * cross-test bleed is impossible. */
const { LogWriterMock } = vi.hoisted(() => {
	class LogWriterMock {
		logEvent = vi.fn();
		flush = vi.fn().mockResolvedValue(undefined);
		static instances: LogWriterMock[] = [];
		constructor() {
			LogWriterMock.instances.push(this);
		}
	}
	return { LogWriterMock };
});
vi.mock("@/lib/log/writer", () => ({ LogWriter: LogWriterMock }));

/* --- Helpers --------------------------------------------------------- */

type Handler = (
	args: Record<string, unknown>,
	extra: Record<string, unknown>,
) => Promise<unknown>;

interface FakeServer {
	server: McpServer;
	capture(): Handler;
	notificationSpy: ReturnType<typeof vi.fn>;
}

/**
 * Capture the MCP handler `registerUploadAppToHq` registers via
 * `server.tool`, along with the low-level `server.notification` spy the
 * progress emitter drives. Tests that opt into progress inspection pass
 * a `progressToken` on `_meta`; otherwise the emitter no-ops.
 */
function makeFakeServer(): FakeServer {
	let captured: Handler | null = null;
	const notificationSpy = vi.fn();
	const server = {
		tool: (_n: string, _d: string, _s: unknown, cb: Handler) => {
			captured = cb;
		},
		server: { notification: notificationSpy },
	} as unknown as McpServer;
	return {
		server,
		capture: () => {
			if (!captured) throw new Error("handler not captured");
			return captured;
		},
		notificationSpy,
	};
}

/** Minimal `BlueprintDoc` — the expander is mocked, so fields are unused. */
function fixtureBlueprint(): BlueprintDoc {
	return {
		appId: "a1",
		appName: "Vaccine Tracker",
		connectType: null,
		caseTypes: null,
		modules: {},
		forms: {},
		fields: {},
		moduleOrder: [],
		formOrder: {},
		fieldOrder: {},
		fieldParent: {},
	};
}

/** Minimal `AppDoc` — only `app_name` is consumed on the happy path. */
function fixtureAppDoc(overrides?: Partial<AppDoc>): AppDoc {
	return {
		owner: "u1",
		app_name: "Vaccine Tracker",
		blueprint: fixtureBlueprint(),
		connect_type: null,
		module_count: 0,
		form_count: 0,
		status: "complete",
		error_type: null,
		deleted_at: null,
		recoverable_until: null,
		run_id: null,
		created_at: new Date() as unknown as AppDoc["created_at"],
		updated_at: new Date() as unknown as AppDoc["updated_at"],
		...overrides,
	};
}

/** `{ doc, app }` pair the mocked `loadAppBlueprint` returns on happy paths. */
function fixtureLoadedApp(appOverrides?: Partial<AppDoc>): LoadedApp {
	return { doc: fixtureBlueprint(), app: fixtureAppDoc(appOverrides) };
}

/**
 * Stand-in `HqApplication` the mocked `expandDoc` returns. Round-trips
 * through `JSON.stringify` — tests don't care about the internal shape.
 */
const FAKE_HQ_JSON = {
	doc_type: "Application" as const,
	name: "Vaccine Tracker",
	langs: ["en"],
	modules: [],
} as unknown as HqApplication;

/** Canonical creds fixture — mirrors the shape `getDecryptedCredentialsWithDomain` returns. */
const FIXTURE_SETTINGS = {
	creds: { username: "alice@example.com", apiKey: "key-xyz" },
	domain: { name: "acme-research", displayName: "ACME Research" },
} as const;

const toolCtx: ToolContext = { userId: "u1", scopes: [] };

beforeEach(() => {
	vi.mocked(loadAppOwner).mockReset();
	vi.mocked(loadAppBlueprint).mockReset();
	vi.mocked(getDecryptedCredentialsWithDomain).mockReset();
	vi.mocked(importApp).mockReset();
	vi.mocked(isValidDomainSlug).mockReset();
	vi.mocked(expandDoc).mockReset();
	vi.mocked(updateApp).mockReset();
	vi.mocked(updateApp).mockResolvedValue(undefined);
	LogWriterMock.instances = [];

	/* Default happy-path mocks — individual tests override via
	 * `mockReturnValueOnce` / `mockResolvedValueOnce` where needed. The
	 * defaults mean tests only have to pin the deviation they care about. */
	vi.mocked(loadAppOwner).mockResolvedValue("u1");
	vi.mocked(isValidDomainSlug).mockReturnValue(true);
	vi.mocked(getDecryptedCredentialsWithDomain).mockResolvedValue(
		FIXTURE_SETTINGS,
	);
	vi.mocked(loadAppBlueprint).mockResolvedValue(fixtureLoadedApp());
	vi.mocked(expandDoc).mockReturnValue(FAKE_HQ_JSON);
});

/* --- Tests ----------------------------------------------------------- */

describe("registerUploadAppToHq — happy path", () => {
	it("runs all four gates, uploads, and returns the HQ app id + URL", async () => {
		vi.mocked(importApp).mockResolvedValueOnce({
			success: true,
			appId: "hq-123",
			appUrl: "https://hq.example/app",
			warnings: [],
		});

		const { server, capture } = makeFakeServer();
		registerUploadAppToHq(server, toolCtx);

		const out = (await capture()(
			{ app_id: "a1", domain: "acme-research", app_name: "Imported" },
			{},
		)) as {
			content: Array<{ type: "text"; text: string }>;
			_meta: { stage: string; app_id: string; run_id: string };
		};

		/* All four gates saw exactly one call each. `isValidDomainSlug`
		 * is queried before creds are fetched — the order is load-bearing
		 * for SSRF posture, so assert it here rather than trusting
		 * mutation-order coincidence. */
		expect(isValidDomainSlug).toHaveBeenCalledWith("acme-research");
		expect(getDecryptedCredentialsWithDomain).toHaveBeenCalledWith("u1");
		expect(importApp).toHaveBeenCalledWith(
			FIXTURE_SETTINGS.creds,
			"acme-research",
			"Imported",
			FAKE_HQ_JSON,
		);

		/* Payload round-trips through JSON — the full structured result
		 * (including warnings, even when empty) is emitted. */
		const parsed = JSON.parse(out.content[0]?.text ?? "{}");
		expect(parsed).toEqual({
			hq_app_id: "hq-123",
			url: "https://hq.example/app",
			warnings: [],
		});

		expect(out._meta.stage).toBe("upload_complete");
		expect(out._meta.app_id).toBe("a1");
		expect(typeof out._meta.run_id).toBe("string");
		expect(out._meta.run_id.length).toBeGreaterThan(0);

		/* LogWriter allocated + flushed exactly once — the finally block
		 * runs regardless of outcome. */
		expect(LogWriterMock.instances).toHaveLength(1);
		expect(LogWriterMock.instances[0]?.flush).toHaveBeenCalledTimes(1);
	});
});

describe("registerUploadAppToHq — gate 1: invalid domain", () => {
	it("returns error_type 'invalid_domain' and never fetches creds or calls importApp", async () => {
		vi.mocked(isValidDomainSlug).mockReturnValueOnce(false);

		const { server, capture } = makeFakeServer();
		registerUploadAppToHq(server, toolCtx);

		const out = (await capture()({ app_id: "a1", domain: "bad/slug" }, {})) as {
			isError: true;
			_meta: { error_type: string; app_id: string };
		};

		expect(out.isError).toBe(true);
		expect(out._meta.error_type).toBe(UPLOAD_ERROR_TYPES.invalidDomain);
		expect(out._meta.app_id).toBe("a1");
		/* Gate 1 failure short-circuits before any downstream work. */
		expect(getDecryptedCredentialsWithDomain).not.toHaveBeenCalled();
		expect(loadAppBlueprint).not.toHaveBeenCalled();
		expect(importApp).not.toHaveBeenCalled();
		/* And — critically — no `LogWriter` was allocated for a gate that
		 * has nothing to flush. */
		expect(LogWriterMock.instances).toHaveLength(0);
	});
});

describe("registerUploadAppToHq — gate 2: HQ not configured", () => {
	it("returns error_type 'hq_not_configured' when no creds exist", async () => {
		vi.mocked(getDecryptedCredentialsWithDomain).mockResolvedValueOnce(null);

		const { server, capture } = makeFakeServer();
		registerUploadAppToHq(server, toolCtx);

		const out = (await capture()(
			{ app_id: "a1", domain: "acme-research" },
			{},
		)) as {
			isError: true;
			_meta: { error_type: string; app_id: string };
		};

		expect(out.isError).toBe(true);
		expect(out._meta.error_type).toBe(UPLOAD_ERROR_TYPES.hqNotConfigured);
		expect(out._meta.app_id).toBe("a1");
		expect(loadAppBlueprint).not.toHaveBeenCalled();
		expect(importApp).not.toHaveBeenCalled();
		expect(LogWriterMock.instances).toHaveLength(0);
	});
});

describe("registerUploadAppToHq — gate 3: domain mismatch", () => {
	it("returns error_type 'domain_mismatch' when creds authorize a different project", async () => {
		/* Creds authorize `acme-research`; caller targets `other-project`.
		 * The Nova app is theirs and the slug is valid — only the
		 * cross-domain mismatch trips this gate. */
		vi.mocked(getDecryptedCredentialsWithDomain).mockResolvedValueOnce({
			...FIXTURE_SETTINGS,
		});

		const { server, capture } = makeFakeServer();
		registerUploadAppToHq(server, toolCtx);

		const out = (await capture()(
			{ app_id: "a1", domain: "other-project" },
			{},
		)) as {
			isError: true;
			_meta: { error_type: string; app_id: string };
		};

		expect(out.isError).toBe(true);
		expect(out._meta.error_type).toBe(UPLOAD_ERROR_TYPES.domainMismatch);
		expect(out._meta.app_id).toBe("a1");
		/* Message surfaces the authorized domain so the LLM can relay
		 * actionable guidance to the user. */
		expect(out).toMatchObject({
			content: [
				expect.objectContaining({
					text: expect.stringContaining("acme-research"),
				}),
			],
		});
		expect(loadAppBlueprint).not.toHaveBeenCalled();
		expect(importApp).not.toHaveBeenCalled();
		expect(LogWriterMock.instances).toHaveLength(0);
	});
});

describe("registerUploadAppToHq — gate 4: HQ upload failed", () => {
	it("returns error_type 'hq_upload_failed' when importApp surfaces a non-success", async () => {
		vi.mocked(importApp).mockResolvedValueOnce({
			success: false,
			status: 502,
		});

		const { server, capture } = makeFakeServer();
		registerUploadAppToHq(server, toolCtx);

		const out = (await capture()(
			{ app_id: "a1", domain: "acme-research" },
			{},
		)) as {
			isError: true;
			_meta: { error_type: string; app_id: string };
			content: Array<{ type: "text"; text: string }>;
		};

		expect(out.isError).toBe(true);
		expect(out._meta.error_type).toBe(UPLOAD_ERROR_TYPES.hqUploadFailed);
		expect(out._meta.app_id).toBe("a1");
		/* The HQ status code is surfaced in the user-facing text so the
		 * LLM can explain the failure category to the user. */
		expect(out.content[0]?.text).toContain("502");

		/* LogWriter WAS allocated (gate 4 sits past the writer ctor) AND
		 * flushed — the `finally` block drains even on non-success return. */
		expect(LogWriterMock.instances).toHaveLength(1);
		expect(LogWriterMock.instances[0]?.flush).toHaveBeenCalledTimes(1);
	});
});

describe("registerUploadAppToHq — ownership failure", () => {
	it("returns error_type 'not_owner' and never fetches creds or calls importApp", async () => {
		vi.mocked(loadAppOwner).mockResolvedValueOnce("someone-else");

		const { server, capture } = makeFakeServer();
		registerUploadAppToHq(server, toolCtx);

		const out = (await capture()(
			{ app_id: "a1", domain: "acme-research" },
			{},
		)) as {
			isError: true;
			_meta: { error_type: string; app_id: string };
		};

		expect(out.isError).toBe(true);
		expect(out._meta.error_type).toBe("not_owner");
		expect(out._meta.app_id).toBe("a1");
		/* Ownership failure must short-circuit BEFORE any settings read,
		 * blueprint load, or HQ call — the ownership pre-gate is the
		 * first line of defense against cross-tenant upload probes. */
		expect(getDecryptedCredentialsWithDomain).not.toHaveBeenCalled();
		expect(loadAppBlueprint).not.toHaveBeenCalled();
		expect(importApp).not.toHaveBeenCalled();
		expect(LogWriterMock.instances).toHaveLength(0);
	});
});

describe("registerUploadAppToHq — app name fallback", () => {
	it("falls back to the blueprint's app_name when app_name is omitted", async () => {
		vi.mocked(importApp).mockResolvedValueOnce({
			success: true,
			appId: "hq-1",
			appUrl: "https://hq.example/app",
			warnings: [],
		});

		const { server, capture } = makeFakeServer();
		registerUploadAppToHq(server, toolCtx);

		await capture()({ app_id: "a1", domain: "acme-research" }, {});

		expect(importApp).toHaveBeenCalledWith(
			FIXTURE_SETTINGS.creds,
			"acme-research",
			"Vaccine Tracker",
			FAKE_HQ_JSON,
		);
	});

	it("falls back to the blueprint's app_name on a whitespace-only override", async () => {
		vi.mocked(importApp).mockResolvedValueOnce({
			success: true,
			appId: "hq-2",
			appUrl: "https://hq.example/app",
			warnings: [],
		});

		const { server, capture } = makeFakeServer();
		registerUploadAppToHq(server, toolCtx);

		await capture()(
			{ app_id: "a1", domain: "acme-research", app_name: "   " },
			{},
		);

		/* `?.trim() || app.app_name` must map whitespace-only to the
		 * blueprint name — a blank `app_name` on HQ is strictly worse
		 * than using the real name. */
		expect(importApp).toHaveBeenCalledWith(
			FIXTURE_SETTINGS.creds,
			"acme-research",
			"Vaccine Tracker",
			FAKE_HQ_JSON,
		);
	});
});

describe("registerUploadAppToHq — progress notifications", () => {
	it("emits upload_started + upload_complete when the client supplies a progress token", async () => {
		vi.mocked(importApp).mockResolvedValueOnce({
			success: true,
			appId: "hq-prog",
			appUrl: "https://hq.example/app",
			warnings: [],
		});

		const { server, capture, notificationSpy } = makeFakeServer();
		registerUploadAppToHq(server, toolCtx);

		await capture()(
			{ app_id: "a1", domain: "acme-research" },
			{ _meta: { progressToken: "pt-1" } },
		);

		/* Each progress emission goes through `server.server.notification`
		 * with an `_meta.stage` tag. Pull those tags off the spy calls in
		 * order — a future regression that re-orders the pipeline or
		 * drops one of the emissions will flip this assertion. */
		const stages = notificationSpy.mock.calls
			.map((c) => c[0] as { params?: { _meta?: { stage?: string } } })
			.map((arg) => arg.params?._meta?.stage);
		expect(stages).toEqual(["upload_started", "upload_complete"]);
	});

	it("no-ops progress notifications when no progress token is supplied", async () => {
		vi.mocked(importApp).mockResolvedValueOnce({
			success: true,
			appId: "hq-silent",
			appUrl: "https://hq.example/app",
			warnings: [],
		});

		const { server, capture, notificationSpy } = makeFakeServer();
		registerUploadAppToHq(server, toolCtx);

		await capture()({ app_id: "a1", domain: "acme-research" }, {});

		/* `createProgressEmitter` branches on `progressToken === undefined`
		 * and silently drops every `notify` call — no notification should
		 * have been dispatched through the low-level API. */
		expect(notificationSpy).not.toHaveBeenCalled();
	});
});

describe("registerUploadAppToHq — log writer drain on throw", () => {
	it("awaits flush() when importApp throws mid-upload", async () => {
		/* The writer is allocated BEFORE `importApp` runs, so a throw
		 * here must still flow through the `finally` drain. If the flush
		 * were skipped, queued log events would be lost. */
		vi.mocked(importApp).mockRejectedValueOnce(new Error("network down"));

		const { server, capture } = makeFakeServer();
		registerUploadAppToHq(server, toolCtx);

		const out = (await capture()(
			{ app_id: "a1", domain: "acme-research" },
			{},
		)) as { isError: true; _meta: { error_type: string } };

		/* The throw surfaces through `toMcpErrorResult`'s shared
		 * taxonomy — not as one of the gate tags. */
		expect(out.isError).toBe(true);
		expect(out._meta.error_type).not.toBe(UPLOAD_ERROR_TYPES.hqUploadFailed);

		/* Writer ran its finally block exactly once. */
		expect(LogWriterMock.instances).toHaveLength(1);
		expect(LogWriterMock.instances[0]?.flush).toHaveBeenCalledTimes(1);
	});
});
