/**
 * `registerGetAgentPrompt` unit tests.
 *
 * Verifies the load-bearing behaviors of the self-fetch bootstrap tool:
 *
 *   - Build mode: rendering happens with no `app_id` round trip; even a
 *     spurious `app_id` is ignored (no Firestore call) and `_meta.app_id`
 *     is *not* stamped on the build envelope (an admin surface seeing
 *     `app_id` here would falsely correlate a build run to an unrelated
 *     app). Two combos cover interactive vs autonomous wiring — the
 *     wiring difference shows up as a different Interaction Mode
 *     section appended to the returned text.
 *   - Edit mode happy path: ownership check + blueprint load + doc
 *     threaded into the renderer; the returned text carries
 *     `EDIT_PREAMBLE` framing + the inlined blueprint summary
 *     (verified by spot-checking the fixture's app + module names in
 *     the emitted text). `_meta.app_id` rides on success.
 *   - Edit mode missing `app_id`: collapses to the `invalid_input`
 *     bucket via `McpInvalidInputError` — argument-validation failures
 *     short-circuit the classifier with a precise wire `error_type`.
 *   - Edit mode unowned `app_id`: collapses to `not_found` (IDOR
 *     hardening — same envelope as a missing-id probe).
 *   - Edit mode empty-modules doc: `buildSolutionsArchitectPrompt` treats
 *     empty docs as build, so the emitted text contains build markers.
 *     `_meta.app_id` still rides (the handler did load the doc; the
 *     renderer's internal fallthrough is the right thing to do).
 *   - `_meta.run_id` threading: client-supplied id rides through; absent
 *     id gets a freshly-minted uuid v4 — same on success and error
 *     paths.
 *   - Error envelope parity: a thrown `renderAgentPrompt` surfaces as an
 *     MCP `isError: true` envelope classified through the shared
 *     taxonomy, with `run_id` stamped on `_meta`.
 *
 * The MCP SDK is mocked at the boundary through the shared
 * `makeFakeServer` helper that captures the handler callback. The
 * prompts renderer is wrapped with a spy so handler→renderer arg
 * threading is verifiable, and Firestore is mocked at the data layer
 * (`@/lib/db/apps`) and at the loader layer (`../loadApp`) following
 * the same pattern `compileApp.test.ts` uses.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadAppOwner } from "@/lib/db/apps";
import type { BlueprintDoc } from "@/lib/domain";
import { asUuid } from "@/lib/domain";
import { type LoadedApp, loadAppBlueprint } from "../loadApp";
import { renderAgentPrompt } from "../prompts";
import { registerGetAgentPrompt } from "../tools/getAgentPrompt";
import type { ToolContext } from "../types";
import { makeFakeServer } from "./fakeServer";

/* Hoisted mocks — every dependency the tool touches has a vi.fn()
 * stand-in. The renderer wrap preserves the real implementation as
 * the default so happy-path payloads stay realistic; the error-path
 * test flips it via `mockImplementationOnce`. The two data-layer
 * mocks (`loadAppOwner`, `loadAppBlueprint`) drive the edit-mode
 * ownership + load round-trip without going through Firestore. */
vi.mock("../prompts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../prompts")>();
	return {
		...actual,
		renderAgentPrompt: vi.fn(actual.renderAgentPrompt),
	};
});
vi.mock("@/lib/db/apps", () => ({
	loadAppOwner: vi.fn(),
}));
vi.mock("../loadApp", () => ({
	loadAppBlueprint: vi.fn(),
}));

/* --- Helpers --------------------------------------------------------- */

/**
 * Loose UUID-v4 regex — asserts on shape (rather than pinning a value)
 * so tests stay decoupled from `crypto.randomUUID()`'s output while
 * still catching a regression that would return a fixed string or
 * something structurally wrong (e.g. a stringified counter).
 */
const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Baseline tool context — scopes aren't inspected by the tool body. */
const toolCtx: ToolContext = { userId: "u1", scopes: [] };

/**
 * Build a minimal-but-renderable blueprint with one module/form/field
 * so `summarizeBlueprint` produces strings the assertions can spot-
 * check. Mirrors `getApp.test.ts`'s fixture shape.
 */
function fixturePopulatedDoc(): BlueprintDoc {
	const modUuid = asUuid("11111111-1111-1111-1111-111111111111");
	const formUuid = asUuid("22222222-2222-2222-2222-222222222222");
	const fieldUuid = asUuid("33333333-3333-3333-3333-333333333333");
	return {
		appId: "a-edit",
		appName: "Vaccine Tracker",
		connectType: null,
		caseTypes: null,
		modules: {
			[modUuid]: {
				uuid: modUuid,
				id: "patients",
				name: "Patients",
				caseType: "patient",
			},
		},
		forms: {
			[formUuid]: {
				uuid: formUuid,
				id: "register",
				name: "Register Patient",
				type: "registration",
			},
		},
		fields: {
			[fieldUuid]: {
				uuid: fieldUuid,
				id: "patient_name",
				kind: "text",
				label: "Patient Name",
				required: "true()",
			},
		},
		moduleOrder: [modUuid],
		formOrder: { [modUuid]: [formUuid] },
		fieldOrder: { [formUuid]: [fieldUuid] },
		fieldParent: {},
	};
}

/**
 * Empty-doc fixture — the degenerate edit case `createApp` produces
 * before any modules land. `buildSolutionsArchitectPrompt` keys off
 * `doc?.moduleOrder.length > 0` and routes empty docs into the build
 * branch; the regression test below confirms that fallthrough is
 * preserved when the doc comes through the MCP tool boundary.
 */
function fixtureEmptyDoc(): BlueprintDoc {
	return {
		appId: "a-empty",
		appName: "Untitled",
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
 * Wrap a `BlueprintDoc` in the `LoadedApp` shape `loadAppBlueprint`
 * resolves to. The tool consumes only `.doc`, so `.app` is a minimal
 * shell — the renderer never reads it.
 */
function loadedFor(doc: BlueprintDoc): LoadedApp {
	return {
		doc,
		app: {
			owner: "u1",
			app_name: doc.appName,
			connect_type: null,
			module_count: doc.moduleOrder.length,
			form_count: 0,
			status: "complete",
			error_type: null,
			deleted_at: null,
			recoverable_until: null,
			run_id: null,
			created_at: new Date() as unknown as LoadedApp["app"]["created_at"],
			updated_at: new Date() as unknown as LoadedApp["app"]["updated_at"],
		},
	};
}

beforeEach(() => {
	vi.mocked(renderAgentPrompt).mockClear();
	vi.mocked(loadAppOwner).mockReset();
	vi.mocked(loadAppBlueprint).mockReset();
});

/* --- Tests ----------------------------------------------------------- */

describe("registerGetAgentPrompt — build mode", () => {
	/* Build mode covers the trivial path: no `app_id`, no Firestore,
	 * the renderer is called with no doc. Two combos pin interactive vs
	 * autonomous wiring — verified via the distinct Interaction Mode
	 * wording each emits. */
	const combos = [
		{
			interactive: true,
			/* Interactive: the permission block appears verbatim. */
			expectedPhrase: "AskUserQuestion tool",
			forbiddenPhrase: "not available to you",
		},
		{
			interactive: false,
			/* Autonomous: the "not available" reminder appears instead. */
			expectedPhrase: "not available to you",
			forbiddenPhrase: "ask at most a handful",
		},
	];

	for (const combo of combos) {
		it(`interactive=${combo.interactive} emits the matching Interaction Mode block`, async () => {
			const { server, capture } = makeFakeServer();
			registerGetAgentPrompt(server, toolCtx);

			const out = (await capture()(
				{ mode: "build", interactive: combo.interactive },
				{},
			)) as {
				content: Array<{ type: "text"; text: string }>;
				_meta: { run_id: string; app_id?: string };
			};

			const text = out.content[0]?.text ?? "";
			expect(text.length).toBeGreaterThan(0);
			expect(text).toContain(combo.expectedPhrase);
			expect(text).not.toContain(combo.forbiddenPhrase);

			/* Build mode never stamps `app_id` on the success envelope —
			 * an admin surface correlating runs to apps would otherwise
			 * see a misleading id on a call that didn't touch one. */
			expect(out._meta.app_id).toBeUndefined();
			expect(out._meta.run_id).toMatch(UUID_RE);

			/* Renderer was called with no doc — build mode never loads
			 * the blueprint. The handler omits the second argument
			 * entirely (rather than passing `undefined`), matching the
			 * default-optional contract of
			 * `renderAgentPrompt(interactive, editDoc?)`. */
			expect(renderAgentPrompt).toHaveBeenCalledWith(combo.interactive);
			expect(loadAppBlueprint).not.toHaveBeenCalled();
			expect(loadAppOwner).not.toHaveBeenCalled();
		});
	}

	it("ignores a spurious app_id quietly (no Firestore call, no app_id on _meta)", async () => {
		/* Sharp-edge contract: `mode` is the authoritative discriminator,
		 * so a build-mode call carrying an `app_id` must NOT trigger an
		 * ownership round trip or stamp `_meta.app_id`. The skill is
		 * trusted to pass `mode` correctly; build mode has no app to
		 * gate on. */
		const { server, capture } = makeFakeServer();
		registerGetAgentPrompt(server, toolCtx);

		const out = (await capture()(
			{ mode: "build", interactive: true, app_id: "spurious-id" },
			{},
		)) as { _meta: { run_id: string; app_id?: string } };

		expect(out._meta.app_id).toBeUndefined();
		expect(loadAppBlueprint).not.toHaveBeenCalled();
		expect(loadAppOwner).not.toHaveBeenCalled();
		/* The renderer still runs with no doc — confirms build mode is
		 * truly app-agnostic end-to-end. */
		expect(renderAgentPrompt).toHaveBeenCalledWith(true);
	});
});

describe("registerGetAgentPrompt — edit mode happy path", () => {
	it("loads the blueprint, threads it through the renderer, and returns the inlined edit prompt", async () => {
		vi.mocked(loadAppOwner).mockResolvedValueOnce("u1");
		const doc = fixturePopulatedDoc();
		vi.mocked(loadAppBlueprint).mockResolvedValueOnce(loadedFor(doc));

		const { server, capture } = makeFakeServer();
		registerGetAgentPrompt(server, toolCtx);

		const out = (await capture()(
			{ mode: "edit", interactive: true, app_id: "a-edit" },
			{},
		)) as {
			content: Array<{ type: "text"; text: string }>;
			_meta: { app_id: string; run_id: string };
		};

		const text = out.content[0]?.text ?? "";
		/* `EDIT_PREAMBLE` framing must appear — edit mode boots with
		 * the same prompt `/api/chat`'s edit mode produces; this is
		 * the end-to-end parity check. */
		expect(text).toContain("Editing Mode");
		expect(text).toContain("full visibility");
		/* Inlined `summarizeBlueprint(doc)` must surface the fixture's
		 * recognizable strings — proves the doc actually reached the
		 * renderer and the summary was rendered against it (rather
		 * than a spurious empty-doc fallback). */
		expect(text).toContain("Vaccine Tracker");
		expect(text).toContain("Patients");

		expect(out._meta.app_id).toBe("a-edit");
		expect(out._meta.run_id).toMatch(UUID_RE);

		/* Renderer received `(interactive, doc)` — confirms the
		 * handler did the threading rather than dropping the doc. */
		expect(renderAgentPrompt).toHaveBeenCalledWith(true, doc);
		/* The single-load invariant — the tool issues exactly one
		 * blueprint read per call. */
		expect(loadAppBlueprint).toHaveBeenCalledTimes(1);
	});
});

describe("registerGetAgentPrompt — edit mode missing app_id", () => {
	it("collapses to error_type = 'invalid_input' without touching Firestore", async () => {
		/* The whole point of edit mode is to inline the blueprint
		 * summary — without `app_id` the handler can't ownership-gate
		 * or load, so it refuses with a deterministic
		 * `invalid_input` envelope rather than rendering a misleading
		 * build prompt under an edit description. */
		const { server, capture } = makeFakeServer();
		registerGetAgentPrompt(server, toolCtx);

		const out = (await capture()({ mode: "edit", interactive: true }, {})) as {
			isError?: true;
			content: Array<{ type: "text"; text: string }>;
			_meta?: { error_type: string; run_id?: string };
		};

		expect(out.isError).toBe(true);
		expect(out._meta?.error_type).toBe("invalid_input");
		/* The thrown message rides through to the wire text so the
		 * client can show a precise reason — the classifier's generic
		 * "internal" message would have lost that. */
		expect(out.content[0]?.text).toContain("edit mode requires app_id");
		/* The minted run id holds on the error path too — the per-call
		 * grouping invariant can't break on argument-validation
		 * failures. */
		expect(out._meta?.run_id).toMatch(UUID_RE);
		/* Hard short-circuit: argument validation runs before any
		 * Firestore call. */
		expect(loadAppOwner).not.toHaveBeenCalled();
		expect(loadAppBlueprint).not.toHaveBeenCalled();
	});
});

describe("registerGetAgentPrompt — edit mode unowned app_id", () => {
	it("collapses to error_type = 'not_found' (IDOR hardening), never loads the blueprint", async () => {
		/* IDOR hardening: cross-tenant probes see the same envelope a
		 * missing-id probe would see. The internal `not_owner` reason
		 * stays on `McpAccessError` for the audit log; the wire only
		 * exposes `not_found`. */
		vi.mocked(loadAppOwner).mockResolvedValueOnce("someone-else");

		const { server, capture } = makeFakeServer();
		registerGetAgentPrompt(server, toolCtx);

		const out = (await capture()(
			{ mode: "edit", interactive: true, app_id: "owned-by-other" },
			{},
		)) as {
			isError?: true;
			content: Array<{ type: "text"; text: string }>;
			_meta?: { error_type: string; app_id?: string; run_id?: string };
		};

		expect(out.isError).toBe(true);
		expect(out._meta?.error_type).toBe("not_found");
		expect(out.content[0]?.text).toBe("App not found.");
		expect(out._meta?.app_id).toBe("owned-by-other");
		expect(out._meta?.run_id).toMatch(UUID_RE);
		/* Cross-tenant probes must short-circuit — no blueprint load. */
		expect(loadAppBlueprint).not.toHaveBeenCalled();
	});
});

describe("registerGetAgentPrompt — edit mode empty-modules doc", () => {
	it("falls back to the build prompt body when the loaded doc has no modules", async () => {
		/* Degenerate edit case: `createApp` writes an empty doc before
		 * any generation tools fire. `buildSolutionsArchitectPrompt`
		 * routes empty docs into the build branch; the tool must
		 * inherit that fallthrough so the emitted text isn't a
		 * malformed edit prompt against an empty structure. The tool's
		 * envelope still stamps `app_id` on `_meta` — the handler did
		 * load the doc and gate on ownership, the renderer's internal
		 * fallthrough is the orthogonal concern. */
		vi.mocked(loadAppOwner).mockResolvedValueOnce("u1");
		const empty = fixtureEmptyDoc();
		vi.mocked(loadAppBlueprint).mockResolvedValueOnce(loadedFor(empty));

		const { server, capture } = makeFakeServer();
		registerGetAgentPrompt(server, toolCtx);

		const out = (await capture()(
			{ mode: "edit", interactive: true, app_id: "a-empty" },
			{},
		)) as {
			content: Array<{ type: "text"; text: string }>;
			_meta: { app_id: string };
		};

		const text = out.content[0]?.text ?? "";
		/* Build framing leaked through, edit framing did not — the
		 * underlying `buildSolutionsArchitectPrompt` did the right
		 * thing with the empty doc and the tool didn't paper over it. */
		expect(text).toContain("Initial Build");
		expect(text).not.toContain("Editing Mode");
		/* `_meta.app_id` still rides — the tool processed the edit
		 * request, even if the body happened to render as build. */
		expect(out._meta.app_id).toBe("a-empty");
	});
});

describe("registerGetAgentPrompt — run_id threading", () => {
	it("threads a client-supplied run_id from extra._meta.run_id onto the success envelope", async () => {
		const { server, capture } = makeFakeServer();
		registerGetAgentPrompt(server, toolCtx);

		const out = (await capture()(
			{ mode: "build", interactive: true },
			{ _meta: { run_id: "client-rid-42" } },
		)) as { _meta: { run_id: string } };

		expect(out._meta.run_id).toBe("client-rid-42");
	});

	it("mints a uuid v4 run_id when the client doesn't supply one", async () => {
		const { server, capture } = makeFakeServer();
		registerGetAgentPrompt(server, toolCtx);

		const out = (await capture()(
			{ mode: "build", interactive: false },
			{},
		)) as {
			_meta: { run_id: string };
		};

		expect(out._meta.run_id).toMatch(UUID_RE);
	});
});

describe("registerGetAgentPrompt — renderAgentPrompt throws", () => {
	it("surfaces as an MCP error envelope with a populated error_type and the resolved run_id", async () => {
		/* Force the renderer to throw to exercise the tool's try/catch +
		 * classifier path. The envelope must carry `isError: true`, a
		 * non-empty `error_type`, AND the same `run_id` a success would
		 * have stamped — admin surfaces grouping by run id must see error
		 * responses under the same id as the rest of the call. */
		vi.mocked(renderAgentPrompt).mockImplementationOnce(() => {
			throw new Error("renderer exploded");
		});

		const { server, capture } = makeFakeServer();
		registerGetAgentPrompt(server, toolCtx);

		const out = (await capture()(
			{ mode: "build", interactive: true },
			{ _meta: { run_id: "client-rid-err" } },
		)) as {
			isError?: true;
			_meta?: { error_type: string; run_id?: string };
		};

		expect(out.isError).toBe(true);
		expect(typeof out._meta?.error_type).toBe("string");
		expect(out._meta?.error_type.length ?? 0).toBeGreaterThan(0);
		expect(out._meta?.run_id).toBe("client-rid-err");
	});
});
