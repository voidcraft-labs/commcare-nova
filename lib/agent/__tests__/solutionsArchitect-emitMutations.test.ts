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
 * Rather than stand up a real model client, we build the SA with a
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
 * ## Data-model tool
 *
 * `generateSchema` commits the design's skeleton — one gated batch
 * carrying `setAppName` + the case-type catalog — a test pins the batch
 * shape and its `schema` stage tag.
 */

import { produce } from "immer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	AppProjectChangedError,
	BlueprintCommitRejectedError,
	CommitReauthError,
} from "@/lib/db/commitGuard";
import { applyMutations } from "@/lib/doc/mutations";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc, Field, Form, Module } from "@/lib/domain";
import { asUuid } from "@/lib/domain";
import type { GenerationContext } from "../generationContext";
import { createSolutionsArchitect } from "../solutionsArchitect";
import { makeTestContext } from "./fixtures";

/* The SA commits every batch through `commitGuardedBatch` (kind:'chat') —
 * except rename-carrying batches, which detour through the cross-store saga
 * (`applyBlueprintChange`). Mock both to re-apply the batch onto ONE TRACKED
 * server doc so the SA's working doc advances across tool calls exactly as it
 * would against the real writers, and expose `loadApp` for `wrapMutating`'s
 * conflict-reload path. `seedServerDoc` seeds the tracked doc to the SA's
 * initial doc per test. */
const {
	commitGuardedBatchMock,
	applyBlueprintChangeMock,
	loadAppMock,
	seedServerDoc,
} = vi.hoisted(() => {
	let serverDoc: unknown = null;
	let seq = 0;
	const applyBatch = (mutations: unknown[]) => {
		// biome-ignore lint/suspicious/noExplicitAny: test re-applies onto the tracked doc.
		serverDoc = produce(serverDoc as any, (draft: any) => {
			// biome-ignore lint/suspicious/noExplicitAny: mutation union threaded verbatim.
			applyMutations(draft, mutations as any);
		});
		seq += 1;
		return { seq, committedDoc: serverDoc };
	};
	return {
		seedServerDoc: (doc: unknown) => {
			serverDoc = doc;
			seq = 0;
		},
		loadAppMock: vi.fn(),
		commitGuardedBatchMock: vi.fn(async (args: { mutations: unknown[] }) => {
			return { ...applyBatch(args.mutations), deduped: false };
		}),
		applyBlueprintChangeMock: vi.fn(
			async (args: { guard?: { mutations: unknown[] } }) => {
				return applyBatch(args.guard?.mutations ?? []);
			},
		),
	};
});

/** Seed the tracked server doc + build the SA against it. Every test uses this
 *  instead of `createSolutionsArchitect` directly so the guarded-writer mock
 *  starts from the SA's own initial doc. */
function makeSa(
	ctx: GenerationContext,
	doc: BlueprintDoc,
	appReady: boolean,
): ReturnType<typeof createSolutionsArchitect> {
	seedServerDoc(doc);
	return createSolutionsArchitect(ctx, doc, appReady);
}

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

	it("generateSchema commits the catalog in ONE gated batch, stage schema — and never touches the name", async () => {
		const sa = makeSa(ctx, makeEmptyDoc(), false);

		const result = await runTool(sa, "generateSchema", {
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
			message: expect.stringContaining("patient, visit"),
		});
		const muts = mutationEvents(writer);
		expect(muts).toHaveLength(1);
		expect(muts[0].stage).toBe("schema");
		// No setAppName arm exists on this tool — naming lives on updateApp
		// alone, so a schema commit can never rename the app as a side effect.
		expect(muts[0].mutations.map((m) => m.kind)).toEqual([
			"declareCaseType",
			"addCaseProperty",
			"declareCaseType",
			"setCaseTypeMeta",
			"addCaseProperty",
		]);
		expectNoLegacyEvents(writer);
	});

	it("generateSchema rejects a case type whose record is already authored", async () => {
		// The fixture's "patient" record carries an authored property (label
		// "Full name" ≠ its name) — re-declaring would replace definitions
		// fields were seeded from, so the whole call is rejected.
		const sa = makeSa(ctx, makeFixtureDoc(), false);

		const result = await runTool(sa, "generateSchema", {
			caseTypes: [
				{ name: "patient", properties: [{ name: "case_name", label: "Name" }] },
			],
		});

		expect(result).toMatchObject({
			error: expect.stringContaining('"patient"'),
		});
		expect(mutationEvents(writer)).toHaveLength(0);
	});

	it("generateSchema rejects duplicate case-type names within one call", async () => {
		// Two same-named entries would silently merge into a chimera record
		// (declare no-ops, properties first-wins, later parent link overwrites)
		// — reject before any mutation is built.
		const sa = makeSa(ctx, makeEmptyDoc(), false);

		const result = await runTool(sa, "generateSchema", {
			caseTypes: [
				{ name: "patient", properties: [{ name: "case_name", label: "Name" }] },
				{
					name: "patient",
					parent_type: "household",
					properties: [{ name: "age", label: "Age" }],
				},
			],
		});

		expect(result).toMatchObject({
			error: expect.stringContaining("more than once"),
		});
		expect(mutationEvents(writer)).toHaveLength(0);
	});

	it("generateSchema enriches a bare chokepoint-declared record via setCaseProperty", async () => {
		// A module flip / field write declares a type bare ({name, label: name}
		// properties only). generateSchema is the only tool that authors
		// property records, so it must be able to fill that record in —
		// setCaseProperty replaces the bare auto-registered property and
		// appends the new one (addCaseProperty would first-wins no-op).
		const doc = makeFixtureDoc();
		doc.caseTypes = [
			{
				name: "visit",
				properties: [
					{ name: "visit_date", label: "visit_date", data_type: "date" },
				],
			},
		];
		const sa = makeSa(ctx, doc, false);

		const result = await runTool(sa, "generateSchema", {
			caseTypes: [
				{
					name: "visit",
					parent_type: "patient",
					properties: [
						{ name: "visit_date", label: "Visit date", data_type: "date" },
						{ name: "outcome", label: "Outcome" },
					],
				},
			],
		});

		expect(result).toMatchObject({
			message: expect.stringContaining("bare declaration"),
		});
		const muts = mutationEvents(writer);
		expect(muts).toHaveLength(1);
		expect(muts[0].mutations.map((m) => m.kind)).toEqual([
			"declareCaseType",
			"setCaseTypeMeta",
			"setCaseProperty",
			"setCaseProperty",
		]);
	});

	it("updateApp emits one data-mutations batch carrying setAppName + setConnectType", async () => {
		const sa = makeSa(ctx, makeEmptyDoc(), false);

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
		const sa = makeSa(ctx, makeFixtureDoc(), false);

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
		const sa = makeSa(ctx, makeFixtureDoc(), true);

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

	it("editField with id rename emits ONE data-mutations batch carrying the whole staged edit", async () => {
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
		const sa = makeSa(ctx, doc, true);

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
		// Under the P3 chat-SA port, `recordMutationStages` concatenates the
		// convert→rename→patch stages into ONE guarded commit and emits ONE
		// `data-mutations` frame — preserving editField's atomicity (one seq, one
		// batchId). The per-stage tags survive on the log envelopes, not the SSE
		// frame, so the wire frame carries no stage.
		expect(muts).toHaveLength(1);
		expect(muts[0].stage).toBeUndefined();
		const kinds = muts[0].mutations.map((m) => m.kind);
		expect(kinds).toContain("renameField");
		expect(kinds).toContain("updateField");
		expectNoLegacyEvents(writer);
	});

	it("updateModule emits data-mutations (not data-blueprint-updated)", async () => {
		const sa = makeSa(ctx, makeFixtureDoc(), true);

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
		const sa = makeSa(ctx, makeFixtureDoc(), true);

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
		const sa = makeSa(ctx, makeFixtureDoc(), true);

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
		const sa = makeSa(ctx, makeFixtureDoc(), false);

		// The planning tool (build mode only) — pure, but walked so a
		// future regression that makes it emit shows up here.
		await runTool(sa, "generateSchema", {
			caseTypes: [
				{ name: "patient", properties: [{ name: "case_name", label: "Name" }] },
			],
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

/* Every mutating tool call commits through `commitGuardedBatch` — rename
 * batches through `applyBlueprintChange` — and the hoisted mocks re-apply
 * each batch onto one tracked doc so no save reaches Postgres. `loadApp`
 * backs `wrapMutating`'s conflict-reload path. */
vi.mock("@/lib/db/apps", () => ({
	commitGuardedBatch: commitGuardedBatchMock,
	loadApp: loadAppMock,
}));
vi.mock("@/lib/db/applyBlueprintChange", () => ({
	applyBlueprintChange: applyBlueprintChangeMock,
}));

describe("solutionsArchitect — no finishing tool", () => {
	it("completeBuild is absent from both tool sets", () => {
		const { ctx } = buildCtx();
		const buildSa = makeSa(ctx, makeEmptyDoc(), false);
		const editSa = makeSa(ctx, makeFixtureDoc(), true);
		expect("completeBuild" in buildSa.tools).toBe(false);
		expect("completeBuild" in editSa.tools).toBe(false);
	});

	it("the data-model tool is shared (both modes); the retired plan tool is gone; updateApp is shared", () => {
		const { ctx } = buildCtx();
		const buildSa = makeSa(ctx, makeEmptyDoc(), false);
		const editSa = makeSa(ctx, makeFixtureDoc(), true);
		// generateSchema commits catalog records, and a NEW case type enters
		// an existing app through it — so it's in the edit-mode set too.
		expect("generateSchema" in buildSa.tools).toBe(true);
		expect("generateSchema" in editSa.tools).toBe(true);
		expect("planAppDesign" in buildSa.tools).toBe(false);
		expect("planAppDesign" in editSa.tools).toBe(false);
		expect("updateApp" in buildSa.tools).toBe(true);
		expect("updateApp" in editSa.tools).toBe(true);
	});
});

// ── Chat-SA port: wrapMutating conflict-reload / terminal-reauth / no-reload ──
//
// The P3 chat-SA port routes every mutating tool through the guarded writer,
// and every tool's blanket `catch (err)` now runs through
// `common.ts::toToolErrorResult`, which RE-THROWS the three authoritative commit
// signals so they escape the tool body and reach `wrapMutating`. Four distinct
// behaviors, all exercised here through a REAL tool (`addFields`):
//
//   - a RETRYABLE `BlueprintCommitRejectedError` (a peer deleted/changed the
//     target) escapes the tool → `wrapMutating` catches it → returns `{ error }`
//     to the SA AND reloads fresh via `loadApp`, so the NEXT tool builds on the
//     current server state;
//   - a TERMINAL `AppProjectChangedError` (the run's admitted tenant scope is
//     stale) escapes the tool → `wrapMutating` does NOT catch it → it propagates
//     without reloading or retrying inside the stale run;
//   - a TERMINAL `CommitReauthError` (the actor lost edit access) escapes the
//     tool → `wrapMutating` does NOT catch it → it propagates out of the tool's
//     execute and fails the run (a reload can't restore authorization);
//   - a pre-commit validity finding returns `{ error }` WITHOUT throwing (it's a
//     return value from `guardedMutate`, never a throw), so nothing reloads.

describe("solutionsArchitect — wrapMutating conflict reload / terminal reauth", () => {
	/** A reloaded doc that adds a second field so a follow-up read can prove the
	 *  SA rebased onto `loadApp`'s fresh blueprint after a conflict. */
	function reloadedDoc(): BlueprintDoc {
		const base = makeFixtureDoc();
		const PEER_FIELD = asUuid("99999999-9999-9999-9999-999999999999");
		return {
			...base,
			fields: {
				...base.fields,
				[PEER_FIELD]: {
					uuid: PEER_FIELD,
					id: "peer_added",
					kind: "text",
					label: "Peer added",
				} as Field,
			},
			fieldOrder: { [FORM_A]: [FIELD_A, PEER_FIELD] },
			fieldParent: { [FIELD_A]: FORM_A, [PEER_FIELD]: FORM_A },
		};
	}

	it("catches a BlueprintCommitRejectedError escaping the tool, returns { error }, and reloads fresh for the next tool", async () => {
		const { ctx } = buildCtx();
		const sa = makeSa(ctx, makeFixtureDoc(), true);
		// The guarded commit rejects (a peer changed the target); the tool's
		// blanket catch re-throws it (via toToolErrorResult), so it reaches
		// wrapMutating, which reloads a fresh doc carrying a peer-added field.
		commitGuardedBatchMock.mockRejectedValueOnce(
			new BlueprintCommitRejectedError(
				"This app changed while you were editing — reload.",
			),
		);
		loadAppMock.mockResolvedValueOnce({ blueprint: reloadedDoc() });

		const result = (await runTool(sa, "addFields", {
			moduleIndex: 0,
			formIndex: 0,
			fields: [{ id: "dob", kind: "date", label: "Date of birth" }],
		})) as { error?: string };

		// The tool surfaced the conflict as the standard `{ error }` envelope.
		expect(result.error).toContain("reload");
		// And `wrapMutating` reloaded fresh.
		expect(loadAppMock).toHaveBeenCalledWith("test-app");

		// The NEXT read builds on the reloaded doc — the peer's field is visible.
		const formResult = (await runTool(sa, "getForm", {
			moduleIndex: 0,
			formIndex: 0,
		})) as { form: { fields: Array<{ id: string }> } };
		expect(formResult.form.fields.map((f) => f.id).sort()).toEqual([
			"case_name",
			"peer_added",
		]);
	});

	it("propagates a terminal CommitReauthError past wrapMutating (no reload, fails the tool call)", async () => {
		const { ctx } = buildCtx();
		const sa = makeSa(ctx, makeFixtureDoc(), true);
		// The tool's blanket catch re-throws CommitReauthError; wrapMutating does
		// NOT catch it, so it escapes the tool's execute — terminal.
		commitGuardedBatchMock.mockRejectedValueOnce(
			new CommitReauthError("You no longer have edit access."),
		);

		await expect(
			runTool(sa, "addFields", {
				moduleIndex: 0,
				formIndex: 0,
				fields: [{ id: "dob", kind: "date", label: "Date of birth" }],
			}),
		).rejects.toBeInstanceOf(CommitReauthError);
		expect(loadAppMock).not.toHaveBeenCalled();
	});

	it("propagates AppProjectChangedError past wrapMutating without reload or retry", async () => {
		const { ctx } = buildCtx();
		const sa = makeSa(ctx, makeFixtureDoc(), true);
		const projectChanged = new AppProjectChangedError();
		// The tool's blanket catch re-throws the scope signal. Unlike a document
		// conflict, wrapMutating must not reload into a different Project inside
		// the already-admitted run.
		commitGuardedBatchMock.mockRejectedValueOnce(projectChanged);

		await expect(
			runTool(sa, "addFields", {
				moduleIndex: 0,
				formIndex: 0,
				fields: [{ id: "dob", kind: "date", label: "Date of birth" }],
			}),
		).rejects.toBe(projectChanged);
		expect(commitGuardedBatchMock).toHaveBeenCalledTimes(1);
		expect(loadAppMock).not.toHaveBeenCalled();
	});

	it.each([
		[
			"lost authorization",
			() => new CommitReauthError("You no longer have edit access."),
		],
		["a Project move", () => new AppProjectChangedError()],
	])(
		"poisons queued same-step tools and the next model step after %s",
		async (_label, makeScopeError) => {
			const { ctx } = buildCtx();
			const sa = makeSa(ctx, makeFixtureDoc(), true);
			const scopeError = makeScopeError();
			commitGuardedBatchMock.mockRejectedValueOnce(scopeError);

			// AI SDK dispatches parallel tool calls together. The serializer starts
			// the second body only after the first body has latched this terminal
			// signal; it must then reject with that SAME signal before committing.
			const settled = await Promise.allSettled([
				runTool(sa, "addFields", {
					moduleIndex: 0,
					formIndex: 0,
					fields: [{ id: "dob", kind: "date", label: "Date of birth" }],
				}),
				runTool(sa, "addFields", {
					moduleIndex: 0,
					formIndex: 0,
					fields: [{ id: "nickname", kind: "text", label: "Nickname" }],
				}),
			]);

			expect(settled).toEqual([
				{ status: "rejected", reason: scopeError },
				{ status: "rejected", reason: scopeError },
			]);
			expect(commitGuardedBatchMock).toHaveBeenCalledTimes(1);

			// `prepareStep` is the second fence: even after the recovered promise
			// chain settles, the agent must not make another model step in this run.
			await expect(
				sa.generate({ prompt: "Continue editing this app." }),
			).rejects.toBe(scopeError);
		},
	);

	it("does NOT reload on a pre-commit validity finding (the tool returns { error }, commit never runs)", async () => {
		const { ctx } = buildCtx();
		const sa = makeSa(ctx, makeFixtureDoc(), true);

		// A duplicate sibling id is a pre-commit identifier finding — the tool
		// returns `{ error }` before ever reaching the guarded commit.
		const result = (await runTool(sa, "addFields", {
			moduleIndex: 0,
			formIndex: 0,
			fields: [{ id: "case_name", kind: "text", label: "Dup" }],
		})) as { error?: string };

		expect(result.error).toBeDefined();
		// Neither the commit nor a reload fired — nothing threw.
		expect(commitGuardedBatchMock).not.toHaveBeenCalled();
		expect(loadAppMock).not.toHaveBeenCalled();
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
