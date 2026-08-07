/**
 * Cross-surface behavior tests for the extracted shared tool modules.
 *
 * Phase D's thesis is that every shared tool under `lib/agent/tools/`
 * produces identical mutation batches when driven through either
 * surface's `CanonicalMutationHost` implementation — `GenerationContext`
 * for the chat route, `McpContext` for the MCP adapter. If the two
 * hosts ever diverged on how the tool's mutations are computed,
 * replay + downstream persistence would drift. This file locks that
 * invariant in against one representative tool (`addFieldsTool`); Phase
 * E will add per-adapter coverage.
 *
 * Also covers the `updateForm` partial-connect-config regression: a
 * partial update must leave sibling sub-configs untouched. The fix in
 * `buildConnectConfig` is what this test guards — a regression would
 * silently wipe `learn_module` when the SA patches only `assessment`,
 * and vice versa.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	buildDoc,
	caseListConfig,
	f,
	xp,
	xpIn,
} from "@/lib/__tests__/docHelpers";
import type { Mutation } from "@/lib/doc/types";
import type {
	BlueprintDoc,
	ConnectConfig,
	ConnectDeliverConfig,
	ConnectLearnConfig,
	Form,
	Uuid,
} from "@/lib/domain";
import { formExpressionSource, isConnectLearnConfig } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { type AddFieldsInput, addFieldsTool } from "../../tools/addFields";
import { type UpdateFormInput, updateFormTool } from "../../tools/updateForm";
import { CanonicalMutationWorkspace } from "../../workspace/canonicalWorkspace";
import { makeMcpTestContext, makeToolWorkspaceHarness } from "../fixtures";

/* Mock the apps module so importing it doesn't reach Postgres.
 * `completeApp` is stubbed for the SA's success-path status flip; the chat
 * workspace here is a `makeToolWorkspaceHarness`, so its guarded commit never
 * touches this module. */
vi.mock("@/lib/db/apps", () => ({
	completeApp: vi.fn(() => Promise.resolve()),
}));

/* The MCP surface uses the exact in-memory guarded writer seeded by
 * `makeMcpTestContext`, preserving replay and a complete committedDoc without
 * reaching Postgres. */
vi.mock("@/lib/db/applyBlueprintChange", () => ({
	applyBlueprintChange: vi.fn(async (args) => {
		const { commitApplyBlueprintChangeTestBatch } = await import(
			"@/lib/db/__tests__/applyBlueprintChangeTestWriter"
		);
		return commitApplyBlueprintChangeTestBatch(args);
	}),
}));

// ── Uuid constants ──────────────────────────────────────────────────────

const MOD_A = testUuid("11111111-1111-1111-1111-111111111111");
const FORM_A = testUuid("33333333-3333-3333-3333-333333333333");

function requireLearnConnect(
	connect: ConnectConfig | null | undefined,
): ConnectLearnConfig {
	if (connect == null || !isConnectLearnConfig(connect)) {
		throw new Error("expected learn-mode Connect config");
	}
	return connect;
}

function requireDeliverConnect(
	connect: ConnectConfig | null | undefined,
): ConnectDeliverConfig {
	if (connect == null || isConnectLearnConfig(connect)) {
		throw new Error("expected deliver-mode Connect config");
	}
	return connect;
}

// ── Fixture builder ─────────────────────────────────────────────────────

/**
 * Minimal `BlueprintDoc` with one case-carrying module and one
 * registration form. The fixture is valid before the tool call: registration
 * already writes its required case name and the case module has a case-list
 * column. This matters because every authoring call now enters through the
 * absolute gate rather than growing out of a malformed partial document.
 */
function makeFixtureDoc(): BlueprintDoc {
	return buildDoc({
		appId: "test-app",
		appName: "Clinic Intake",
		connectType: null,
		caseTypes: [
			{
				name: "patient",
				properties: [{ name: "case_name", label: proseText("Full name") }],
			},
		],
		modules: [
			{
				uuid: MOD_A,
				id: "patient",
				name: "Patient",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: FORM_A,
						id: "enroll",
						name: "Enroll Patient",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "case_name",
								label: proseText("Full name"),
								caseWrite: {
									caseType: "patient",
									property: "case_name",
								},
							}),
						],
					},
				],
			},
		],
	});
}

function fieldUuid(doc: BlueprintDoc, id: string): Uuid {
	const field = Object.values(doc.fields).find(
		(candidate) => candidate.id === id,
	);
	if (field === undefined) throw new Error(`field "${id}" missing`);
	return field.uuid;
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
			user_score: xp("100"),
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

/** Zod-compatible minimal `addFields` input for the cross-surface test.
 *  `kind` is narrowed to the literal `"date"` so the input type-checks
 *  against the tool's per-kind union — the schema rejects bare strings. */
const ADD_FIELDS_INPUT = {
	moduleUuid: MOD_A,
	formUuid: FORM_A,
	fields: [
		{
			id: "dob",
			kind: "date" as const,
			label: proseText("Date of birth"),
		},
	],
} satisfies AddFieldsInput;

beforeEach(() => {
	vi.clearAllMocks();
});

// ── Cross-surface shared-tool smoke test ────────────────────────────────

describe("shared tool modules drive uniform behavior across surfaces", () => {
	it("addFieldsTool produces identical mutations on chat and MCP contexts", async () => {
		/* Driving the same input through both contexts should produce
		 * byte-identical mutation batches — the mutations are pure output
		 * of the shared tool module, independent of the surface's
		 * persistence semantics (SSE fire-and-forget vs. MCP awaited).
		 * Any divergence here means a shared tool accidentally grew a
		 * surface-specific code path. */
		const doc = makeFixtureDoc();

		const chat = makeToolWorkspaceHarness(doc);
		const chatResult = await chat.runTool(addFieldsTool, ADD_FIELDS_INPUT);

		const { ctx: mcpCtx } = makeMcpTestContext({ initialDoc: doc });
		const mcpWorkspace = new CanonicalMutationWorkspace({
			host: mcpCtx,
			initialDoc: doc,
		});
		const mcpResult = await mcpWorkspace.invoke({
			toolName: "addFields",
			execute: (ctx) => addFieldsTool.execute(ADD_FIELDS_INPUT, ctx),
		});

		/* Strip the minted field uuid — it's a fresh `crypto.randomUUID()`
		 * per call, so two sequential calls won't match byte-for-byte on
		 * the uuid field. The rest of the addField mutation (parent, id,
		 * kind, label) is deterministic and must be identical. */
		function stripFieldUuid(muts: readonly Mutation[]): unknown[] {
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

// ── addFields add-path pipeline ──────────────────────────────────────────

describe("addFields add-path pipeline", () => {
	it("returns every field and inline-option identity in input/source order", async () => {
		const doc = makeFixtureDoc();
		const fieldUuids = [
			testUuid("add-receipt-notes"),
			testUuid("add-receipt-status"),
		];
		const optionUuids = [
			testUuid("add-receipt-open"),
			testUuid("add-receipt-done"),
		];
		const h = makeToolWorkspaceHarness(doc);
		const out = await h.runTool(addFieldsTool, {
			moduleUuid: MOD_A,
			formUuid: FORM_A,
			fields: [
				{
					fieldUuid: fieldUuids[0],
					id: "notes",
					kind: "text",
					label: proseText("Notes"),
				},
				{
					fieldUuid: fieldUuids[1],
					id: "status",
					kind: "single_select",
					label: proseText("Status"),
					optionsSource: {
						kind: "inline",
						options: [
							{
								optionUuid: optionUuids[0],
								value: "open",
								label: proseText("Open"),
							},
							{
								optionUuid: optionUuids[1],
								value: "done",
								label: proseText("Done"),
							},
						],
					},
				},
			],
		} satisfies AddFieldsInput);
		if (!("fields" in out.result)) {
			throw new Error(`expected success: ${JSON.stringify(out.result)}`);
		}
		expect(out.result.fields).toEqual([
			{ uuid: fieldUuids[0], id: "notes", options: [] },
			{
				uuid: fieldUuids[1],
				id: "status",
				options: [
					{ uuid: optionUuids[0], value: "open" },
					{ uuid: optionUuids[1], value: "done" },
				],
			},
		]);
	});

	it("returns inline identities minted from a case-property catalog default", async () => {
		const doc = makeFixtureDoc();
		const patient = doc.caseTypes?.find(
			(caseType) => caseType.name === "patient",
		);
		if (!patient) throw new Error("patient catalog fixture missing");
		patient.properties.push({
			name: "consent_level",
			data_type: "single_select",
			label: proseText("Consent level"),
			options: [
				{ value: "open", label: proseText("Open") },
				{ value: "done", label: proseText("Done") },
			],
		});
		const h = makeToolWorkspaceHarness(doc);
		const out = await h.runTool(addFieldsTool, {
			moduleUuid: MOD_A,
			formUuid: FORM_A,
			fields: [
				{
					id: "consent_level",
					kind: "single_select",
					caseWrite: {
						caseType: "patient",
						property: "consent_level",
					},
				},
			],
		} satisfies AddFieldsInput);
		if (!("fields" in out.result)) {
			throw new Error(`expected success: ${JSON.stringify(out.result)}`);
		}
		const [receipt] = out.result.fields;
		expect(receipt?.options.map((option) => option.value)).toEqual([
			"open",
			"done",
		]);
		const stored = h.currentDoc().fields[receipt?.uuid ?? ""];
		expect(
			stored &&
				"optionsSource" in stored &&
				stored.optionsSource.kind === "inline"
				? stored.optionsSource.options.map((option) => option.uuid)
				: [],
		).toEqual(receipt?.options.map((option) => option.uuid));
	});

	it("inserts the batch's top-level fields at a `beforeFieldUuid` anchor", async () => {
		/* The identity anchor folded in from the removed single `addField`
		 * tool: the batch's top-level fields land as a contiguous block at
		 * the anchor's index. Seed three fields, then insert two before the
		 * middle one and assert the resulting order. */
		const doc = makeFixtureDoc();
		const h = makeToolWorkspaceHarness(doc);
		await h.runTool(addFieldsTool, {
			moduleUuid: MOD_A,
			formUuid: FORM_A,
			fields: [
				{ id: "first", kind: "text", label: proseText("First") },
				{ id: "middle", kind: "text", label: proseText("Middle") },
				{ id: "last", kind: "text", label: proseText("Last") },
			],
		} satisfies AddFieldsInput);
		const seeded = h.currentDoc();

		await h.runTool(addFieldsTool, {
			moduleUuid: MOD_A,
			formUuid: FORM_A,
			beforeFieldUuid: fieldUuid(seeded, "middle"),
			fields: [
				{ id: "ins_a", kind: "text", label: proseText("A") },
				{ id: "ins_b", kind: "text", label: proseText("B") },
			],
		} satisfies AddFieldsInput);

		const final = h.currentDoc();
		const formUuid = final.formOrder[MOD_A][0];
		const order = (final.fieldOrder[formUuid] ?? []).map(
			(u) => final.fields[u]?.id,
		);
		expect(order).toEqual([
			"case_name",
			"first",
			"ins_a",
			"ins_b",
			"middle",
			"last",
		]);
	});

	it("applies a batch-level parentUuid, with a field's own parentUuid overriding it", async () => {
		// `addFields` accepts a top-level `parentUuid` (the batch default
		// parent), mirroring single `addField`'s top-level `parentUuid`, so the
		// SA's natural usage nests the batch instead of hard-erroring on an
		// unrecognized key. A field's OWN parentUuid still wins.
		const doc = makeFixtureDoc();

		// Seed two groups to nest under.
		const h = makeToolWorkspaceHarness(doc);
		const { mutations: groupMuts } = await h.runTool(addFieldsTool, {
			moduleUuid: MOD_A,
			formUuid: FORM_A,
			fields: [
				{ id: "vitals", kind: "group", label: proseText("Vitals") },
				{ id: "history", kind: "group", label: proseText("History") },
			],
		} satisfies AddFieldsInput);
		const groupUuid = (id: string): Uuid => {
			const m = groupMuts.find(
				(mut): mut is Extract<Mutation, { kind: "addField" }> =>
					mut.kind === "addField" && mut.field.id === id,
			);
			if (!m) throw new Error(`group "${id}" not added`);
			return m.field.uuid;
		};

		const { mutations } = await h.runTool(addFieldsTool, {
			moduleUuid: MOD_A,
			formUuid: FORM_A,
			parentUuid: groupUuid("vitals"), // batch default parent
			fields: [
				// No own parentUuid → inherits the batch default ("vitals").
				{ id: "height", kind: "decimal", label: proseText("Height") },
				// Own parentUuid → overrides the batch default ("history").
				{
					id: "weight",
					kind: "decimal",
					label: proseText("Weight"),
					parentUuid: groupUuid("history"),
				},
			],
		} satisfies AddFieldsInput);

		const addedUnder = (id: string): string | undefined =>
			mutations.find(
				(m): m is Extract<Mutation, { kind: "addField" }> =>
					m.kind === "addField" && m.field.id === id,
			)?.parentUuid;

		expect(addedUnder("height")).toBe(groupUuid("vitals"));
		expect(addedUnder("weight")).toBe(groupUuid("history"));
	});

	it("rejects a parentUuid naming a leaf", async () => {
		const doc = makeFixtureDoc();
		const h = makeToolWorkspaceHarness(doc);
		await h.runTool(addFieldsTool, {
			moduleUuid: MOD_A,
			formUuid: FORM_A,
			fields: [{ id: "patient_name", kind: "text", label: proseText("Name") }],
		} satisfies AddFieldsInput);
		const seeded = h.currentDoc();

		const result = await h.runTool(addFieldsTool, {
			moduleUuid: MOD_A,
			formUuid: FORM_A,
			parentUuid: fieldUuid(seeded, "patient_name"), // a leaf field — not a valid parent
			fields: [{ id: "dob", kind: "date", label: proseText("Date of birth") }],
		} satisfies AddFieldsInput);

		expect(result.mutations).toEqual([]);
		expect(result.result).toHaveProperty("error");
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
		const h = makeToolWorkspaceHarness(doc);

		const result = await h.runTool(updateFormTool, {
			moduleUuid: MOD_A,
			formUuid: FORM_A,
			connect: {
				// Touch only `assessment` — `learn_module` must survive.
				assessment: { user_score: xp("100") },
			},
		} satisfies UpdateFormInput);

		expect(result.mutations).toHaveLength(1);
		const mut = result.mutations[0];
		if (mut?.kind !== "updateForm") {
			throw new Error(`expected updateForm mutation, got ${mut?.kind}`);
		}
		const patchConnect = mut.patch.connect;
		const learnConnect = requireLearnConnect(patchConnect);
		/* Both sub-configs must be present after the partial update:
		 * `learn_module` unchanged (preserved from `existing`) and
		 * `assessment` merged with the incoming patch. */
		expect(learnConnect.learn_module).toEqual({
			id: "patient_module",
			name: "Patient Module",
			description: "How to enroll patients",
			time_estimate: 20,
		});
		expect(learnConnect.assessment?.id).toBe("patient_enroll_quiz");
		const patchedDoc = h.currentDoc();
		const patchedForm = patchedDoc.forms[FORM_A];
		expect(
			patchedForm &&
				formExpressionSource(patchedForm, "assessment_user_score", patchedDoc),
		).toBe("100");
	});

	it("patching only `learn_module` preserves the existing `assessment`", async () => {
		/* Symmetric assertion: the SA can patch either sub-config
		 * independently. Running both directions catches asymmetric
		 * regressions where only one half of the fix was applied. */
		const doc = makeDocWithFullConnect();
		const h = makeToolWorkspaceHarness(doc);

		const result = await h.runTool(updateFormTool, {
			moduleUuid: MOD_A,
			formUuid: FORM_A,
			connect: {
				learn_module: {
					name: "Patient Module v2",
					description: "Updated copy",
					time_estimate: 30,
				},
			},
		} satisfies UpdateFormInput);

		expect(result.mutations).toHaveLength(1);
		const mut = result.mutations[0];
		if (mut?.kind !== "updateForm") {
			throw new Error(`expected updateForm mutation, got ${mut?.kind}`);
		}
		const patchConnect = mut.patch.connect;
		const learnConnect = requireLearnConnect(patchConnect);
		expect(learnConnect.assessment?.id).toBe("patient_enroll_quiz");
		const patchedDoc = h.currentDoc();
		const patchedForm = patchedDoc.forms[FORM_A];
		expect(
			patchedForm &&
				formExpressionSource(patchedForm, "assessment_user_score", patchedDoc),
		).toBe("100");
		/* Merge semantics: the spread keeps pre-existing `id` from the
		 * existing learn_module plus the new name/description/time
		 * the patch supplied. */
		expect(learnConnect.learn_module).toEqual({
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
		const h = makeToolWorkspaceHarness(doc);

		const result = await h.runTool(updateFormTool, {
			moduleUuid: MOD_A,
			formUuid: FORM_A,
			connect: {
				learn_module: {
					id: "bad id",
					name: "M",
					description: "x",
					time_estimate: 5,
				},
			},
		} satisfies UpdateFormInput);

		expect(result.mutations).toEqual([]);
		expect(result.result).toHaveProperty("error");
		expect((result.result as { error: string }).error).toContain("bad id");
	});

	it("fails the call when an explicit connect id is over the length limit", async () => {
		const doc = makeDocWithFullConnect();
		const h = makeToolWorkspaceHarness(doc);
		const result = await h.runTool(updateFormTool, {
			moduleUuid: MOD_A,
			formUuid: FORM_A,
			connect: {
				assessment: { id: "a".repeat(60), user_score: xp("100") },
			},
		} satisfies UpdateFormInput);
		expect(result.mutations).toEqual([]);
		expect(result.result).toHaveProperty("error");
	});

	it("fails the call when an explicit id duplicates the co-located block's id", async () => {
		/* Same-form cross-kind duplicate via the tool: set assessment.id to
		 * the existing learn_module.id. The merge + `enforceConnectIds`
		 * reserve every stated identity before deriving omissions, so the
		 * duplicate rejects independently of block order → `{ error }`, zero
		 * mutations, nothing written. */
		const doc = makeDocWithFullConnect();
		const h = makeToolWorkspaceHarness(doc);
		const result = await h.runTool(updateFormTool, {
			moduleUuid: MOD_A,
			formUuid: FORM_A,
			// learn_module already has id "patient_module" on this form.
			connect: {
				assessment: { id: "patient_module", user_score: xp("100") },
			},
		} satisfies UpdateFormInput);
		expect(result.mutations).toEqual([]);
		expect(result.result).toHaveProperty("error");
		expect((result.result as { error: string }).error).toContain(
			"patient_module",
		);
	});

	it("refuses to add a new participant through the single-form edit tool", async () => {
		const base = makeDeliverParticipantDoc();
		const doc: BlueprintDoc = {
			...base,
			forms: {
				...base.forms,
				[FORM_A]: { ...base.forms[FORM_A], connect: undefined } as Form,
			},
		};
		const h = makeToolWorkspaceHarness(doc);
		const result = await h.runTool(updateFormTool, {
			moduleUuid: MOD_A,
			formUuid: FORM_A,
			connect: { deliver_unit: { name: "Vendor visit" } },
		} satisfies UpdateFormInput);
		expect(result.mutations).toEqual([]);
		expect(result.result).toEqual({
			error: expect.stringContaining("configureConnect/configure_connect"),
		});
	});
});

// ── updateForm deliver_unit ───────────────────────────────────────────

/**
 * Build an existing Deliver participant. `update_form` may refine this one
 * participant, while the app-wide configure tool alone changes membership.
 * The seed omits `entity_id` / `entity_name` so the assertions below pin that
 * a partial refinement does not invent either wire-defaulted slot.
 */
function makeDeliverParticipantDoc(): BlueprintDoc {
	const doc = makeFixtureDoc();
	return {
		...doc,
		connectType: "deliver",
		forms: {
			...doc.forms,
			[FORM_A]: {
				...doc.forms[FORM_A],
				connect: {
					deliver_unit: { id: "patient", name: "Initial delivery" },
				},
			} as Form,
		},
	};
}

describe("updateFormTool deliver_unit", () => {
	it("preserves the participant id; no entity_id/entity_name injected", async () => {
		/* A partial edit keeps the existing final id. `entity_id` /
		 * `entity_name` are NOT injected — those are absent on the input and
		 * remain absent (the XForm builder
		 * substitutes the canonical defaults at emit time; writing empties at
		 * the agent layer would produce `<bind … calculate=""/>` which CCHQ
		 * rejects). */
		const doc = makeDeliverParticipantDoc();
		const h = makeToolWorkspaceHarness(doc);

		const result = await h.runTool(updateFormTool, {
			moduleUuid: MOD_A,
			formUuid: FORM_A,
			connect: {
				deliver_unit: { name: "Vendor visit" },
			},
		} satisfies UpdateFormInput);

		expect(result.mutations).toHaveLength(1);
		const finalForm = h.currentDoc().forms[FORM_A];
		expect(requireDeliverConnect(finalForm?.connect).deliver_unit).toEqual({
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
		const docBase = makeDeliverParticipantDoc();
		const seeded: BlueprintDoc = {
			...docBase,
			forms: {
				[FORM_A]: {
					...docBase.forms[FORM_A],
					connect: {
						deliver_unit: {
							id: "vendor_visit",
							name: "Vendor visit",
							entity_id: xp("concat('vendor-', uuid())"),
							entity_name: xp("'Vendor'"),
						},
					},
				} as Form,
			},
		};
		const h = makeToolWorkspaceHarness(seeded);

		const result = await h.runTool(updateFormTool, {
			moduleUuid: MOD_A,
			formUuid: FORM_A,
			connect: {
				deliver_unit: { name: "Vendor visit (updated)" },
			},
		} satisfies UpdateFormInput);

		expect(result.result).not.toHaveProperty("error");
		const finalDoc = h.currentDoc();
		const finalForm = finalDoc.forms[FORM_A];
		expect(
			requireDeliverConnect(finalForm?.connect).deliver_unit,
		).toMatchObject({
			id: "vendor_visit",
			name: "Vendor visit (updated)",
		});
		expect(
			finalForm &&
				formExpressionSource(finalForm, "deliver_entity_id", finalDoc),
		).toBe("concat('vendor-', uuid())");
		expect(
			finalForm &&
				formExpressionSource(finalForm, "deliver_entity_name", finalDoc),
		).toBe("'Vendor'");
	});

	it("accepts SA-supplied entity_id and entity_name and lands them on the doc verbatim", async () => {
		/* The schema exposes entity_id and entity_name as optional
		 * inputs so the SA can override the wire defaults for
		 * workflows that need a different dedup key — case-based
		 * deliveries (`#patient/case_id`), per-beneficiary deliveries,
		 * site-keyed deliveries, etc. The SA's expression must reach
		 * the doc verbatim; the wire emitter's `||` fallback only
		 * activates on absence/empty, so a non-empty SA value wins. */
		const registrationDoc = makeDeliverParticipantDoc();
		const doc: BlueprintDoc = {
			...registrationDoc,
			forms: {
				...registrationDoc.forms,
				[FORM_A]: {
					...registrationDoc.forms[FORM_A],
					type: "followup",
				} as Form,
			},
		};
		const h = makeToolWorkspaceHarness(doc);

		const result = await h.runTool(updateFormTool, {
			moduleUuid: MOD_A,
			formUuid: FORM_A,
			connect: {
				deliver_unit: {
					name: "Beneficiary visit",
					entity_id: xpIn(doc, FORM_A, "#form/case_name"),
					entity_name: xpIn(doc, FORM_A, "#form/case_name"),
				},
			},
		} satisfies UpdateFormInput);

		expect(result.result).not.toHaveProperty("error");
		const finalDoc = h.currentDoc();
		const finalForm = finalDoc.forms[FORM_A];
		expect(
			requireDeliverConnect(finalForm?.connect).deliver_unit,
		).toMatchObject({
			id: "patient",
			name: "Beneficiary visit",
		});
		expect(
			finalForm &&
				formExpressionSource(finalForm, "deliver_entity_id", finalDoc),
		).toBe("#form/case_name");
		expect(
			finalForm &&
				formExpressionSource(finalForm, "deliver_entity_name", finalDoc),
		).toBe("#form/case_name");
	});

	it("schema accepts a partial deliver_unit with only entity_id set (entity_name still falls through to wire default)", async () => {
		/* Partial-override case: SA wants a custom dedup key but is
		 * fine with the default display label. Both fields are
		 * independently optional; setting one doesn't force the
		 * other. */
		const doc = makeDeliverParticipantDoc();
		const h = makeToolWorkspaceHarness(doc);

		const result = await h.runTool(updateFormTool, {
			moduleUuid: MOD_A,
			formUuid: FORM_A,
			connect: {
				deliver_unit: {
					name: "Site visit",
					entity_id: xpIn(doc, FORM_A, "#form/case_name"),
				},
			},
		} satisfies UpdateFormInput);

		expect(result.result).not.toHaveProperty("error");
		const finalDoc = h.currentDoc();
		const finalForm = finalDoc.forms[FORM_A];
		expect(
			requireDeliverConnect(finalForm?.connect).deliver_unit,
		).toMatchObject({
			id: "patient",
			name: "Site visit",
		});
		expect(
			finalForm &&
				formExpressionSource(finalForm, "deliver_entity_id", finalDoc),
		).toBe("#form/case_name");
		expect(
			requireDeliverConnect(finalForm?.connect).deliver_unit?.entity_name,
		).toBeUndefined();
	});
});
