/** Shared addFields and updateForm schema/handler behavior over an actual
 * canonical workspace. Persistence receipts are controlled; native SQL and
 * CommCare compatibility belong to their respective boundary suites. */

import { describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { type AddFieldsInput, addFieldsTool } from "../../tools/addFields";
import { CanonicalMutationWorkspace } from "../../workspace/canonicalWorkspace";
import { expectAdmittedDoc } from "../admittedFixture";
import {
	makeToolWorkspaceHarness as createToolHarness,
	makeMcpTestContext,
} from "../fixtures";

function makeToolWorkspaceHarness(doc: BlueprintDoc) {
	const harness = createToolHarness(expectAdmittedDoc(doc));
	return harness;
}

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
		connectRoles: [],
		appSettings: { showSavedForms: false, showIncompleteForms: false },
		caseTypes: [
			{
				name: "patient",
				properties: [],
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
/** Zod-compatible minimal `addFields` input for the cross-surface test.
 *  `kind` is narrowed to the literal `"date"` so the input type-checks
 *  against the tool's per-kind union — the schema rejects bare strings. */
const ADD_FIELDS_INPUT = {
	moduleUuid: MOD_A,
	formUuid: FORM_A,
	fields: [
		{
			id: "dob",
			fieldUuid: testUuid("receipt-date-of-birth"),
			kind: "date" as const,
			label: proseText("Date of birth"),
		},
	],
} satisfies AddFieldsInput;

// ── Cross-surface shared-tool smoke test ────────────────────────────────

describe("shared tool execution with controlled canonical host receipts", () => {
	it("a predeclared field keeps its exact identity through stub-host and McpContext commits", async () => {
		// Both paths run the actual workspace/tool, but persistence is controlled.
		// This proves receipt adoption, not HTTP adapter or database parity.
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
			execute: (ctx) =>
				addFieldsTool.execute(
					addFieldsTool.inputSchema.parse(ADD_FIELDS_INPUT),
					ctx,
				),
		});

		expect(chatResult.mutations).toEqual(mcpResult.mutations);
		const uuid = ADD_FIELDS_INPUT.fields[0].fieldUuid;
		expect(chat.currentDoc().fields[uuid]).toMatchObject({
			id: "dob",
			kind: "date",
			label: proseText("Date of birth"),
		});
		expect(mcpWorkspace.currentSnapshot().doc.fields[uuid]).toEqual(
			chat.currentDoc().fields[uuid],
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
