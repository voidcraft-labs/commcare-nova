/**
 * Integration tests for the Solutions Architect's mutation-emission surface.
 *
 * The SA is the single write surface for doc mutations on the server —
 * every tool handler that previously emitted a wire-format doc snapshot
 * (`data-schema`, `data-scaffold`, `data-module-done`, `data-form-updated`,
 * `data-form-fixed`, `data-blueprint-updated`) now emits `data-mutations`
 * carrying the fine-grained `Mutation[]` the SA already applied to its
 * internal doc. The client applies the same batch via
 * `docStore.applyMany(mutations)` — no translation, no reconstruction.
 *
 * ## Strategy
 *
 * Rather than stand up a real Anthropic client, we build the SA with a
 * mocked `GenerationContext` (stubbed `UIMessageStreamWriter` + stubbed
 * `EventLogger`) and invoke each tool's `execute` callback directly. The
 * writer's `.write` call log is the test's primary assertion surface:
 *
 *   - every migrated tool emits `data-mutations` with the expected
 *     mutations + stage tag, and
 *   - no migrated tool emits any member of the legacy-event allowlist.
 *
 * The safety-net test at the end walks every tool handler with realistic
 * inputs and asserts that the forbidden-event list is never written on
 * any of them — catching the regression where a subagent misses a
 * migration spot.
 *
 * ## validationLoop
 *
 * The validationLoop test mocks `runValidation`, `FIX_REGISTRY`, and
 * `expandBlueprint` via `vi.mock` so we can synthesize a single fix
 * iteration without plumbing a real CommCare-rule violation through. The
 * shortcut is fine: the live migration of `data-form-fixed` into
 * `ctx.emitMutations(..., "fix:attempt-N")` is a simple call-site change
 * and the safety-net test independently verifies no legacy wire event
 * leaks through.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ValidationError } from "@/lib/commcare/validator/errors";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc, Field, Form, Module } from "@/lib/domain";
import { asUuid } from "@/lib/domain";
import type { GenerationContext } from "../generationContext";
import { createSolutionsArchitect } from "../solutionsArchitect";
import { makeTestContext } from "./fixtures";

// ── Forbidden legacy events ──────────────────────────────────────────────
//
// The migration's contract is that NONE of these event types ever reach
// the live stream. The dispatcher still consumes them for historical log
// replay, so they live on in `lib/generation/streamDispatcher.ts` — but
// the server must never emit them. Every test below asserts this list
// stayed quiet; the final safety-net test exercises the full tool surface
// in one pass.
const FORBIDDEN_LEGACY_EVENTS = [
	"data-schema",
	"data-scaffold",
	"data-module-done",
	"data-form-updated",
	"data-form-fixed",
	"data-blueprint-updated",
] as const;

// ── Uuid helpers ─────────────────────────────────────────────────────────

const MOD_A = asUuid("11111111-1111-1111-1111-111111111111");
const MOD_B = asUuid("22222222-2222-2222-2222-222222222222");
const FORM_A = asUuid("33333333-3333-3333-3333-333333333333");
const FIELD_A = asUuid("44444444-4444-4444-4444-444444444444");

// ── Fixture builders ─────────────────────────────────────────────────────

/**
 * Build a minimal `BlueprintDoc` with one case-carrying module, one
 * registration form, and one leaf text field. Every tool the SA exposes
 * — read, mutation, structural, validation — has something to operate
 * on against this shape, which keeps each `it` block self-contained.
 *
 * The case-type catalog carries a single property so field-mutation
 * handlers that call `applyDefaults` find an entry to merge.
 */
function makeFixtureDoc(): BlueprintDoc {
	const mod: Module = {
		uuid: MOD_A,
		id: "patient",
		name: "Patient",
		caseType: "patient",
	};
	const modB: Module = {
		uuid: MOD_B,
		id: "survey_only",
		name: "Feedback Survey",
	};
	const form: Form = {
		uuid: FORM_A,
		id: "enroll",
		name: "Enroll Patient",
		type: "registration",
	};
	const field: Field = {
		uuid: FIELD_A,
		id: "case_name",
		kind: "text",
		label: "Patient name",
		case_property: "case_name",
	} as Field;

	return {
		appId: "test-app",
		appName: "Clinic Intake",
		connectType: null,
		caseTypes: [
			{
				name: "patient",
				properties: [{ name: "case_name", label: "Full name" }],
			},
		],
		modules: { [MOD_A]: mod, [MOD_B]: modB },
		forms: { [FORM_A]: form },
		fields: { [FIELD_A]: field },
		moduleOrder: [MOD_A, MOD_B],
		formOrder: { [MOD_A]: [FORM_A], [MOD_B]: [] },
		fieldOrder: { [FORM_A]: [FIELD_A] },
		fieldParent: { [FIELD_A]: FORM_A },
	};
}

// ── GenerationContext builder ────────────────────────────────────────────
//
// Thin wrapper around the shared `makeTestContext` fixture. Kept as a
// named function so the test bodies below stay readable — the SA tests
// only care about ctx + writer, so we drop the `logWriter` handle.
function buildCtx() {
	const { ctx, writer } = makeTestContext();
	return { ctx, writer };
}

// ── Writer inspection helpers ────────────────────────────────────────────

type WriterWrite = { type: string; data: unknown; transient?: boolean };

/** Extract every `writer.write` call as a typed event record. */
function writtenEvents(writer: {
	write: ReturnType<typeof vi.fn>;
}): WriterWrite[] {
	return writer.write.mock.calls.map((c: unknown[]) => c[0] as WriterWrite);
}

/** All `data-mutations` events written, with their payloads. */
function mutationEvents(writer: {
	write: ReturnType<typeof vi.fn>;
}): Array<{ mutations: Mutation[]; stage?: string }> {
	return writtenEvents(writer)
		.filter((e) => e.type === "data-mutations")
		.map((e) => e.data as { mutations: Mutation[]; stage?: string });
}

/** Assert no forbidden legacy event was written. Fails with a helpful
 *  diagnostic listing exactly which event snuck through. */
function expectNoLegacyEvents(writer: { write: ReturnType<typeof vi.fn> }) {
	const events = writtenEvents(writer);
	const leaks = events.filter((e) =>
		FORBIDDEN_LEGACY_EVENTS.includes(
			e.type as (typeof FORBIDDEN_LEGACY_EVENTS)[number],
		),
	);
	expect(leaks).toEqual([]);
}

// ── Tool execution helper ────────────────────────────────────────────────
//
// The AI SDK's `Tool.execute` takes `(input, options)`; `options` carries
// `toolCallId`, `messages`, and (optionally) `context`. None of the SA's
// handlers read those, so a bare stub is fine.
const EXEC_OPTS = {
	toolCallId: "test-call",
	messages: [],
};

/** Narrow helper: call a tool's `execute`, ignoring its result value.
 *  The SA's execute implementations are typed loosely for the AI SDK's
 *  generic signature — casting through `any` is the pragmatic way to
 *  invoke them directly from a test harness. */
async function runTool(
	agent: ReturnType<typeof createSolutionsArchitect>,
	name: string,
	input: Record<string, unknown>,
): Promise<unknown> {
	// Agent.tools is a generic ToolSet — access by string key for this
	// test surface. Each tool's `execute` is either present (server tool)
	// or absent (client-only tools like `askQuestions`, which this helper
	// is never called with).
	// biome-ignore lint/suspicious/noExplicitAny: SA tool set is heterogeneous; test harness invokes execute directly.
	const tool = (agent.tools as Record<string, any>)[name];
	if (!tool || typeof tool.execute !== "function") {
		throw new Error(`Tool "${name}" has no execute handler in this mode`);
	}
	return await tool.execute(input, EXEC_OPTS);
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("solutionsArchitect — emitMutations migration", () => {
	let ctx: GenerationContext;
	let writer: { write: ReturnType<typeof vi.fn> };

	beforeEach(() => {
		const built = buildCtx();
		ctx = built.ctx;
		writer = built.writer;
	});

	it("generateSchema emits data-mutations with setAppName + setCaseTypes mutations", async () => {
		// Start from an empty doc so `setCaseTypes` has no prior catalog to
		// collapse against — the emission should show both the app-name
		// change and the catalog change in one `data-mutations` batch,
		// tagged with the "schema" stage.
		const emptyDoc: BlueprintDoc = {
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
		const sa = createSolutionsArchitect(ctx, emptyDoc, false);

		await runTool(sa, "generateSchema", {
			appName: "Trial Intake",
			caseTypes: [
				{ name: "patient", properties: [{ name: "case_name", label: "Name" }] },
			],
		});

		const muts = mutationEvents(writer);
		expect(muts).toHaveLength(1);
		expect(muts[0].stage).toBe("schema");
		expect(muts[0].mutations.map((m) => m.kind)).toEqual([
			"setAppName",
			"setCaseTypes",
		]);
		expectNoLegacyEvents(writer);
	});

	it("generateScaffold emits data-mutations and not data-scaffold", async () => {
		// Scaffold tool only runs in build mode; start from empty doc.
		const emptyDoc = makeEmptyDoc();
		const sa = createSolutionsArchitect(ctx, emptyDoc, false);

		await runTool(sa, "generateScaffold", {
			app_name: "Trial Intake",
			description: "Clinical trial enrollment",
			connect_type: "",
			modules: [
				{
					name: "Patients",
					case_type: "patient",
					case_list_only: false,
					purpose: "Track patient enrollment",
					forms: [
						{
							name: "Enroll",
							type: "registration",
							purpose: "Capture new patient",
							formDesign: "Name + DOB",
						},
					],
				},
			],
		});

		const muts = mutationEvents(writer);
		expect(muts.length).toBeGreaterThan(0);
		expect(muts[0].stage).toBe("scaffold");
		expectNoLegacyEvents(writer);
	});

	it("addModule emits data-mutations with module-scoped stage; survey-only module is silent", async () => {
		// Fixture's MOD_A has caseType "patient" and accepts column writes;
		// MOD_B is survey-only (no caseType) and should emit nothing.
		const sa = createSolutionsArchitect(ctx, makeFixtureDoc(), false);

		await runTool(sa, "addModule", {
			moduleIndex: 0,
			case_list_columns: [{ field: "case_name", header: "Name" }],
			case_detail_columns: null,
		});

		let muts = mutationEvents(writer);
		expect(muts).toHaveLength(1);
		expect(muts[0].stage).toBe("module:0");
		expectNoLegacyEvents(writer);

		// Survey module: no caseType → the handler returns silently.
		writer.write.mockClear();
		await runTool(sa, "addModule", {
			moduleIndex: 1,
			case_list_columns: null,
			case_detail_columns: null,
		});
		muts = mutationEvents(writer);
		expect(muts).toHaveLength(0);
		expectNoLegacyEvents(writer);
	});

	it("addFields emits a single data-mutations batch (not data-form-updated)", async () => {
		const sa = createSolutionsArchitect(ctx, makeFixtureDoc(), true);

		await runTool(sa, "addFields", {
			moduleIndex: 0,
			formIndex: 0,
			fields: [
				{
					id: "dob",
					kind: "date",
					parentId: "",
					label: "Date of birth",
					required: "",
					hint: "",
					validate: "",
					validate_msg: "",
					relevant: "",
					calculate: "",
					default_value: "",
					options: [],
					case_property: "",
				},
			],
		});

		const muts = mutationEvents(writer);
		// Exactly one data-mutations emission for the batch. `data-phase`
		// also fires ahead of it — filter through `mutationEvents` already.
		expect(muts).toHaveLength(1);
		expect(muts[0].stage).toBe("form:0-0");
		expect(muts[0].mutations.every((m) => m.kind === "addField")).toBe(true);
		expectNoLegacyEvents(writer);
	});

	it("editField with id rename emits rename + update as two separate data-mutations batches", async () => {
		const sa = createSolutionsArchitect(ctx, makeFixtureDoc(), true);

		await runTool(sa, "editField", {
			moduleIndex: 0,
			formIndex: 0,
			fieldId: "case_name",
			updates: {
				id: "full_name", // triggers the rename batch
				label: "Full patient name", // triggers the second batch
			},
		});

		const muts = mutationEvents(writer);
		// Two distinct emissions: one for the rename cascade, one for the
		// remaining property patch. Each carries its own stage tag.
		expect(muts).toHaveLength(2);
		expect(muts[0].stage).toBe("rename:0-0");
		expect(muts[0].mutations.some((m) => m.kind === "renameField")).toBe(true);
		expect(muts[1].stage).toBe("edit:0-0");
		expect(muts[1].mutations.every((m) => m.kind === "updateField")).toBe(true);
		expectNoLegacyEvents(writer);
	});

	it("updateModule emits data-mutations (not data-blueprint-updated)", async () => {
		const sa = createSolutionsArchitect(ctx, makeFixtureDoc(), true);

		await runTool(sa, "updateModule", {
			moduleIndex: 0,
			name: "Patients Renamed",
		});

		const muts = mutationEvents(writer);
		expect(muts).toHaveLength(1);
		expect(muts[0].stage).toBe("module:0");
		expectNoLegacyEvents(writer);
	});

	it("createForm emits data-mutations (not data-blueprint-updated)", async () => {
		const sa = createSolutionsArchitect(ctx, makeFixtureDoc(), true);

		await runTool(sa, "createForm", {
			moduleIndex: 0,
			name: "Follow-up Visit",
			type: "followup",
		});

		const muts = mutationEvents(writer);
		expect(muts).toHaveLength(1);
		expect(muts[0].stage).toBe("module:0");
		expect(muts[0].mutations.some((m) => m.kind === "addForm")).toBe(true);
		expectNoLegacyEvents(writer);
	});

	it("removeModule emits data-mutations (not data-blueprint-updated)", async () => {
		const sa = createSolutionsArchitect(ctx, makeFixtureDoc(), true);

		await runTool(sa, "removeModule", { moduleIndex: 1 });

		const muts = mutationEvents(writer);
		expect(muts).toHaveLength(1);
		expect(muts[0].stage).toBe("module:remove:1");
		expect(muts[0].mutations.some((m) => m.kind === "removeModule")).toBe(true);
		expectNoLegacyEvents(writer);
	});

	it("SAFETY NET: walks every migrated tool and asserts no legacy wire event ever writes", async () => {
		// This is the guardrail test — calls every handler against a common
		// fixture and then checks `writer.write` never saw any forbidden
		// event across the whole sweep. If a future change re-introduces
		// a legacy emission, this test fails regardless of which tool it
		// sneaked into.
		const sa = createSolutionsArchitect(ctx, makeFixtureDoc(), false);

		// Generation tools (build mode only).
		await runTool(sa, "generateSchema", {
			appName: "App",
			caseTypes: [
				{ name: "patient", properties: [{ name: "case_name", label: "Name" }] },
			],
		});
		await runTool(sa, "addModule", {
			moduleIndex: 0,
			case_list_columns: [{ field: "case_name", header: "Name" }],
			case_detail_columns: null,
		});

		// Shared tools: read + mutation + structural.
		await runTool(sa, "searchBlueprint", { query: "patient" });
		await runTool(sa, "getModule", { moduleIndex: 0 });
		await runTool(sa, "getForm", { moduleIndex: 0, formIndex: 0 });
		await runTool(sa, "getField", {
			moduleIndex: 0,
			formIndex: 0,
			fieldId: "case_name",
		});

		await runTool(sa, "addField", {
			moduleIndex: 0,
			formIndex: 0,
			field: {
				id: "dob",
				kind: "date",
				label: "Date of birth",
			},
		});
		await runTool(sa, "editField", {
			moduleIndex: 0,
			formIndex: 0,
			fieldId: "case_name",
			updates: { label: "New label" },
		});
		await runTool(sa, "removeField", {
			moduleIndex: 0,
			formIndex: 0,
			fieldId: "dob",
		});
		await runTool(sa, "updateModule", {
			moduleIndex: 0,
			name: "Patients 2",
		});
		await runTool(sa, "updateForm", {
			moduleIndex: 0,
			formIndex: 0,
			name: "Enroll Patient 2",
		});
		await runTool(sa, "createForm", {
			moduleIndex: 0,
			name: "Follow-up",
			type: "followup",
		});
		await runTool(sa, "removeForm", { moduleIndex: 0, formIndex: 1 });
		await runTool(sa, "createModule", { name: "New Module" });
		await runTool(sa, "removeModule", { moduleIndex: 2 });

		// The guardrail: no tool handler wrote a forbidden event.
		expectNoLegacyEvents(writer);

		// And at least some tools emitted data-mutations — otherwise the
		// test is useless as a regression gate.
		const muts = mutationEvents(writer);
		expect(muts.length).toBeGreaterThan(5);
	});
});

// ── validateApp — still emits data-done ─────────────────────────────────
//
// `validateApp` keeps its full-doc `data-done` emission as the final
// reconciliation handoff (validation autofixes can produce opaque deltas,
// and a final snapshot is simpler than threading a per-fix mutation trail
// through the fix registry). We mock the validation + expansion modules
// so the tool reaches the success branch against a trivial fixture.

vi.mock("../validationLoop", async () => {
	const mod =
		await vi.importActual<typeof import("../validationLoop")>(
			"../validationLoop",
		);
	return {
		...mod,
		validateAndFix: vi.fn(),
	};
});

vi.mock("@/lib/db/apps", () => ({
	completeApp: vi.fn(() => Promise.resolve()),
	updateApp: vi.fn(() => Promise.resolve()),
}));

describe("solutionsArchitect — validateApp", () => {
	it("emits data-done with the final doc on success", async () => {
		const { validateAndFix } = await import("../validationLoop");
		const fixtureDoc = makeFixtureDoc();
		vi.mocked(validateAndFix).mockResolvedValue({
			success: true,
			doc: fixtureDoc,
			hqJson: {} as never,
		});

		const { ctx, writer } = buildCtx();
		const sa = createSolutionsArchitect(ctx, fixtureDoc, true);

		await runTool(sa, "validateApp", {});

		const doneEvents = writtenEvents(writer).filter(
			(e) => e.type === "data-done",
		);
		expect(doneEvents).toHaveLength(1);
		const payload = doneEvents[0].data as { success: boolean };
		expect(payload.success).toBe(true);
		expectNoLegacyEvents(writer);
	});
});

// ── validationLoop fix pass — emits data-mutations, not data-form-fixed ──
//
// Shortcut (per Task 17d plan): we stub `runValidation`, `FIX_REGISTRY`,
// and `expandDoc` at the module level so the loop walks exactly
// one fix iteration. Building a real error that a real fix repairs
// would require plumbing the field-registry rule + fix pair, which is
// far more invasive than the call-site change being tested.

vi.mock("@/lib/commcare/validator/runner", () => ({
	runValidation: vi.fn(),
}));

vi.mock("@/lib/commcare/validator/fixes", () => ({
	FIX_REGISTRY: new Map<string, (...args: unknown[]) => Mutation[]>(),
}));

vi.mock("@/lib/commcare/expander", () => ({
	expandDoc: vi.fn(() => ({
		modules: [],
		_attachments: {},
	})),
}));

vi.mock("@/lib/commcare/validator/xformValidator", () => ({
	validateXFormXml: vi.fn(() => []),
}));

describe("validationLoop — fix pass emission", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("emits a single data-mutations batch per fix attempt with stage fix:attempt-N", async () => {
		const runnerMod = await import("@/lib/commcare/validator/runner");
		const fixesMod = await import("@/lib/commcare/validator/fixes");
		// Load the real validationLoop. `importActual` bypasses the
		// file-level mock regardless of cache state — the top-of-file
		// `vi.mock("../validationLoop", ...)` only affects imports
		// resolved through the normal path (which this test doesn't use).
		const { validateAndFix } =
			await vi.importActual<typeof import("../validationLoop")>(
				"../validationLoop",
			);

		// First validation pass returns an error; second returns none so
		// the loop terminates after exactly one fix iteration. The error
		// shape is cast to `ValidationError[]` — we use a real code for
		// typing purposes, but the registry mock picks it up by key so the
		// code value itself only matters as a map lookup key.
		const TEST_CODE = "EMPTY_APP_NAME";
		const firstErrors = [
			{
				code: TEST_CODE,
				scope: "form" as const,
				message: "test",
				location: { formUuid: FORM_A, formName: "Enroll Patient" },
			},
		] as ValidationError[];
		const runValidationFn = vi.mocked(runnerMod.runValidation);
		runValidationFn.mockReturnValueOnce(firstErrors).mockReturnValue([]);

		// Single fix that returns a single setAppName mutation — keeps the
		// assertion simple while still exercising the emission path.
		const fixMutations: Mutation[] = [{ kind: "setAppName", name: "Fixed" }];
		(fixesMod.FIX_REGISTRY as Map<string, unknown>).set(
			TEST_CODE,
			() => fixMutations,
		);

		const { ctx, writer } = buildCtx();
		await validateAndFix(ctx, makeFixtureDoc());

		// Lock in that the loop actually iterated — first pass saw errors,
		// second pass saw none and returned success. Without this assertion,
		// a mock-setup regression that returns `[]` on the first call would
		// silently trivialize both the length + legacy-event checks below.
		expect(runValidationFn).toHaveBeenCalledTimes(2);

		const muts = mutationEvents(writer);
		expect(muts).toHaveLength(1);
		expect(muts[0].stage).toBe("fix:attempt-1");
		expect(muts[0].mutations).toEqual(fixMutations);
		expectNoLegacyEvents(writer);
	});
});

// ── Small helpers kept at the bottom to avoid pollution ─────────────────

function makeEmptyDoc(): BlueprintDoc {
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
