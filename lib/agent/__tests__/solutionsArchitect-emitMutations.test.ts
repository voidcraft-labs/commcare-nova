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
 * ## completeBuild
 *
 * The completeBuild tests mock the boundary evaluation + the completion
 * side effects via `vi.mock` so the wrapper reaches each arm (success /
 * findings / infrastructure throw) without plumbing a real CommCare-rule
 * violation or a database through.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc, Field, Form, Module } from "@/lib/domain";
import { asUuid } from "@/lib/domain";
import type { GenerationContext } from "../generationContext";
import {
	createSolutionsArchitect,
	INFRA_FAILURE_SA_INSTRUCTION,
} from "../solutionsArchitect";
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
		case_property_on: "case_name",
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

	it("generateScaffold carries per-form connect through to the addForm mutation", async () => {
		/* `connect` is on the per-form scaffold schema, so an SA
		 * generateScaffold call that supplies it must end up on the
		 * constructed `Form` entity carried by the matching `addForm`
		 * mutation. Without this assertion, a regression that drops
		 * `sf.connect` in `setScaffoldMutations` — the same dead-
		 * schema-field shape that can hit any SA-facing field on the
		 * scaffold form — would slip past silently. */
		const emptyDoc = makeEmptyDoc();
		const sa = createSolutionsArchitect(ctx, emptyDoc, false);

		await runTool(sa, "generateScaffold", {
			app_name: "Vendor Visits",
			description: "Connect deliver app",
			connect_type: "deliver",
			modules: [
				{
					name: "Visits",
					case_type: null,
					case_list_only: false,
					purpose: "Capture vendor visits for payment",
					forms: [
						{
							name: "Vendor visit",
							type: "survey",
							purpose: "Visit form",
							formDesign: "Vendor + photo",
							connect: {
								deliver_unit: { name: "Vendor visit" },
							},
						},
					],
				},
			],
		});

		const events = mutationEvents(writer);
		// Locate the addForm mutation in the scaffold batch (each
		// event carries an array; the scaffold batch contains
		// setAppName, setConnectType, addModule, then addForm).
		const addFormMut = events
			.flatMap((e) => e.mutations)
			.find((m) => m.kind === "addForm") as
			| Extract<Mutation, { kind: "addForm" }>
			| undefined;
		expect(addFormMut).toBeDefined();
		// Source-correctness: the id-less deliver_unit is autofilled from
		// the module name ("Visits" → "visits") before the scaffold
		// mutations are built, so it lands on the doc with a valid id.
		expect(addFormMut?.form.connect?.deliver_unit).toEqual({
			id: "visits",
			name: "Vendor visit",
		});
	});

	it("generateScaffold carries per-form post_submit through to the addForm mutation", async () => {
		/* `post_submit` is on the per-form scaffold schema and must reach
		 * the constructed `Form` entity. Companion to the `connect` test
		 * above — same dead-schema-field shape, same assertion shape.
		 * Locks the construction site against silently dropping any
		 * scalar SA-set form property. */
		const emptyDoc = makeEmptyDoc();
		const sa = createSolutionsArchitect(ctx, emptyDoc, false);

		await runTool(sa, "generateScaffold", {
			app_name: "Visit Tracker",
			description: "Survey-only flow",
			connect_type: "",
			modules: [
				{
					name: "Visits",
					case_type: null,
					case_list_only: false,
					purpose: "Capture vendor visits",
					forms: [
						{
							name: "Vendor visit",
							type: "survey",
							purpose: "Visit form",
							post_submit: "module",
							formDesign: "Vendor + photo",
						},
					],
				},
			],
		});

		const events = mutationEvents(writer);
		const addFormMut = events
			.flatMap((e) => e.mutations)
			.find((m) => m.kind === "addForm") as
			| Extract<Mutation, { kind: "addForm" }>
			| undefined;
		expect(addFormMut).toBeDefined();
		expect(addFormMut?.form.postSubmit).toBe("module");
	});

	it("addCaseListColumns emits data-mutations tagged module:M:caseList:column:add", async () => {
		// Pin the case-list-config write surface emits through the same
		// `data-mutations` path as every other shared tool — case list
		// authoring is the typed-AST replacement for the deleted
		// `addModule` SA tool, so the fixture exercises one structured
		// `Column` mutation at the same staging granularity.
		const sa = createSolutionsArchitect(ctx, makeFixtureDoc(), false);

		await runTool(sa, "addCaseListColumns", {
			moduleIndex: 0,
			columns: [{ kind: "plain", field: "case_name", header: "Name" }],
		});

		const muts = mutationEvents(writer);
		expect(muts).toHaveLength(1);
		expect(muts[0].stage).toBe("module:0:caseList:column:add");
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
					case_property_on: "",
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
			// Atomic creation: a form lands together with its fields.
			fields: [{ kind: "text", id: "visit_notes", label: "Visit notes" }],
		});

		const muts = mutationEvents(writer);
		expect(muts).toHaveLength(1);
		expect(muts[0].stage).toBe("module:0");
		expect(muts[0].mutations.some((m) => m.kind === "addForm")).toBe(true);
		expect(muts[0].mutations.some((m) => m.kind === "addField")).toBe(true);
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

		// Case-list-config write tool — covers the typed-AST surface that
		// replaced the deleted `addModule` SA tool. Walking it here keeps
		// the safety-net's coverage of column-mutation events.
		await runTool(sa, "addCaseListColumns", {
			moduleIndex: 0,
			columns: [{ kind: "plain", field: "case_name", header: "Name" }],
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

		await runTool(sa, "addFields", {
			moduleIndex: 0,
			formIndex: 0,
			fields: [
				{
					id: "dob",
					kind: "date",
					label: "Date of birth",
				},
			],
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

// ── completeBuild — emits data-done ─────────────────────────────────────
//
// `completeBuild` keeps the full-doc `data-done` emission as the final
// reconciliation + celebration handoff. We mock the boundary evaluation
// + the completion side effects so the wrapper reaches each arm against
// a trivial fixture.

vi.mock("@/lib/media/boundaryValidation", () => ({
	collectBoundaryViolations: vi.fn(() => Promise.resolve([])),
}));

vi.mock("@/lib/db/apps", () => ({
	completeAppGuardedByBasis: vi.fn(() => Promise.resolve("token-rotated")),
	loadBlueprintBasis: vi.fn(() => Promise.resolve(null)),
	failApp: vi.fn(),
	updateAppForRun: vi.fn(() => Promise.resolve()),
	/* The stale-basis recovery reloads the stored doc through this; the
	 * bounce test installs a per-call resolved value. */
	loadApp: vi.fn(),
	/* The guarded completion writer throws this on a stale basis; tests
	 * that drive the bounce arm construct it via the real class. */
	BlueprintBasisStaleError: class BlueprintBasisStaleError extends Error {},
}));

/* `completeBuild`'s success arm awaits `materializeCaseStoreSchemas` to
 * close the chat-completion → case-store-schema gap (the SA's chat-
 * side `saveBlueprint` is fire-and-forget by design, so
 * `case_type_schemas` carries no row until this call lands). The test
 * doesn't reach Postgres; mocking the helper to a resolved no-op
 * lets the success arm complete without standing up a per-test
 * database. */
vi.mock("@/lib/db/materializeCaseStoreSchemas", () => ({
	materializeCaseStoreSchemas: vi.fn(() => Promise.resolve()),
}));

describe("solutionsArchitect — completeBuild", () => {
	// Build mode (`editing = false`) throughout: the completion tool is
	// build-only on the chat surface — edit mode has nothing to complete.

	it("is absent from the edit-mode tool set (a complete app has nothing to complete)", () => {
		const { ctx } = buildCtx();
		const sa = createSolutionsArchitect(ctx, makeFixtureDoc(), true);
		expect("completeBuild" in sa.tools).toBe(false);
	});

	it("never demotes an already-complete app, even when finalize throws", async () => {
		// Reachable shape: a build-mode POST against an app whose status is
		// already complete (phase "complete"). A transient Postgres outage
		// during finalize must NOT flip a working app to error — the exact
		// brick the route's own failure path guards against.
		const { materializeCaseStoreSchemas } = await import(
			"@/lib/db/materializeCaseStoreSchemas"
		);
		const { failApp } = await import("@/lib/db/apps");
		vi.mocked(materializeCaseStoreSchemas).mockImplementationOnce(async () => {
			throw new Error("simulated postgres outage");
		});

		const { ctx } = makeTestContext({ commitPhase: "complete" });
		const sa = createSolutionsArchitect(ctx, makeFixtureDoc(), false);
		const result = await runTool(sa, "completeBuild", {});

		expect(result).toMatchObject({ success: false, infrastructure: true });
		expect(vi.mocked(failApp)).not.toHaveBeenCalled();
	});

	it("emits data-done with the final doc on success", async () => {
		const fixtureDoc = makeFixtureDoc();
		const { ctx, writer } = buildCtx();
		const sa = createSolutionsArchitect(ctx, fixtureDoc, false);

		await runTool(sa, "completeBuild", {});

		const doneEvents = writtenEvents(writer).filter(
			(e) => e.type === "data-done",
		);
		expect(doneEvents).toHaveLength(1);
		const payload = doneEvents[0].data as {
			success: boolean;
			basisToken?: string;
		};
		expect(payload.success).toBe(true);
		// The completion write's rotated token rides along so the builder
		// client adopts it as its auto-save basis.
		expect(payload.basisToken).toBe("token-rotated");
		expectNoLegacyEvents(writer);
	});

	it("orders side effects: materialize → completeApp → data-done on success", async () => {
		// The shared tool body runs `materializeCaseStoreSchemas` and the
		// awaited `completeApp` BEFORE the wrapper's `data-done` SSE emit,
		// so the celebration animation never races a user-initiated
		// case-store action. Pin that ordering structurally — a regression
		// to "emit data-done first" would let a "Generate sample data"
		// click sub-second after the celebration trip
		// `SchemaNotSyncedError`.
		const { materializeCaseStoreSchemas } = await import(
			"@/lib/db/materializeCaseStoreSchemas"
		);
		const { completeAppGuardedByBasis, failApp } = await import(
			"@/lib/db/apps"
		);
		const fixtureDoc = makeFixtureDoc();

		// Shared call-order array each spy pushes to as it runs.
		// `data-done` detection rides the writer spy because the
		// SSE emit goes through `writer.write`, not a dedicated
		// helper.
		//
		// Mock bodies stay synchronous: an inner `await` would let
		// the wrapper resolve before the push records, scrambling
		// `order` and breaking the call-order assertion.
		const order: string[] = [];
		vi.mocked(materializeCaseStoreSchemas).mockImplementationOnce(async () => {
			order.push("materialize");
		});
		vi.mocked(completeAppGuardedByBasis).mockImplementationOnce(async () => {
			order.push("completeApp");
			return "token-rotated";
		});

		const { ctx, writer } = buildCtx();
		writer.write.mockImplementation((event: { type?: string }) => {
			if (event?.type === "data-done") order.push("data-done");
		});

		const sa = createSolutionsArchitect(ctx, fixtureDoc, false);
		await runTool(sa, "completeBuild", {});

		expect(order).toEqual(["materialize", "completeApp", "data-done"]);
		// `failApp` stays untouched on the success path — it's the
		// failure-arm sibling of `completeApp`.
		expect(vi.mocked(failApp)).not.toHaveBeenCalled();
	});

	it("a stale completion basis bounces as an ordinary run-again result — never failApp, nothing emitted", async () => {
		// A concurrent edit landed during the evaluation window: the guarded
		// completion write rejects on the basis compare. That is an ordinary
		// outcome the agent re-runs from — the infrastructure arm (emitError
		// + failApp) must NOT fire, and no celebration may go out for a
		// completion that never committed.
		const { completeAppGuardedByBasis, failApp, BlueprintBasisStaleError } =
			await import("@/lib/db/apps");
		const { loadApp } = await import("@/lib/db/apps");
		vi.mocked(completeAppGuardedByBasis).mockImplementationOnce(async () => {
			throw new BlueprintBasisStaleError();
		});
		vi.mocked(loadApp).mockResolvedValueOnce({
			blueprint: makeFixtureDoc(),
		} as never);

		const fixtureDoc = makeFixtureDoc();
		const { ctx, writer } = buildCtx();
		const sa = createSolutionsArchitect(ctx, fixtureDoc, false);
		const result = await runTool(sa, "completeBuild", {});

		expect(result).toMatchObject({ success: false });
		expect(
			(result as { errors: string[] }).errors.some((e) =>
				e.includes("changed while it was being completed"),
			),
		).toBe(true);
		expect("infrastructure" in (result as object)).toBe(false);
		expect(vi.mocked(failApp)).not.toHaveBeenCalled();
		const doneEvents = writtenEvents(writer).filter(
			(e) => e.type === "data-done",
		);
		expect(doneEvents).toHaveLength(0);
	});

	it("the bounce reloads the STORED doc into the working state, so the retry evaluates the concurrent edit", async () => {
		// The erasure hazard the reload exists to kill: the SA's working doc
		// never reconciles with Firestore on its own, so without the reload
		// the advised retry would adopt the rotated token and commit the
		// stale working doc over the very edit the guard caught. Drive the
		// full bounce → retry sequence and assert the SECOND evaluation (and
		// the data-done it produces) runs on the doc the store holds — the
		// one carrying the concurrent edit — not the run's pre-bounce doc.
		const {
			completeAppGuardedByBasis,
			loadApp,
			loadBlueprintBasis,
			BlueprintBasisStaleError,
		} = await import("@/lib/db/apps");
		const { collectBoundaryViolations } = await import(
			"@/lib/media/boundaryValidation"
		);
		vi.mocked(collectBoundaryViolations).mockClear();
		vi.mocked(completeAppGuardedByBasis)
			.mockImplementationOnce(async () => {
				throw new BlueprintBasisStaleError();
			})
			.mockImplementationOnce(async () => "token-rotated-2");
		// The concurrent writer's doc, distinguishable by name.
		const storedDoc = { ...makeFixtureDoc(), appName: "Edited Elsewhere" };
		vi.mocked(loadApp).mockResolvedValueOnce({ blueprint: storedDoc } as never);
		vi.mocked(loadBlueprintBasis)
			.mockResolvedValueOnce("pre-bounce-token")
			.mockResolvedValueOnce("rotated-token");

		const { ctx, writer } = buildCtx();
		const sa = createSolutionsArchitect(ctx, makeFixtureDoc(), false);

		const bounce = await runTool(sa, "completeBuild", {});
		expect(bounce).toMatchObject({ success: false });
		expect(
			(bounce as { errors: string[] }).errors.some((e) =>
				e.includes("reloaded"),
			),
		).toBe(true);

		const retry = await runTool(sa, "completeBuild", {});
		expect(retry).toMatchObject({ success: true });

		// The retry's boundary evaluation ran on the reloaded doc…
		const evaluatedDocs = vi
			.mocked(collectBoundaryViolations)
			.mock.calls.map((c) => (c[0] as { appName: string }).appName);
		expect(evaluatedDocs).toEqual(["Clinic Intake", "Edited Elsewhere"]);
		// …and the celebration snapshot is that same reconciled doc.
		const doneEvents = writtenEvents(writer).filter(
			(e) => e.type === "data-done",
		);
		expect(doneEvents).toHaveLength(1);
		expect(
			(doneEvents[0].data as { doc: { appName: string } }).doc.appName,
		).toBe("Edited Elsewhere");
	});

	it("returns the findings without any side effect when the evaluation refuses", async () => {
		const { collectBoundaryViolations } = await import(
			"@/lib/media/boundaryValidation"
		);
		const { materializeCaseStoreSchemas } = await import(
			"@/lib/db/materializeCaseStoreSchemas"
		);
		const { completeAppGuardedByBasis } = await import("@/lib/db/apps");
		vi.mocked(collectBoundaryViolations).mockResolvedValueOnce([
			{
				code: "EMPTY_FORM",
				scope: "form",
				message: '"Visit" has no fields.',
				location: { formName: "Visit" },
			} as never,
		]);

		const fixtureDoc = makeFixtureDoc();
		const { ctx, writer } = buildCtx();
		const sa = createSolutionsArchitect(ctx, fixtureDoc, false);
		const result = await runTool(sa, "completeBuild", {});

		expect(result).toMatchObject({ success: false });
		expect(
			(result as { errors: string[] }).errors.some((e) =>
				e.includes("has no fields"),
			),
		).toBe(true);
		// Nothing finalizes on a refusal — no materialize, no status flip,
		// no celebration. The agent finishes the work and calls again.
		expect(vi.mocked(materializeCaseStoreSchemas)).not.toHaveBeenCalled();
		expect(vi.mocked(completeAppGuardedByBasis)).not.toHaveBeenCalled();
		const doneEvents = writtenEvents(writer).filter(
			(e) => e.type === "data-done",
		);
		expect(doneEvents).toHaveLength(0);
	});

	it("classifies + fails the app and skips data-done when materialize throws", async () => {
		// A Postgres outage during materialization is unrecoverable
		// from the SA's edit perspective — the wrapper must route
		// the failure through `classifyError` + `ctx.emitError` +
		// `failApp` and return `success: false` so the SA loop
		// doesn't retry into the staleness-reaper window. Letting
		// the throw propagate to a `tool-error` content part would
		// invite the SA to retry `completeBuild`, burning through the
		// 80-step `stopWhen` limit on a Postgres failure that no
		// blueprint mutation can repair.
		const { materializeCaseStoreSchemas } = await import(
			"@/lib/db/materializeCaseStoreSchemas"
		);
		const { completeAppGuardedByBasis, failApp } = await import(
			"@/lib/db/apps"
		);
		const fixtureDoc = makeFixtureDoc();

		const order: string[] = [];
		vi.mocked(materializeCaseStoreSchemas).mockImplementationOnce(async () => {
			order.push("materialize-throws");
			throw new Error("simulated postgres outage");
		});
		vi.mocked(completeAppGuardedByBasis).mockImplementationOnce(async () => {
			order.push("completeApp");
			return "token-rotated";
		});
		vi.mocked(failApp).mockImplementationOnce(() => {
			order.push("failApp");
		});

		const { ctx, writer } = buildCtx();
		// Push to the shared order array on `data-done` events. The
		// failure path SHOULD NOT emit `data-done` — the absence of
		// the entry in `order` is what the assertion below pins.
		writer.write.mockImplementation((event: { type?: string }) => {
			if (event?.type === "data-done") order.push("data-done");
		});

		const sa = createSolutionsArchitect(ctx, fixtureDoc, false);
		const result = await runTool(sa, "completeBuild", {});

		// `completeApp` MUST NOT fire on the failure path — the
		// app stays in its construction status until `failApp` flips it
		// to `error`. `data-done` MUST NOT fire either — the
		// celebration only runs on a clean Postgres handoff.
		expect(order).toEqual(["materialize-throws", "failApp"]);
		expect(vi.mocked(completeAppGuardedByBasis)).not.toHaveBeenCalled();

		// `failApp` was invoked with the SA's appId + the classified
		// error type. Postgres errors don't match any of the typed
		// API arms, so they fall through to `internal` per
		// `lib/agent/errorClassifier.ts`.
		expect(vi.mocked(failApp)).toHaveBeenCalledTimes(1);
		expect(vi.mocked(failApp).mock.calls[0]).toEqual(["test-app", "internal"]);

		// The tool tags the failure `infrastructure: true` so the SA can
		// tell a system outage (the evaluation passed; finalize threw)
		// apart from unfinished work — without the tag the two returns are
		// byte-identical and the SA burns its `stopWhen` budget
		// "finishing" an app that was never unfinished. `errors` carries
		// the SA-facing stop-and-report instruction, NOT the raw
		// `simulated postgres outage` (that user-facing translation went
		// out via `emitError`).
		expect(result).toMatchObject({
			success: false,
			infrastructure: true,
			errors: [INFRA_FAILURE_SA_INSTRUCTION],
		});
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
