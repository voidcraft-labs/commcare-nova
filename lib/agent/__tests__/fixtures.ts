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
// `CanonicalMutationHost` contract the production adapter's per-call
// workspace commits through.
//
// The helpers return both the `ctx` (for driving calls into the class
// under test) and the stubs (for asserting what the class wrote). All
// stubs are typed loosely — `vi.fn()` erases the production signature,
// and tests that care about argument shapes assert on
// `mock.calls[i][j]` explicitly.
import type { UIMessageStreamWriter } from "ai";
import { vi } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import type { Session } from "@/lib/auth";
import { seedApplyBlueprintChangeTestWriter } from "@/lib/db/__tests__/applyBlueprintChangeTestWriter";
import { type AccumulatorSeed, UsageAccumulator } from "@/lib/db/usage";
import {
	mutationCommitVerdict,
	type PreparedMutationCandidate,
} from "@/lib/doc/commitVerdicts";
import {
	hydratePersistedBlueprint,
	toPersistableDoc,
} from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { AdmittedMutationStages } from "@/lib/doc/mutationAdmission";
import { canonicalAppGenesis } from "@/lib/doc/scaffolds";
import {
	asUuid,
	type BlueprintDoc,
	type SelectOptionsSource,
} from "@/lib/domain";
import type { LookupTableId } from "@/lib/domain/lookupIds";
import { proseText } from "@/lib/domain/prose";
import type { LogWriter } from "@/lib/log/writer";
import { parseLookupRevision } from "@/lib/lookup/schema";
import type {
	LookupDefinitionsSnapshot,
	LookupTableDefinition,
} from "@/lib/lookup/types";
import { McpContext } from "@/lib/mcp/context";
import type { ProgressEmitter } from "@/lib/mcp/progress";
import { GenerationContext } from "../generationContext";
import type {
	ConversionImpactFn,
	RecordMutationsResult,
} from "../toolExecutionContext";
import type { CanonicalMutationHost } from "../workspace/canonicalHost";
import { CanonicalMutationWorkspace } from "../workspace/canonicalWorkspace";
import type { ToolInvocationContext } from "../workspace/types";

/** The shared table-definition fixture, re-exported so the agent suites keep
 *  one import for their whole lookup harness. */
export { lookupTableDefinition } from "@/lib/__tests__/lookupFixtures";

/**
 * Default accumulator seed. Tests that need a specific run config
 * (edit mode, cache expired, etc.) pass overrides via `seed`.
 */
const DEFAULT_SEED: AccumulatorSeed = {
	target: { kind: "app", appId: "test-app" },
	userId: "user-1",
	runId: "run-1",
	holderNonce: "00000000-0000-4000-8000-000000000001",
	model: "gpt-5.6-sol",
	promptMode: "build",
	appReady: false,
	moduleCount: 0,
};

export interface MakeTestContextOptions {
	/** Override specific accumulator seed fields (runId, promptMode, etc.). */
	seed?: Partial<AccumulatorSeed>;
	/** Override the appId passed into `GenerationContext`. Defaults to
	 * "test-app" (matches `DEFAULT_SEED.target`) when not supplied. */
	appId?: string;
	/** Whether the run holds an edit `run_lock` (enables the per-step lease
	 * heartbeat). Defaults to `false` — a build-mode fixture. */
	editLease?: boolean;
	/** Override the retype-impact lookup. Defaults to a stub reporting an
	 * empty population, so a failable conversion proceeds without a
	 * needs-confirmation round in tests that don't exercise consent. */
	conversionImpact?: ConversionImpactFn;
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
 * once per test — nothing in the ctx reaches out to Postgres as long as
 * the test mocks `@/lib/db/apps` (or never calls
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
		projectId: "project-test",
		holderNonce:
			opts.seed?.holderNonce ?? "00000000-0000-4000-8000-000000000001",
		// Build-mode fixture by default (no edit run_lock, so no lease heartbeat).
		editLease: opts.editLease ?? false,
		conversionImpact: opts.conversionImpact ?? emptyConversionImpact,
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

/**
 * The one legal persisted birth state for tool tests that do not need a
 * purpose-built app. Mutating tools run the absolute commit gate, so an empty
 * module-less document is not a neutral seed: it is an impossible persisted
 * state whose pre-existing findings correctly block unrelated edits.
 */
export function makeCanonicalGenesisDoc(
	appName = "Test app",
	appId = "test-app",
): BlueprintDoc {
	const empty: BlueprintDoc = {
		appId,
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
	const genesis = canonicalAppGenesis(empty, appName);
	const verdict = mutationCommitVerdict(
		empty,
		genesis.mutations,
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	if (!verdict.ok) {
		throw new Error("Canonical genesis fixture failed its own commit gate.");
	}
	return verdict.nextDoc;
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
	/** Authoritative starting document for the exact in-memory guarded writer. */
	initialDoc: BlueprintDoc;
	/** App id. Defaults to `"test-app"`. */
	appId?: string;
	/** Better Auth user id. Defaults to `"user-1"`. */
	userId?: string;
	/** Per-run grouping id. Defaults to `"run-1"`. */
	runId?: string;
	/** Override the retype-impact lookup. Defaults to the empty-population
	 * stub (see `MakeTestContextOptions.conversionImpact`). */
	conversionImpact?: ConversionImpactFn;
}

/** The default retype-impact stub both fixture factories share: an
 *  empty population, so consent never triggers unless a test injects
 *  real counts. */
const emptyConversionImpact: ConversionImpactFn = async () => ({
	totalWithValue: 0,
	uncastable: 0,
	alreadyHeld: 0,
	samples: [],
});

/**
 * Build an `McpContext` wired to vi.fn stubs for its log writer and
 * progress emitter. The required `initialDoc` seeds the exact in-memory
 * `applyBlueprintChange` test writer used by tool suites, so every accepted
 * batch returns a complete authoritative committed document without Postgres.
 *
 * Mirrors `makeTestContext` for the chat surface: both helpers return a
 * `CanonicalMutationHost`-compatible value so shared tool modules can be
 * driven through either without per-test boilerplate. Cross-surface
 * tests use both helpers side by side to assert the same input produces
 * the same mutation batch on both surfaces.
 */
export function makeMcpTestContext(
	opts: MakeMcpTestContextOptions,
): MakeMcpTestContextHandles {
	seedApplyBlueprintChangeTestWriter(opts.initialDoc);
	const logWriterStub = {
		logEvent: vi.fn(),
		flush: vi.fn(),
	} as unknown as LogWriter;
	const progressStub: ProgressEmitter = { notify: vi.fn() };
	const ctx = new McpContext({
		appId: opts.appId ?? opts.initialDoc.appId,
		userId: opts.userId ?? "user-1",
		projectId: "project-test",
		runId: opts.runId ?? "run-1",
		logWriter: logWriterStub,
		progress: progressStub,
		conversionImpact: opts.conversionImpact ?? emptyConversionImpact,
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

/** Handles returned by `makeToolWorkspaceHarness` — a canonical workspace
 *  over a stub host, plus the vi.fn spies on the host's two persistence
 *  methods, so a tool test can assert what the tool persisted (mutations +
 *  stage) without a real `GenerationContext`. */
export interface ToolWorkspaceHarness {
	workspace: CanonicalMutationWorkspace;
	host: CanonicalMutationHost;
	/** Run one shared tool through the workspace — the same `invoke` path the
	 * SA wrapper and the MCP adapter use, so the tool receives a live
	 * `ToolInvocationContext` bound to the workspace's current snapshot. The
	 * workspace adopts each commit, so consecutive calls compose. */
	runTool<T>(
		tool: {
			execute(input: never, ctx: ToolInvocationContext): Promise<T>;
		},
		input: unknown,
	): Promise<T>;
	/** The workspace's CURRENT document — what the next invocation would read. */
	currentDoc(): BlueprintDoc;
	recordMutations: ReturnType<typeof vi.fn>;
	recordMutationStages: ReturnType<typeof vi.fn>;
	conversionImpact: ReturnType<typeof vi.fn>;
}

/** The stable identities {@link lookupSelectDoc} builds with. */
export const LOOKUP_SELECT_DOC = {
	moduleUuid: asUuid("11111111-1111-4111-8111-111111111111"),
	formUuid: asUuid("22222222-2222-4222-8222-222222222222"),
	selectUuid: asUuid("33333333-3333-4333-8333-333333333333"),
} as const;

/**
 * One module, one survey form, one single-select `destination` drawing on
 * the given choice source — lookup-bound, or inline for the fresh-app shape a
 * first table binding starts from. Round-tripped through the persisted shape
 * so it carries exactly what a loaded app carries.
 */
export function lookupSelectDoc(
	optionsSource: SelectOptionsSource,
): BlueprintDoc {
	const doc = buildDoc({
		modules: [
			{
				uuid: LOOKUP_SELECT_DOC.moduleUuid,
				id: "referrals",
				name: "Referrals",
				forms: [
					{
						uuid: LOOKUP_SELECT_DOC.formUuid,
						id: "intake",
						name: "Intake",
						type: "survey",
						fields: [
							f({
								uuid: LOOKUP_SELECT_DOC.selectUuid,
								kind: "single_select",
								id: "destination",
								label: proseText("Destination"),
								optionsSource,
							}),
						],
					},
				],
			},
		],
	});
	return hydratePersistedBlueprint(toPersistableDoc(doc));
}

/**
 * A `lookupDefinitions` reader over a fixed catalog. It answers exactly the
 * requested ids it knows, so the ids a gate asked for are visible in the spy's
 * arguments, and an id it never asked for is absent from the snapshot — which
 * the validator reports as a table that isn't available, the honest outcome
 * for a reference the gate failed to resolve.
 */
export function echoLookupDefinitions(
	catalog: readonly LookupTableDefinition[],
) {
	const byId = new Map(
		catalog.map((definition) => [definition.id, definition] as const),
	);
	return vi.fn(
		async (
			tableIds: readonly LookupTableId[],
		): Promise<LookupDefinitionsSnapshot> => ({
			projectId: "project-test",
			projectRevision: parseLookupRevision("1"),
			definitions: tableIds.flatMap((id) => {
				const definition = byId.get(id);
				return definition === undefined ? [] : [definition];
			}),
		}),
	);
}

export interface MakeToolWorkspaceHarnessOptions {
	appId?: string;
	userId?: string;
	runId?: string;
	conversionImpact?: ConversionImpactFn;
	/** Optional Project data reader for lookup-carrying candidates. */
	lookupDefinitions?: CanonicalMutationHost["lookupDefinitions"];
	lookupCatalog?: CanonicalMutationHost["lookupCatalog"];
	/** Optional chat holder capability, for tools exercising chat-only side
	 * effects. */
	chatRunHolder?: CanonicalMutationHost["chatRunHolder"];
	/** Optional authorized-reload hook, for tests exercising the workspace's
	 * conflict recovery. */
	reloadAuthorizedSnapshot?: CanonicalMutationHost["reloadAuthorizedSnapshot"];
}

/**
 * A canonical workspace over a lightweight stub host for shared-tool tests
 * that exercise a tool body's mutation emission — no Postgres, no guarded
 * writer, no SSE writer.
 *
 * Both `recordMutations` and `recordMutationStages` return the
 * `{ events, committedDoc }` shape the real writer surfaces, echoing the
 * prepared candidate's `nextDoc` as the committed doc. That models the
 * no-concurrent-peer-edit case: the workspace continues against exactly the
 * doc the batch produced, which is what every single-surface tool test
 * asserts. (Concurrent-merge behavior — the committed doc differing from the
 * local candidate — is covered against the real writer in the
 * `commitGuardedBatch` emulator suite and `generationContext-recordMutations`.)
 */
export function makeToolWorkspaceHarness(
	initialDoc: BlueprintDoc,
	opts: MakeToolWorkspaceHarnessOptions = {},
): ToolWorkspaceHarness {
	const recordMutations = vi.fn(
		async (
			prepared: PreparedMutationCandidate,
		): Promise<RecordMutationsResult> => ({
			events: [],
			committedDoc: prepared.nextDoc,
		}),
	);
	const recordMutationStages = vi.fn(
		async (
			prepared: PreparedMutationCandidate,
			_stages: AdmittedMutationStages,
		): Promise<RecordMutationsResult> => ({
			events: [],
			committedDoc: prepared.nextDoc,
		}),
	);
	const conversionImpact = vi.fn(
		opts.conversionImpact ?? emptyConversionImpact,
	);
	const host: CanonicalMutationHost = {
		appId: opts.appId ?? "test-app",
		projectId: "project-test",
		userId: opts.userId ?? "user-1",
		runId: opts.runId ?? "run-1",
		...(opts.chatRunHolder !== undefined && {
			chatRunHolder: opts.chatRunHolder,
		}),
		...(opts.lookupDefinitions !== undefined && {
			lookupDefinitions: opts.lookupDefinitions,
		}),
		...(opts.lookupCatalog !== undefined && {
			lookupCatalog: opts.lookupCatalog,
		}),
		...(opts.reloadAuthorizedSnapshot !== undefined && {
			reloadAuthorizedSnapshot: opts.reloadAuthorizedSnapshot,
		}),
		conversionImpact,
		recordMutations,
		recordMutationStages,
	};
	const workspace = new CanonicalMutationWorkspace({ host, initialDoc });
	return {
		workspace,
		host,
		runTool: (tool, input) =>
			workspace.invoke({
				toolName: "test-tool",
				execute: (ctx) => tool.execute(input as never, ctx),
			}),
		currentDoc: () => workspace.currentSnapshot().doc,
		recordMutations,
		recordMutationStages,
		conversionImpact,
	};
}
