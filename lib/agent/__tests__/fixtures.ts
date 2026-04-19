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
// The helper returns both the `ctx` (for driving calls into the class
// under test) and the stubs (for asserting what the class wrote). All
// three are typed loosely on the stub side — `vi.fn()` erases the
// production signature, and tests that care about argument shapes assert
// on `mock.calls[i][j]` explicitly.
import type { UIMessageStreamWriter } from "ai";
import { vi } from "vitest";
import type { Session } from "@/lib/auth";
import { type AccumulatorSeed, UsageAccumulator } from "@/lib/db/usage";
import type { LogWriter } from "@/lib/log/writer";
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
	/** Override the appId passed into `GenerationContext`. Default undefined. */
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
 * once per test — nothing in the ctx reaches out to Firestore unless the
 * test explicitly installs a docProvider and calls `emitMutations`.
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
		...(opts.appId !== undefined && { appId: opts.appId }),
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
