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

/* Mock the apps module so chat-side `saveBlueprint`'s fire-and-forget
 * `updateAppForRun` call resolves cleanly. `completeApp` is mocked the
 * same way for the SA's success-path persistence. */
vi.mock("@/lib/db/apps", () => ({
	updateApp: vi.fn(() => Promise.resolve()),
	updateAppForRun: vi.fn(() => Promise.resolve()),
	completeApp: vi.fn(() => Promise.resolve()),
}));

/* Mock the cross-store saga so `McpContext.recordMutations` — which
 * routes through `applyBlueprintChange` for the awaited blueprint
 * write — doesn't try to reach Firestore + Postgres. The chat surface
 * doesn't go through the saga (its intermediate save stays
 * fire-and-forget), so this mock only matters for the MCP path. */
vi.mock("@/lib/db/applyBlueprintChange", () => ({
	applyBlueprintChange: vi.fn(() => Promise.resolve()),
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
					validate: { expr: escapedValidate },
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
						 * sentinel, and eight other optionals (including the
						 * nested `validate` and `repeat` config objects) fill
						 * the 8-slot ceiling. `""` / `[]` are the absent
						 * sentinels the batch-path `stripEmpty` collapses
						 * before `applyDefaults` runs; `validate` and
						 * `repeat` are simply omitted when not in use. */
						id,
						kind: "int",
						parentId: "",
						label: "Age",
						required: "",
						hint: "",
						validate: { expr: escapedValidate },
						relevant: "",
						calculate: "",
						default_value: "",
						options: [],
						case_property_on: "",
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

// ── updateForm connect-id source enforcement ──────────────────────────

describe("updateFormTool connect-id validity", () => {
	it("fails the call (no mutations) when an explicit connect id is invalid", async () => {
		/* Force-correct-at-the-source: an explicit invalid id (space →
		 * illegal XML element name) must FAIL the tool call and write
		 * NOTHING — never silently sanitize. The SA gets one diagnostic and
		 * re-issues. */
		const doc = makeDocWithFullConnect();
		const { ctx } = makeTestContext();

		const result = await updateFormTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				connect: {
					learn_module: {
						id: "bad id",
						name: "M",
						description: "x",
						time_estimate: 5,
					},
				},
			},
			ctx,
			doc,
		);

		expect(result.mutations).toEqual([]);
		expect(result.result).toHaveProperty("error");
		expect((result.result as { error: string }).error).toContain("bad id");
	});

	it("fails the call when an explicit connect id is over the length limit", async () => {
		const doc = makeDocWithFullConnect();
		const { ctx } = makeTestContext();
		const result = await updateFormTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				connect: {
					assessment: { id: "a".repeat(60), user_score: "100" },
				},
			},
			ctx,
			doc,
		);
		expect(result.mutations).toEqual([]);
		expect(result.result).toHaveProperty("error");
	});

	it("fails the call when an explicit id duplicates the co-located block's id", async () => {
		/* Same-form cross-kind duplicate via the tool: set assessment.id to
		 * the existing learn_module.id. The merge + `enforceConnectIds`
		 * reject it (learn_module accumulated before assessment is checked) →
		 * `{ error }`, zero mutations, nothing written. */
		const doc = makeDocWithFullConnect();
		const { ctx } = makeTestContext();
		const result = await updateFormTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				// learn_module already has id "patient_module" on this form.
				connect: { assessment: { id: "patient_module", user_score: "100" } },
			},
			ctx,
			doc,
		);
		expect(result.mutations).toEqual([]);
		expect(result.result).toHaveProperty("error");
		expect((result.result as { error: string }).error).toContain(
			"patient_module",
		);
	});

	it("autofills a valid id when a newly-enabled block omits one", async () => {
		/* A block enabled without an explicit id gets a name-derived,
		 * valid, unique id STORED on the doc — visible to the SA on the
		 * next read, not conjured at emit. */
		const doc = makeDeliverDocWithoutConnect();
		const { ctx } = makeTestContext();
		const result = await updateFormTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				connect: { deliver_unit: { name: "Vendor visit" } },
			},
			ctx,
			doc,
		);
		const du = result.newDoc.forms[FORM_A]?.connect?.deliver_unit;
		expect(du?.id).toBeDefined();
		expect((du as { id: string }).id.length).toBeGreaterThan(0);
		// The autofilled id is derived from the module name ("Patient").
		expect(du?.id).toBe("patient");
	});
});

// ── updateForm deliver_unit ───────────────────────────────────────────

/**
 * Build a Deliver-typed fixture with no per-form connect block — the
 * starting state when the SA is about to attach `deliver_unit` to a
 * form for the first time. The SA's call shape is `update_form` with
 * `connect.deliver_unit.name`; the test assertions below pin the
 * post-mutation invariant: the doc carries only what the SA supplied,
 * with `entity_id` / `entity_name` left absent for the wire-emit
 * fallback to substitute at bind time.
 */
function makeDeliverDocWithoutConnect(): BlueprintDoc {
	const doc = makeFixtureDoc();
	return { ...doc, connectType: "deliver" };
}

describe("updateFormTool deliver_unit", () => {
	it("autofills the id from the module name; no entity_id/entity_name injected", async () => {
		/* Source-correctness: an id-less deliver_unit gets a valid id
		 * autofilled from the module name ("Patient" → "patient"), stored on
		 * the doc. `entity_id` / `entity_name` are NOT injected — those are
		 * absent on the input and remain absent (the XForm builder
		 * substitutes the canonical defaults at emit time; writing empties at
		 * the agent layer would produce `<bind … calculate=""/>` which CCHQ
		 * rejects). */
		const doc = makeDeliverDocWithoutConnect();
		const { ctx } = makeTestContext();

		const result = await updateFormTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				connect: {
					deliver_unit: { name: "Vendor visit" },
				},
			},
			ctx,
			doc,
		);

		expect(result.mutations).toHaveLength(1);
		const finalForm = result.newDoc.forms[FORM_A];
		expect(finalForm?.connect?.deliver_unit).toEqual({
			id: "patient",
			name: "Vendor visit",
		});
	});

	it("preserves an existing custom entity_id/entity_name through a partial re-patch", async () => {
		/* When a deliver_unit already carries explicit XPath
		 * expressions — set via direct doc edit, a UI panel, or a
		 * future SA tool that exposes those fields — a follow-up
		 * `update_form` that touches only `name` must leave the
		 * entity expressions alone. The structural merge
		 * (`{...existing.deliver_unit, ...input.deliver_unit}`)
		 * handles this without any defaulting logic. */
		const docBase = makeDeliverDocWithoutConnect();
		const seeded: BlueprintDoc = {
			...docBase,
			forms: {
				[FORM_A]: {
					...docBase.forms[FORM_A],
					connect: {
						deliver_unit: {
							id: "vendor_visit",
							name: "Vendor visit",
							entity_id: "concat(#form/loc_id, '-', uuid())",
							entity_name: "#form/loc_id/market_name",
						},
					},
				} as Form,
			},
		};
		const { ctx } = makeTestContext();

		const result = await updateFormTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				connect: {
					deliver_unit: { name: "Vendor visit (updated)" },
				},
			},
			ctx,
			seeded,
		);

		const finalForm = result.newDoc.forms[FORM_A];
		expect(finalForm?.connect?.deliver_unit).toEqual({
			id: "vendor_visit",
			name: "Vendor visit (updated)",
			entity_id: "concat(#form/loc_id, '-', uuid())",
			entity_name: "#form/loc_id/market_name",
		});
	});

	it("accepts SA-supplied entity_id and entity_name and lands them on the doc verbatim", async () => {
		/* The schema exposes entity_id and entity_name as optional
		 * inputs so the SA can override the wire defaults for
		 * workflows that need a different dedup key — case-based
		 * deliveries (`#case/case_id`), per-beneficiary deliveries,
		 * site-keyed deliveries, etc. The SA's expression must reach
		 * the doc verbatim; the wire emitter's `||` fallback only
		 * activates on absence/empty, so a non-empty SA value wins. */
		const doc = makeDeliverDocWithoutConnect();
		const { ctx } = makeTestContext();

		const result = await updateFormTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				connect: {
					deliver_unit: {
						name: "Beneficiary visit",
						entity_id: "#case/case_id",
						entity_name: "#case/case_name",
					},
				},
			},
			ctx,
			doc,
		);

		const finalForm = result.newDoc.forms[FORM_A];
		expect(finalForm?.connect?.deliver_unit).toEqual({
			id: "patient",
			name: "Beneficiary visit",
			entity_id: "#case/case_id",
			entity_name: "#case/case_name",
		});
	});

	it("schema accepts a partial deliver_unit with only entity_id set (entity_name still falls through to wire default)", async () => {
		/* Partial-override case: SA wants a custom dedup key but is
		 * fine with the default display label. Both fields are
		 * independently optional; setting one doesn't force the
		 * other. */
		const doc = makeDeliverDocWithoutConnect();
		const { ctx } = makeTestContext();

		const result = await updateFormTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				connect: {
					deliver_unit: {
						name: "Site visit",
						entity_id: "#form/site_id",
					},
				},
			},
			ctx,
			doc,
		);

		const finalForm = result.newDoc.forms[FORM_A];
		expect(finalForm?.connect?.deliver_unit).toEqual({
			id: "patient",
			name: "Site visit",
			entity_id: "#form/site_id",
		});
		expect(finalForm?.connect?.deliver_unit?.entity_name).toBeUndefined();
	});
});
