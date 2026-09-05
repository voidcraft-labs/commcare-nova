/**
 * `registerGetAgentPrompt` unit tests.
 *
 * Verifies the load-bearing behaviors of the self-fetch bootstrap tool:
 *
 *   - Build mode: rendering happens with no `app_id` round trip; a
 *     spurious `app_id` is ignored (no app load). Two combos
 *     cover interactive vs autonomous wiring — the wiring difference
 *     shows up as a different Interaction Mode section appended to
 *     the returned text.
 *   - Edit mode happy path: ownership check + blueprint load + doc
 *     threaded into the renderer; the returned text carries
 *     `EDIT_PREAMBLE` framing + the inlined blueprint summary
 *     (verified by spot-checking the fixture's app + module names in
 *     the emitted text).
 *   - Edit mode missing `app_id`: collapses to the `invalid_input`
 *     bucket via `McpInvalidInputError` — argument-validation failures
 *     short-circuit the classifier with a precise wire `error_type`.
 *   - Edit mode unowned `app_id`: collapses to `not_found` (IDOR
 *     hardening — same envelope as a missing-id probe).
 *   - Defensive in-memory empty-modules doc: `buildSolutionsArchitectPrompt`
 *     treats the impossible persisted shape as build framing.
 *   - Error envelope parity: a thrown `renderAgentPrompt` surfaces as
 *     an MCP `isError: true` envelope classified through the shared
 *     taxonomy.
 *
 * The MCP SDK is mocked at the boundary through the shared
 * `makeFakeServer` helper that captures the handler callback. The
 * prompts renderer is wrapped with a spy so handler→renderer arg
 * threading is verifiable, and the data layer (`@/lib/db/apps`) and the
 * loader layer (`../loadApp`) are mocked, following
 * the same pattern `compileApp.test.ts` uses.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { xp } from "@/lib/__tests__/docHelpers";
import type { BlueprintDoc } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";

import { type LoadedApp, loadAppBlueprint } from "../loadApp";
import { McpAccessError } from "../ownership";
import {
	AGENT_PROMPT_RESULT_BUDGET_CHARS,
	type AgentPromptPage,
} from "../promptDelivery";
import { renderAgentPrompt } from "../prompts";
import { MAX_RESULT_SIZE_CHARS } from "../resultSize";
import { registerGetAgentPrompt } from "../tools/getAgentPrompt";
import type { ToolContext } from "../types";
import { type CapturedToolHandler, makeFakeServer } from "./fakeServer";

/* Hoisted mocks — every dependency the tool touches has a vi.fn()
 * stand-in. The renderer wrap preserves the real implementation as
 * the default so happy-path payloads stay realistic; the error-path
 * test flips it via `mockImplementationOnce`. `loadAppBlueprint` is
 * mocked directly to drive ownership + load scenarios via resolve /
 * reject — both succeed and `McpAccessError` failures route through
 * the same single-read entry point. */
vi.mock("../prompts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../prompts")>();
	return {
		...actual,
		renderAgentPrompt: vi.fn(actual.renderAgentPrompt),
	};
});
vi.mock("../loadApp", () => ({
	loadAppBlueprint: vi.fn(),
}));

/* --- Helpers --------------------------------------------------------- */

/** Baseline tool context — scopes aren't inspected by the tool body. */
const toolCtx: ToolContext = { userId: "u1", scopes: [], authKind: "oauth" };

/**
 * Build a minimal-but-renderable blueprint with one module/form/field
 * so `summarizeBlueprint` produces strings the assertions can spot-
 * check. Mirrors `getApp.test.ts`'s fixture shape.
 */
function fixturePopulatedDoc(): BlueprintDoc {
	const modUuid = testUuid("11111111-1111-1111-1111-111111111111");
	const formUuid = testUuid("22222222-2222-2222-2222-222222222222");
	const fieldUuid = testUuid("33333333-3333-3333-3333-333333333333");
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
				label: proseText("Patient Name"),
				required: xp("true()"),
			},
		},
		moduleOrder: [modUuid],
		formOrder: { [modUuid]: [formUuid] },
		fieldOrder: { [formUuid]: [fieldUuid] },
		fieldParent: {},
	};
}

/**
 * Defensive in-memory empty-doc fixture. Persisted `createApp` always returns
 * canonical genesis, but `buildSolutionsArchitectPrompt` still fails safe to
 * build framing when this impossible persisted shape reaches the MCP boundary.
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
			project_id: "project-1",
			app_name: doc.appName,
			mutation_seq: 0,
			connect_type: null,
			module_count: doc.moduleOrder.length,
			form_count: 0,
			status: "complete",
			error_type: null,
			deleted_at: null,
			recoverable_until: null,
			run_id: null,
			run_holder_nonce: null,
			created_at: new Date() as unknown as LoadedApp["app"]["created_at"],
			updated_at: new Date() as unknown as LoadedApp["app"]["updated_at"],
		},
		access: {
			projectId: "project-1",
			role: "owner",
			actorUserId: "u1",
		},
	};
}

/** Consume the same plain-text-or-paged result contract as a first-party MCP
 * caller so prompt-content assertions remain independent of prompt growth. */
async function readCompletePrompt(
	handler: CapturedToolHandler,
	args: {
		readonly mode: "build" | "autonomous_build" | "edit";
		app_id?: string;
	},
): Promise<string> {
	const chunks: string[] = [];
	let cursor: string | undefined;
	do {
		const out = (await handler(
			{ ...args, ...(cursor === undefined ? {} : { cursor }) },
			{},
		)) as { content: Array<{ type: "text"; text: string }> };
		const text = out.content[0]?.text ?? "";
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			return text;
		}
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			!("kind" in parsed) ||
			parsed.kind !== "nova-agent-prompt-page"
		) {
			return text;
		}
		const page = parsed as AgentPromptPage;
		chunks.push(page.prompt_chunk);
		cursor = page.next_cursor;
	} while (cursor !== undefined);
	return chunks.join("");
}

beforeEach(() => {
	vi.mocked(renderAgentPrompt).mockClear();
	vi.mocked(loadAppBlueprint).mockReset();
});

/* --- Tests ----------------------------------------------------------- */

describe("registerGetAgentPrompt — build modes", () => {
	/* Build modes cover the trivial path: no `app_id`, no app load,
	 * the renderer is called with no doc. Two combos pin interactive vs
	 * autonomous wiring — verified via the distinct Interaction Mode
	 * wording each emits. The interactive axis rides on `mode`
	 * (`build` vs `autonomous_build`); the handler derives the boolean
	 * for `renderAgentPrompt`. */
	const combos = [
		{
			mode: "build" as const,
			/* Interactive: the permission block appears verbatim. */
			expectedPhrase: "AskUserQuestion tool",
			forbiddenPhrase: "not available to you",
			rendererArg: true,
		},
		{
			mode: "autonomous_build" as const,
			/* Autonomous: the "not available" reminder appears instead. */
			expectedPhrase: "not available to you",
			forbiddenPhrase: "ask at most a handful",
			rendererArg: false,
		},
	];

	for (const combo of combos) {
		it(`mode=${combo.mode} emits the matching Interaction Mode block`, async () => {
			const { server, capture } = makeFakeServer();
			registerGetAgentPrompt(server, toolCtx);

			const text = await readCompletePrompt(capture(), { mode: combo.mode });
			expect(text.length).toBeGreaterThan(0);
			expect(text).toContain(combo.expectedPhrase);
			expect(text).not.toContain(combo.forbiddenPhrase);

			/* Renderer was called with no doc — build modes never load
			 * the blueprint. The handler omits the second argument
			 * entirely (rather than passing `undefined`), matching the
			 * default-optional contract of
			 * `renderAgentPrompt(interactive, editDoc?)`. */
			expect(renderAgentPrompt).toHaveBeenCalledWith(combo.rendererArg);
			expect(loadAppBlueprint).not.toHaveBeenCalled();
		});
	}

	it("keeps project-space compatibility out of autonomous app design", async () => {
		const { server, capture } = makeFakeServer();
		registerGetAgentPrompt(server, toolCtx);

		const text = await readCompletePrompt(capture(), {
			mode: "autonomous_build",
		});

		expect(text).not.toContain("Publishing FYI");
		expect(text).not.toContain("get_app_hq_feature_flags");
		expect(text).not.toContain("check_project_space_compatibility");
		expect(text).not.toContain("project_space_compatibility");
		expect(text).not.toContain("support@dimagi.com");
		expect(text).toContain("NOVA-PROMPT-END");
	});

	it("ignores a spurious app_id quietly (no app load)", async () => {
		/* Sharp-edge contract: `mode` is the authoritative discriminator,
		 * so a build-mode call carrying an `app_id` must NOT trigger an
		 * ownership round trip. The skill is trusted to pass `mode`
		 * correctly; build modes have no app to gate on. */
		const { server, capture } = makeFakeServer();
		registerGetAgentPrompt(server, toolCtx);

		await capture()({ mode: "build", app_id: "spurious-id" }, {});

		expect(loadAppBlueprint).not.toHaveBeenCalled();
		/* The renderer still runs with no doc — confirms build mode is
		 * truly app-agnostic end-to-end. */
		expect(renderAgentPrompt).toHaveBeenCalledWith(true);
	});
});

describe("registerGetAgentPrompt — edit mode happy path", () => {
	it("loads the blueprint, threads it through the renderer, and returns the inlined edit prompt", async () => {
		const doc = fixturePopulatedDoc();
		vi.mocked(loadAppBlueprint).mockResolvedValue(loadedFor(doc));

		const { server, capture } = makeFakeServer();
		registerGetAgentPrompt(server, toolCtx);

		const handler = vi.fn(capture());
		const text = await readCompletePrompt(handler, {
			mode: "edit",
			app_id: "a-edit",
		});
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
		expect(text).not.toMatch(/\bModule \d+\b|\bForm \d+\b/);
		/* Read the identity off the fixture — hard-coding it here would assert
		 * the fixture rather than that the summary carries addressable uuids. */
		expect(text).toContain(`Module "Patients" [uuid ${doc.moduleOrder[0]}]`);

		/* Renderer received `(interactive, doc)` — confirms the
		 * handler did the threading rather than dropping the doc. */
		expect(renderAgentPrompt).toHaveBeenCalledWith(true, doc);
		/* Each page reauthorizes and reads once; prompt growth may require
		 * several pages without changing the complete operating instructions. */
		expect(handler).toHaveBeenCalled();
		expect(loadAppBlueprint).toHaveBeenCalledTimes(handler.mock.calls.length);
		expect(renderAgentPrompt).toHaveBeenCalledTimes(handler.mock.calls.length);
		expect(text).toContain("NOVA-PROMPT-END");
	});

	it("reloads the app and continues a snapshot-bound oversized prompt", async () => {
		const doc = fixturePopulatedDoc();
		const oversized = `full guidance\n${"x".repeat(MAX_RESULT_SIZE_CHARS + 1_000)}\nNOVA-PROMPT-END`;
		vi.mocked(loadAppBlueprint)
			.mockResolvedValueOnce(loadedFor(doc))
			.mockResolvedValueOnce(loadedFor(doc));
		vi.mocked(renderAgentPrompt)
			.mockImplementationOnce(() => oversized)
			.mockImplementationOnce(() => oversized);

		const { server, capture } = makeFakeServer();
		registerGetAgentPrompt(server, toolCtx);
		const first = (await capture()({ mode: "edit", app_id: "a-edit" }, {})) as {
			content: Array<{ type: "text"; text: string }>;
		};
		const firstText = first.content[0]?.text ?? "";
		expect(firstText.length).toBeLessThanOrEqual(
			AGENT_PROMPT_RESULT_BUDGET_CHARS,
		);
		const firstPage = JSON.parse(firstText) as {
			kind: string;
			offset_unit: string;
			chunk_end: number;
			next_cursor?: string;
		};
		expect(firstPage.kind).toBe("nova-agent-prompt-page");
		expect(firstPage.offset_unit).toBe("unicode-code-points");
		expect(firstPage.next_cursor).toEqual(expect.any(String));

		const second = (await capture()(
			{
				mode: "edit",
				app_id: "a-edit",
				cursor: firstPage.next_cursor,
			},
			{},
		)) as { content: Array<{ type: "text"; text: string }> };
		const secondPage = JSON.parse(second.content[0]?.text ?? "") as {
			chunk_start: number;
			complete: boolean;
			prompt_chunk: string;
		};
		expect(secondPage.chunk_start).toBe(firstPage.chunk_end);
		expect(secondPage.complete).toBe(true);
		expect(secondPage.prompt_chunk.endsWith("NOVA-PROMPT-END")).toBe(true);
		expect(loadAppBlueprint).toHaveBeenCalledTimes(2);
	});
});

describe("registerGetAgentPrompt — edit mode missing app_id", () => {
	it("collapses to error_type = 'invalid_input' without loading the app", async () => {
		/* The whole point of edit mode is to inline the blueprint
		 * summary — without `app_id` the handler can't ownership-gate
		 * or load, so it refuses with a deterministic
		 * `invalid_input` envelope rather than rendering a misleading
		 * build prompt under an edit description. */
		const { server, capture } = makeFakeServer();
		registerGetAgentPrompt(server, toolCtx);

		const out = (await capture()({ mode: "edit" }, {})) as {
			isError?: true;
			content: Array<{ type: "text"; text: string }>;
		};

		expect(out.isError).toBe(true);
		const payload = JSON.parse(out.content[0]?.text ?? "{}") as {
			error_type: string;
			message: string;
		};
		expect(payload.error_type).toBe("invalid_input");
		/* The thrown message rides through as the content's `message`
		 * field so the client can show a precise reason — the
		 * classifier's generic "internal" message would have lost that. */
		expect(payload.message).toContain("edit mode requires app_id");
		/* Hard short-circuit: argument validation runs before any
		 * app load. */
		expect(loadAppBlueprint).not.toHaveBeenCalled();
	});
});

describe("registerGetAgentPrompt — edit mode unowned app_id", () => {
	it("collapses to error_type = 'not_found' (IDOR hardening), never renders", async () => {
		/* IDOR hardening: cross-tenant probes see the same envelope a
		 * missing-id probe would see. `loadAppBlueprint` throws
		 * `McpAccessError("not_owner")`; the wire collapses to
		 * `not_found`. */
		vi.mocked(loadAppBlueprint).mockRejectedValueOnce(
			new McpAccessError("not_owner"),
		);

		const { server, capture } = makeFakeServer();
		registerGetAgentPrompt(server, toolCtx);

		const out = (await capture()(
			{ mode: "edit", app_id: "owned-by-other" },
			{},
		)) as {
			isError?: true;
			content: Array<{ type: "text"; text: string }>;
		};

		expect(out.isError).toBe(true);
		const payload = JSON.parse(out.content[0]?.text ?? "{}") as {
			error_type: string;
			message: string;
			app_id: string;
		};
		expect(payload.error_type).toBe("not_found");
		expect(payload.message).toBe("App not found.");
		expect(payload.app_id).toBe("owned-by-other");
		/* Cross-tenant probes must short-circuit — the renderer never
		 * runs because `loadAppBlueprint` threw before reaching it. */
		expect(renderAgentPrompt).not.toHaveBeenCalled();
	});
});

describe("registerGetAgentPrompt — edit mode empty-modules doc", () => {
	it("falls back to the build prompt body when the loaded doc has no modules", async () => {
		/* Persisted creation always has the canonical starter. This defensive
		 * in-memory empty shape still falls back to build framing. */
		const empty = fixtureEmptyDoc();
		vi.mocked(loadAppBlueprint).mockResolvedValueOnce(loadedFor(empty));

		const { server, capture } = makeFakeServer();
		registerGetAgentPrompt(server, toolCtx);

		const out = (await capture()({ mode: "edit", app_id: "a-empty" }, {})) as {
			content: Array<{ type: "text"; text: string }>;
		};

		const text = out.content[0]?.text ?? "";
		/* Build framing came through and edit framing did not — the
		 * tool preserves the renderer's defensive handling of the
		 * impossible persisted shape. */
		expect(text).toContain("Initial Build");
		expect(text).not.toContain("Editing Mode");
	});
});

describe("registerGetAgentPrompt — renderAgentPrompt throws", () => {
	it("surfaces as an MCP error envelope with a populated error_type", async () => {
		/* Force the renderer to throw to exercise the tool's try/catch +
		 * classifier path. The envelope must carry `isError: true` and a
		 * non-empty `error_type`. */
		vi.mocked(renderAgentPrompt).mockImplementationOnce(() => {
			throw new Error("renderer exploded");
		});

		const { server, capture } = makeFakeServer();
		registerGetAgentPrompt(server, toolCtx);

		const out = (await capture()({ mode: "build" }, {})) as {
			isError?: true;
			content: Array<{ type: "text"; text: string }>;
		};

		expect(out.isError).toBe(true);
		const payload = JSON.parse(out.content[0]?.text ?? "{}") as {
			error_type?: string;
		};
		expect(typeof payload.error_type).toBe("string");
		expect(payload.error_type?.length ?? 0).toBeGreaterThan(0);
	});
});
