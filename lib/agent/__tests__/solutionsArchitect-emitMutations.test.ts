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
 * ## Planning tools
 *
 * `generateSchema` and `planAppDesign` are pure planning steps — the
 * tests pin that neither writes a mutation event (their plans live in
 * the conversation, not on the doc).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
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

	it("generateSchema is a pure plan — a structured echo, zero mutations on the wire", async () => {
		const sa = createSolutionsArchitect(ctx, makeEmptyDoc(), false);

		const result = await runTool(sa, "generateSchema", {
			appName: "Trial Intake",
			caseTypes: [
				{ name: "patient", properties: [{ name: "case_name", label: "Name" }] },
				{
					name: "visit",
					parent_type: "patient",
					properties: [{ name: "case_name", label: "Visit" }],
				},
			],
		});

		expect(result).toMatchObject({
			planned: true,
			appName: "Trial Intake",
			caseTypes: [
				{ name: "patient", properties: ["case_name"] },
				{ name: "visit", parent_type: "patient", properties: ["case_name"] },
			],
		});
		expect(mutationEvents(writer)).toHaveLength(0);
		expectNoLegacyEvents(writer);
	});

	it("planAppDesign is a pure plan — a structured index, zero mutations on the wire", async () => {
		const sa = createSolutionsArchitect(ctx, makeEmptyDoc(), false);

		const result = await runTool(sa, "planAppDesign", {
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

		expect(result).toMatchObject({
			planned: true,
			appName: "Vendor Visits",
			connectType: "deliver",
			modules: [
				{
					index: 0,
					name: "Visits",
					forms: [
						{
							index: 0,
							name: "Vendor visit",
							type: "survey",
							connectKinds: ["deliver_unit"],
						},
					],
				},
			],
		});
		expect(mutationEvents(writer)).toHaveLength(0);
		expectNoLegacyEvents(writer);
	});

	it("updateApp emits one data-mutations batch carrying setAppName + setConnectType", async () => {
		const sa = createSolutionsArchitect(ctx, makeEmptyDoc(), false);

		await runTool(sa, "updateApp", {
			name: "Vendor Visits",
			connect_type: "deliver",
		});

		const muts = mutationEvents(writer);
		expect(muts).toHaveLength(1);
		expect(muts[0].stage).toBe("app");
		expect(muts[0].mutations.map((m) => m.kind)).toEqual([
			"setAppName",
			"setConnectType",
		]);
		expectNoLegacyEvents(writer);
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
		/* Rename a non-case_name field: renaming the registration form's
		 * case_name writer away would introduce NO_CASE_NAME_FIELD and the
		 * gate would rightly reject the whole edit. */
		const VILLAGE = asUuid("55555555-5555-5555-5555-555555555555");
		const doc = makeFixtureDoc();
		doc.fields[VILLAGE] = {
			uuid: VILLAGE,
			id: "village",
			kind: "text",
			label: "Village",
		} as Field;
		doc.fieldOrder[FORM_A] = [...doc.fieldOrder[FORM_A], VILLAGE];
		doc.fieldParent[VILLAGE] = FORM_A;
		const sa = createSolutionsArchitect(ctx, doc, true);

		await runTool(sa, "editField", {
			moduleIndex: 0,
			formIndex: 0,
			fieldId: "village",
			updates: {
				id: "hamlet", // triggers the rename batch
				label: "Hamlet", // triggers the second batch
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

		// Planning tools (build mode only) — pure, but walked so a future
		// regression that makes them emit shows up here.
		await runTool(sa, "generateSchema", {
			appName: "App",
			caseTypes: [
				{ name: "patient", properties: [{ name: "case_name", label: "Name" }] },
			],
		});
		await runTool(sa, "planAppDesign", {
			app_name: "App",
			description: "Safety-net walk",
			connect_type: "",
			modules: [],
		});
		await runTool(sa, "updateApp", { name: "App" });

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

// ── No finishing tool ────────────────────────────────────────────────────
//
// Completion moved to the chat route's drain-end finalize — the SA's tool
// set carries no completeBuild on either mode, and no tool emits
// `data-done` (that signal is the route's).

/* `emitMutations` fires a fire-and-forget `updateAppForRun` on every
 * mutating tool call; stub the apps module so no save reaches Firestore. */
vi.mock("@/lib/db/apps", () => ({
	updateAppForRun: vi.fn(() => Promise.resolve()),
}));

describe("solutionsArchitect — no finishing tool", () => {
	it("completeBuild is absent from both tool sets", () => {
		const { ctx } = buildCtx();
		const buildSa = createSolutionsArchitect(ctx, makeEmptyDoc(), false);
		const editSa = createSolutionsArchitect(ctx, makeFixtureDoc(), true);
		expect("completeBuild" in buildSa.tools).toBe(false);
		expect("completeBuild" in editSa.tools).toBe(false);
	});

	it("planning tools are build-only; updateApp is shared", () => {
		const { ctx } = buildCtx();
		const buildSa = createSolutionsArchitect(ctx, makeEmptyDoc(), false);
		const editSa = createSolutionsArchitect(ctx, makeFixtureDoc(), true);
		expect("generateSchema" in buildSa.tools).toBe(true);
		expect("planAppDesign" in buildSa.tools).toBe(true);
		expect("generateSchema" in editSa.tools).toBe(false);
		expect("planAppDesign" in editSa.tools).toBe(false);
		expect("updateApp" in buildSa.tools).toBe(true);
		expect("updateApp" in editSa.tools).toBe(true);
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
