// lib/agent/__tests__/fixtures.ts
//
// Shared test fixtures for the agent layer. `makeTestContext` builds a
// `GenerationContext` wired to vi.fn stubs on its two write surfaces —
// the SSE writer and the event-log writer — plus a real
// `UsageAccumulator` seeded with deterministic values. Every agent test
// that touches emission, usage tracking, or conversation events should
// use this helper so the construction shape stays in sync with the
// production constructor.
//
// `makeMcpTestContext` is the sibling for the MCP surface: a stubbed
// `McpContext` so shared tool modules can be driven through both
// surfaces in cross-surface tests, exercising the same
// `ToolExecutionContext` interface the production adapter uses.
//
// The helpers return both the `ctx` (for driving calls into the class
// under test) and the stubs (for asserting what the class wrote). All
// stubs are typed loosely — `vi.fn()` erases the production signature,
// and tests that care about argument shapes assert on
// `mock.calls[i][j]` explicitly.
import type { UIMessageStreamWriter } from "ai";
import { vi } from "vitest";
import type { Session } from "@/lib/auth";
import { type AccumulatorSeed, UsageAccumulator } from "@/lib/db/usage";
import type { BlueprintDoc } from "@/lib/domain";
import type { LogWriter } from "@/lib/log/writer";
import { McpContext } from "@/lib/mcp/context";
import type { ProgressEmitter } from "@/lib/mcp/progress";
import { GenerationContext } from "../generationContext";

/**
 * Default accumulator seed. Tests that need a specific run config
 * (edit mode, cache expired, etc.) pass overrides via `seed`.
 */
const DEFAULT_SEED: AccumulatorSeed = {
	appId: "test-app",
	userId: "user-1",
	runId: "run-1",
	model: "claude-opus-4-7",
	promptMode: "build",
	freshEdit: false,
	appReady: false,
	cacheExpired: false,
	moduleCount: 0,
};

export interface MakeTestContextOptions {
	/** Override specific accumulator seed fields (runId, promptMode, etc.). */
	seed?: Partial<AccumulatorSeed>;
	/** Override the appId passed into `GenerationContext`. Defaults to
	 * "test-app" (matches `DEFAULT_SEED.appId`) when not supplied. */
	appId?: string;
}

export interface TestContextHandles {
	ctx: GenerationContext;
	/** SSE writer stub — the only method the class uses is `write`. */
	writer: { write: ReturnType<typeof vi.fn> };
	/** Event-log stub — `logEvent` + `flush` cover the class's surface. */
	logWriter: {
		logEvent: ReturnType<typeof vi.fn>;
		flush: ReturnType<typeof vi.fn>;
	};
	/** The real `UsageAccumulator` so tests can assert on its snapshot. */
	usage: UsageAccumulator;
}

/**
 * Build a `GenerationContext` wired to vi.fn stubs for both write surfaces
 * and a real `UsageAccumulator` seeded deterministically. Safe to call
 * once per test — nothing in the ctx reaches out to Firestore as long as
 * the test mocks `@/lib/db/apps.updateApp` (or never calls
 * `emitMutations`). Tests that exercise `emitMutations` MUST install a
 * `vi.mock("@/lib/db/apps", ...)` at module scope so the fire-and-forget
 * intermediate save has a stub to call.
 *
 * `appId` defaults to `"test-app"` (matching the seed). Every
 * `GenerationContext` has a valid persistence target — the chat route
 * creates the app doc before constructing the context in production.
 */
export function makeTestContext(
	opts: MakeTestContextOptions = {},
): TestContextHandles {
	const writerStub = {
		write: vi.fn(),
	} as unknown as UIMessageStreamWriter;
	const logWriterStub = {
		logEvent: vi.fn(),
		flush: vi.fn(),
	} as unknown as LogWriter;
	const usage = new UsageAccumulator({ ...DEFAULT_SEED, ...(opts.seed ?? {}) });
	const session = { user: { id: "user-1" } } as unknown as Session;
	const ctx = new GenerationContext({
		apiKey: "sk-test",
		writer: writerStub,
		logWriter: logWriterStub,
		usage,
		session,
		appId: opts.appId ?? "test-app",
	});
	return {
		ctx,
		writer: writerStub as unknown as { write: ReturnType<typeof vi.fn> },
		logWriter: logWriterStub as unknown as {
			logEvent: ReturnType<typeof vi.fn>;
			flush: ReturnType<typeof vi.fn>;
		},
		usage,
	};
}

/**
 * Minimal `BlueprintDoc` suitable as the `doc` argument to `emitMutations`
 * in tests that don't care about the doc's content — they only need a
 * value that type-checks against `BlueprintDoc` so the signature is
 * satisfied. The assertion surfaces (writer.write mock, logWriter.logEvent
 * mock) don't read from this doc.
 *
 * Kept here (not duplicated per test file) so any future `BlueprintDoc`
 * shape change touches one place.
 */
export function makeMinimalDoc(): BlueprintDoc {
	return {
		appId: "test-app",
		appName: "",
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

/** Handles returned by `makeMcpTestContext` — the context plus the
 *  vi.fn stubs on its log writer and progress emitter so tests can
 *  assert on what the context wrote. */
export interface MakeMcpTestContextHandles {
	ctx: McpContext;
	logWriter: {
		logEvent: ReturnType<typeof vi.fn>;
		flush: ReturnType<typeof vi.fn>;
	};
	progress: { notify: ReturnType<typeof vi.fn> };
}

/** Options for overriding the default ids on the produced `McpContext`. */
export interface MakeMcpTestContextOptions {
	/** Firestore app id. Defaults to `"test-app"`. */
	appId?: string;
	/** Better Auth user id. Defaults to `"user-1"`. */
	userId?: string;
	/** Per-run grouping id. Defaults to `"run-1"`. */
	runId?: string;
}

/**
 * Build an `McpContext` wired to vi.fn stubs for its log writer and
 * progress emitter. Safe to call once per test — nothing in the ctx
 * reaches Firestore as long as the test mocks `@/lib/db/apps.updateApp`
 * (or never calls `recordMutations`).
 *
 * Mirrors `makeTestContext` for the chat surface: both helpers return a
 * `ToolExecutionContext`-compatible value so shared tool modules can be
 * driven through either without per-test boilerplate. Cross-surface
 * tests use both helpers side by side to assert the same input produces
 * the same mutation batch on both surfaces.
 */
export function makeMcpTestContext(
	opts: MakeMcpTestContextOptions = {},
): MakeMcpTestContextHandles {
	const logWriterStub = {
		logEvent: vi.fn(),
		flush: vi.fn(),
	} as unknown as LogWriter;
	const progressStub: ProgressEmitter = { notify: vi.fn() };
	const ctx = new McpContext({
		appId: opts.appId ?? "test-app",
		userId: opts.userId ?? "user-1",
		runId: opts.runId ?? "run-1",
		logWriter: logWriterStub,
		progress: progressStub,
	});
	return {
		ctx,
		logWriter: logWriterStub as unknown as {
			logEvent: ReturnType<typeof vi.fn>;
			flush: ReturnType<typeof vi.fn>;
		},
		progress: progressStub as { notify: ReturnType<typeof vi.fn> },
	};
}
