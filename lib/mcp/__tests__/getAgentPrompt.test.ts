/**
 * `registerGetAgentPrompt` unit tests.
 *
 * Verifies the load-bearing behaviors of the dynamic-agent bootstrap
 * tool:
 *   - Happy-path rendering for each of the four `(mode, interactive)`
 *     combinations. Every combo parses the JSON-stringified text payload
 *     back to `{ frontmatter, system_prompt }` and spot-checks a
 *     combo-specific marker to prove the handler actually threads its
 *     two arguments through to `renderAgentPrompt` — a signature
 *     regression that ignored one of them would surface here.
 *   - `_meta.run_id` threads through from `extra._meta.run_id` when the
 *     MCP client supplies one, so admin surfaces can group the bootstrap
 *     call with the sibling tool calls the plugin skill makes under the
 *     same id.
 *   - `_meta.run_id` is minted (uuid v4 shape) when the client doesn't
 *     supply one — the per-call grouping invariant has to hold on every
 *     standalone invocation too.
 *   - Error envelope parity: a thrown `renderAgentPrompt` surfaces as an
 *     MCP `isError: true` envelope classified through the shared
 *     taxonomy, with `run_id` stamped on `_meta` so the error row joins
 *     the same admin grouping as the call's success siblings.
 *
 * The MCP SDK is mocked at the boundary through the shared
 * `makeFakeServer` helper that captures the handler callback. The
 * prompts renderer itself is only mocked for the error-path test — the
 * happy-path tests exercise the real renderer to catch integration
 * drift between this tool and `lib/mcp/prompts.ts`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderAgentPrompt } from "../prompts";
import { registerGetAgentPrompt } from "../tools/getAgentPrompt";
import type { ToolContext } from "../types";
import { makeFakeServer } from "./fakeServer";

/* Hoisted mock — registered up front so the error-path test can flip
 * `renderAgentPrompt` to throw without touching the import, and so the
 * happy-path tests can assert the handler actually forwarded both args
 * via `toHaveBeenCalledWith`. The `importOriginal` pattern preserves
 * the real renderer as the default implementation for every other test
 * (happy paths + run-id threading) by wrapping the real export in a
 * spy. The type-only `PromptMode` export survives the mock untouched
 * because type-only imports don't hit the module graph. */
vi.mock("../prompts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../prompts")>();
	return {
		...actual,
		renderAgentPrompt: vi.fn(actual.renderAgentPrompt),
	};
});

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

beforeEach(() => {
	/* Clear the spy's call log between tests without wiping the
	 * delegate the factory installed. `mockClear` resets `.mock.calls`
	 * + `.mock.results` but leaves `.getMockImplementation()` alone, so
	 * the real-renderer delegate set up in the factory stays in place
	 * for every happy-path test. The error-path test uses
	 * `mockImplementationOnce` (one-shot override) so it doesn't need a
	 * manual reset afterwards. */
	vi.mocked(renderAgentPrompt).mockClear();
});

/* --- Tests ----------------------------------------------------------- */

describe("registerGetAgentPrompt — happy path per combo", () => {
	/* Four combos × one spot-check apiece. The spot-check per combo is
	 * chosen to prove the handler actually threaded that combo's two
	 * args to `renderAgentPrompt` — a signature regression that ignored
	 * `mode` (or `interactive`) would surface as a contradictory assertion
	 * on at least one row. */
	const combos = [
		{
			mode: "build" as const,
			interactive: true,
			spotCheck: (payload: {
				frontmatter: { tools?: string[]; disallowedTools?: string[] };
			}) => {
				/* Build mode exposes the generators; interactive adds
				 * AskUserQuestion to `tools` and omits `disallowedTools`. */
				expect(payload.frontmatter.tools).toContain("mcp__nova__create_app");
				expect(payload.frontmatter.tools).toContain("AskUserQuestion");
				expect(payload.frontmatter.disallowedTools).toBeUndefined();
			},
		},
		{
			mode: "build" as const,
			interactive: false,
			spotCheck: (payload: {
				frontmatter: { tools?: string[]; disallowedTools?: string[] };
			}) => {
				/* Autonomous mode strips AskUserQuestion from `tools` AND
				 * lists it in `disallowedTools` so Claude Code physically
				 * blocks the call. Also still exposes the generators. */
				expect(payload.frontmatter.tools).toContain("mcp__nova__create_app");
				expect(payload.frontmatter.tools).not.toContain("AskUserQuestion");
				expect(payload.frontmatter.disallowedTools).toContain(
					"AskUserQuestion",
				);
			},
		},
		{
			mode: "edit" as const,
			interactive: true,
			spotCheck: (payload: {
				frontmatter: { tools?: string[] };
				system_prompt: string;
			}) => {
				/* Edit mode strips the four generators and the system
				 * prompt carries the `## Edit Mode` header + the
				 * `call nova.get_app` directive. */
				expect(payload.frontmatter.tools).not.toContain(
					"mcp__nova__create_app",
				);
				expect(payload.frontmatter.tools).not.toContain(
					"mcp__nova__generate_schema",
				);
				expect(payload.system_prompt).toContain("## Edit Mode");
				expect(payload.system_prompt).toContain("call `nova.get_app`");
			},
		},
		{
			mode: "edit" as const,
			interactive: false,
			spotCheck: (payload: {
				frontmatter: { disallowedTools?: string[] };
				system_prompt: string;
			}) => {
				/* Edit + autonomous: still carries the Edit Mode header
				 * AND the autonomous disallow-list gate. */
				expect(payload.system_prompt).toContain("## Edit Mode");
				expect(payload.frontmatter.disallowedTools).toContain(
					"AskUserQuestion",
				);
			},
		},
	];

	for (const combo of combos) {
		it(`mode=${combo.mode} interactive=${combo.interactive} returns a well-formed payload`, async () => {
			const { server, capture } = makeFakeServer();
			registerGetAgentPrompt(server, toolCtx);

			const out = (await capture()(
				{ mode: combo.mode, interactive: combo.interactive },
				{},
			)) as {
				content: Array<{ type: "text"; text: string }>;
				_meta: { run_id: string };
			};

			/* Payload is JSON-stringified in a `text` content block — the
			 * skill `JSON.parse`s it on the client side, we mirror that
			 * here so the assertion matches the real consumer shape. */
			const parsed = JSON.parse(out.content[0]?.text ?? "{}") as {
				frontmatter: {
					name: string;
					tools?: string[];
					disallowedTools?: string[];
				};
				system_prompt: string;
			};

			/* Invariants that hold for every combo. */
			expect(parsed.frontmatter.name).toBe("nova-architect");
			expect(typeof parsed.system_prompt).toBe("string");
			expect(parsed.system_prompt.length).toBeGreaterThan(0);

			/* Combo-specific spot check — proves both args actually
			 * reached the renderer. */
			combo.spotCheck(parsed);

			/* Minted run id on every success when the client doesn't
			 * thread one. */
			expect(out._meta.run_id).toMatch(UUID_RE);

			/* Confirm the handler actually forwarded both args to the
			 * renderer — guards a signature regression that might
			 * silently default one of them. */
			expect(renderAgentPrompt).toHaveBeenCalledWith(
				combo.mode,
				combo.interactive,
			);
		});
	}
});

describe("registerGetAgentPrompt — run_id threading", () => {
	it("threads a client-supplied run_id from extra._meta.run_id onto the success envelope", async () => {
		const { server, capture } = makeFakeServer();
		registerGetAgentPrompt(server, toolCtx);

		const out = (await capture()(
			{ mode: "build", interactive: true },
			{ _meta: { run_id: "client-rid-42" } },
		)) as { _meta: { run_id: string } };

		/* Plugin skills bundle the bootstrap call together with the
		 * subsequent `create_app`, `generate_schema`, etc. under one
		 * run id so admin surfaces can group them. Honoring
		 * `_meta.run_id` preserves that grouping. */
		expect(out._meta.run_id).toBe("client-rid-42");
	});

	it("mints a uuid v4 run_id when the client doesn't supply one", async () => {
		const { server, capture } = makeFakeServer();
		registerGetAgentPrompt(server, toolCtx);

		const out = (await capture()({ mode: "edit", interactive: false }, {})) as {
			_meta: { run_id: string };
		};

		expect(out._meta.run_id).toMatch(UUID_RE);
	});
});

describe("registerGetAgentPrompt — renderAgentPrompt throws", () => {
	it("surfaces as an MCP error envelope with a populated error_type and the resolved run_id", async () => {
		/* Force the renderer to throw to exercise the tool's try/catch +
		 * classifier path. Even though the real renderer is pure today,
		 * the tool's envelope contract has to hold if a future change
		 * ever adds an I/O step (e.g. fetching a prompt fragment from
		 * Firestore). The envelope must carry `isError: true`, a
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
