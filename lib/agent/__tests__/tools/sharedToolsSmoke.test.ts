/**
 * Cross-surface behavior tests for the extracted shared tool modules.
 *
 * Phase D's thesis is that every shared tool under `lib/agent/tools/`
 * produces identical mutation batches when driven through either
 * surface's `ToolExecutionContext` implementation — `GenerationContext`
 * for the chat route, `McpContext` for the MCP adapter. If the two
 * contexts ever diverged on how the tool's mutations are computed,
 * replay + downstream persistence would drift. This file locks that
 * invariant in against one representative tool (`addFieldTool`); Phase
 * E will add per-adapter coverage.
 *
 * Also covers the `updateForm` partial-connect-config regression: a
 * partial update must leave sibling sub-configs untouched. The fix in
 * `buildConnectConfig` is what this test guards — a regression would
 * silently wipe `learn_module` when the SA patches only `assessment`,
 * and vice versa.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc, ConnectConfig, Form, Module } from "@/lib/domain";
import { asUuid } from "@/lib/domain";
import { addFieldTool } from "../../tools/addField";
import { addFieldsTool } from "../../tools/addFields";
import { updateFormTool } from "../../tools/updateForm";
import { makeMcpTestContext, makeTestContext } from "../fixtures";

/* Mock the apps module wholesale so `McpContext.recordMutations` — which
 * awaits `updateAppForRun` as part of its fail-closed contract — doesn't
 * try to reach real Firestore. The chat surface's `updateApp` call is
 * fire-and-forget, so the mock also needs to resolve for that path. */
vi.mock("@/lib/db/apps", () => ({
	updateApp: vi.fn(() => Promise.resolve()),
	updateAppForRun: vi.fn(() => Promise.resolve()),
	completeApp: vi.fn(() => Promise.resolve()),
}));

// ── Uuid constants ──────────────────────────────────────────────────────

const MOD_A = asUuid("11111111-1111-1111-1111-111111111111");
const FORM_A = asUuid("33333333-3333-3333-3333-333333333333");

// ── Fixture builder ─────────────────────────────────────────────────────

/**
 * Minimal `BlueprintDoc` with one case-carrying module and one
 * registration form. Enough state for `addFieldTool` to resolve its
 * positional `(moduleIndex, formIndex)` lookup against; no existing
 * fields so the insert lands at index 0 deterministically.
 */
function makeFixtureDoc(): BlueprintDoc {
	const mod: Module = {
		uuid: MOD_A,
		id: "patient",
		name: "Patient",
		caseType: "patient",
	};
	const form: Form = {
		uuid: FORM_A,
		id: "enroll",
		name: "Enroll Patient",
		type: "registration",
	};
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
		modules: { [MOD_A]: mod },
		forms: { [FORM_A]: form },
		fields: {},
		moduleOrder: [MOD_A],
		formOrder: { [MOD_A]: [FORM_A] },
		fieldOrder: {},
		fieldParent: {},
	};
}

/**
 * Clone the fixture and stamp a Learn-flavored connect config on the
 * registration form. Both `learn_module` and `assessment` are populated
 * so a partial update test can assert siblings are preserved — without
 * BOTH sub-configs the test would pass against a buggy implementation
 * that only honors the one sub-config the SA touched.
 */
function makeDocWithFullConnect(): BlueprintDoc {
	const doc = makeFixtureDoc();
	const connect: ConnectConfig = {
		learn_module: {
			id: "patient_module",
			name: "Patient Module",
			description: "How to enroll patients",
			time_estimate: 20,
		},
		assessment: {
			id: "patient_enroll_quiz",
			user_score: "#form/quiz_score",
		},
	};
	return {
		...doc,
		connectType: "learn",
		forms: {
			[FORM_A]: { ...doc.forms[FORM_A], connect } as Form,
		},
	};
}

/** Zod-compatible minimal `addField` input for the cross-surface test.
 *  `kind` is narrowed to the literal `"date"` so the input type-checks
 *  against the tool's `kind` enum — the schema rejects bare strings. */
const ADD_FIELD_INPUT = {
	moduleIndex: 0,
	formIndex: 0,
	field: {
		id: "dob",
		kind: "date" as const,
		label: "Date of birth",
	},
};

beforeEach(() => {
	vi.clearAllMocks();
});

// ── Cross-surface shared-tool smoke test ────────────────────────────────

describe("shared tool modules drive uniform behavior across surfaces", () => {
	it("addFieldTool produces identical mutations on chat and MCP contexts", async () => {
		/* Driving the same input through both contexts should produce
		 * byte-identical mutation batches — the mutations are pure output
		 * of the shared tool module, independent of the surface's
		 * persistence semantics (SSE fire-and-forget vs. MCP awaited).
		 * Any divergence here means a shared tool accidentally grew a
		 * surface-specific code path. */
		const doc = makeFixtureDoc();

		const { ctx: chatCtx } = makeTestContext();
		const chatResult = await addFieldTool.execute(
			ADD_FIELD_INPUT,
			chatCtx,
			doc,
		);

		const { ctx: mcpCtx } = makeMcpTestContext();
		const mcpResult = await addFieldTool.execute(ADD_FIELD_INPUT, mcpCtx, doc);

		/* Strip the minted field uuid — it's a fresh `crypto.randomUUID()`
		 * per call, so two sequential calls won't match byte-for-byte on
		 * the uuid field. The rest of the addField mutation (parent, id,
		 * kind, label) is deterministic and must be identical. */
		function stripFieldUuid(muts: Mutation[]): unknown[] {
			return muts.map((m) => {
				if (m.kind === "addField") {
					const { uuid: _uuid, ...fieldSansUuid } = m.field;
					return { ...m, field: fieldSansUuid };
				}
				return m;
			});
		}

		expect(stripFieldUuid(chatResult.mutations)).toEqual(
			stripFieldUuid(mcpResult.mutations),
		);
		expect(chatResult.mutations).toHaveLength(1);
		expect(chatResult.mutations[0]?.kind).toBe("addField");
	});
});

// ── addField / addFields pipeline parity ────────────────────────────────

describe("addField and addFields share the same add-path pipeline", () => {
	it("both unescape XPath HTML entities in validate expressions", async () => {
		/* Regression guard for the divergence where `addField` only ran
		 * `flatFieldToField` and skipped `applyDefaults` — LLM-emitted
		 * `&gt;` / `&lt;` sequences on XPath-valued keys survived into
		 * the stored field and XForm validation rejected them at
		 * generation time. Both tools must now run the same pipeline so a
		 * given payload normalizes identically regardless of entry point.
		 *
		 * The mutation's `addField.field` is the assembled domain Field —
		 * the final post-pipeline shape — so comparing `field.validate`
		 * across both tools directly asserts pipeline parity. */
		const doc = makeFixtureDoc();
		const id = "age";
		const escapedValidate = ". &gt; 0 and . &lt; 150";
		const expectedValidate = ". > 0 and . < 150";

		const singleCtx = makeTestContext().ctx;
		const { mutations: singleMuts } = await addFieldTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				field: {
					id,
					kind: "int",
					label: "Age",
					validate: escapedValidate,
				},
			},
			singleCtx,
			doc,
		);
		const addedSingle = singleMuts.find(
			(m): m is Extract<Mutation, { kind: "addField" }> =>
				m.kind === "addField",
		);

		const batchCtx = makeTestContext().ctx;
		const { mutations: batchMuts } = await addFieldsTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				fields: [
					{
						/* Full sentinel-padded shape — `addFieldsItemSchema`
						 * makes `parentId`, `label`, `required` required-with-
						 * sentinel, and eight other optionals fill the 8-slot
						 * ceiling. `""` / `[]` are the absent sentinels the
						 * batch-path `stripEmpty` collapses before
						 * `applyDefaults` runs. */
						id,
						kind: "int",
						parentId: "",
						label: "Age",
						required: "",
						hint: "",
						validate: escapedValidate,
						validate_msg: "",
						relevant: "",
						calculate: "",
						default_value: "",
						options: [],
						case_property: "",
					},
				],
			},
			batchCtx,
			doc,
		);
		const addedBatch = batchMuts.find(
			(m): m is Extract<Mutation, { kind: "addField" }> =>
				m.kind === "addField",
		);

		expect(addedSingle?.field).toMatchObject({ validate: expectedValidate });
		expect(addedBatch?.field).toMatchObject({ validate: expectedValidate });
	});
});

// ── updateForm partial-connect regression ───────────────────────────────

describe("updateFormTool partial connect-config updates", () => {
	it("patching only `assessment` preserves the existing `learn_module`", async () => {
		/* Regression guard for the silent-wipe bug in `buildConnectConfig`:
		 * before the fix, `input.learn_module === undefined` produced
		 * `learn_module: undefined` on the output, which the reducer
		 * treated as "clear" — wiping the pre-existing sub-config. The
		 * fix only writes keys the SA explicitly provided. */
		const doc = makeDocWithFullConnect();
		const { ctx } = makeTestContext();

		const result = await updateFormTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				connect: {
					// Touch only `assessment` — `learn_module` must survive.
					assessment: { user_score: "#form/new_score" },
				},
			},
			ctx,
			doc,
		);

		expect(result.mutations).toHaveLength(1);
		const mut = result.mutations[0];
		if (mut?.kind !== "updateForm") {
			throw new Error(`expected updateForm mutation, got ${mut?.kind}`);
		}
		const patchConnect = mut.patch.connect;
		/* Both sub-configs must be present after the partial update:
		 * `learn_module` unchanged (preserved from `existing`) and
		 * `assessment` merged with the incoming patch. */
		expect(patchConnect?.learn_module).toEqual({
			id: "patient_module",
			name: "Patient Module",
			description: "How to enroll patients",
			time_estimate: 20,
		});
		expect(patchConnect?.assessment).toEqual({
			id: "patient_enroll_quiz",
			user_score: "#form/new_score",
		});
	});

	it("patching only `learn_module` preserves the existing `assessment`", async () => {
		/* Symmetric assertion: the SA can patch either sub-config
		 * independently. Running both directions catches asymmetric
		 * regressions where only one half of the fix was applied. */
		const doc = makeDocWithFullConnect();
		const { ctx } = makeTestContext();

		const result = await updateFormTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				connect: {
					learn_module: {
						name: "Patient Module v2",
						description: "Updated copy",
						time_estimate: 30,
					},
				},
			},
			ctx,
			doc,
		);

		expect(result.mutations).toHaveLength(1);
		const mut = result.mutations[0];
		if (mut?.kind !== "updateForm") {
			throw new Error(`expected updateForm mutation, got ${mut?.kind}`);
		}
		const patchConnect = mut.patch.connect;
		expect(patchConnect?.assessment).toEqual({
			id: "patient_enroll_quiz",
			user_score: "#form/quiz_score",
		});
		/* Merge semantics: the spread keeps pre-existing `id` from the
		 * existing learn_module plus the new name/description/time
		 * the patch supplied. */
		expect(patchConnect?.learn_module).toEqual({
			id: "patient_module",
			name: "Patient Module v2",
			description: "Updated copy",
			time_estimate: 30,
		});
	});
});
