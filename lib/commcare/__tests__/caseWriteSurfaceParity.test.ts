import { describe, expect, it, vi } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import {
	makeMcpTestContext,
	makeToolWorkspaceHarness,
} from "@/lib/agent/__tests__/fixtures";
import { editFieldTool } from "@/lib/agent/tools/editField";
import { CanonicalMutationWorkspace } from "@/lib/agent/workspace/canonicalWorkspace";
import {
	assertAndProjectCaseWriteInventory,
	caseWriteAdmissionIssues,
} from "@/lib/commcare/caseWriteAdmission";
import { buildFormActions } from "@/lib/commcare/formActions";
import type { AttachmentUrlTarget } from "@/lib/commcare/xform/captureUrlNode";
import { caseWriteChoiceVerdict } from "@/lib/doc/caseWriteChoices";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	type CaptureCaseWrite,
	type CaseWrite,
	caseWriteSchema,
	deriveCaseWriteInventory,
	FORBIDDEN_CASE_WRITE_PROPERTIES,
	type FormType,
	proseText,
	WRITABLE_STANDARD_CASE_PROPERTIES,
} from "@/lib/domain";
import { FormEngine } from "@/lib/preview/engine/formEngine";
import { runValidation } from "../validator/runner";

vi.mock("@/lib/db/apps", () => ({
	completeApp: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/lib/db/applyBlueprintChange", () => ({
	applyBlueprintChange: vi.fn(async (args) => {
		const { commitApplyBlueprintChangeTestBatch } = await import(
			"@/lib/db/__tests__/applyBlueprintChangeTestWriter"
		);
		return commitApplyBlueprintChangeTestBatch(args);
	}),
}));

const CASE_TYPES = [
	{
		name: "household",
		properties: [{ name: "case_name", label: proseText("Name") }],
	},
	{
		name: "patient",
		parent_type: "household",
		properties: [{ name: "case_name", label: proseText("Name") }],
	},
	{
		name: "sibling",
		parent_type: "household",
		properties: [{ name: "case_name", label: proseText("Name") }],
	},
	{
		name: "child",
		parent_type: "patient",
		properties: [{ name: "case_name", label: proseText("Name") }],
	},
	{
		name: "grandchild",
		parent_type: "child",
		properties: [{ name: "case_name", label: proseText("Name") }],
	},
	{
		name: "unrelated",
		properties: [{ name: "case_name", label: proseText("Name") }],
	},
];

function fixture(
	destination: string | undefined,
	options: {
		formType?: FormType;
		moduleCaseType?: string;
		ancestorId?: string;
		property?: string;
	} = {},
) {
	const formType = options.formType ?? "followup";
	const moduleCaseType =
		"moduleCaseType" in options ? options.moduleCaseType : "patient";
	const writer = f({
		kind: "text",
		id: "friendly_name",
		label: proseText("Name"),
		...(destination !== undefined && {
			caseWrite: {
				caseType: destination,
				property: options.property ?? "case_name",
			},
		}),
	});
	const fields =
		options.ancestorId === undefined
			? [writer]
			: [
					f({
						kind: "group",
						id: options.ancestorId,
						label: proseText("Section"),
						children: [writer],
					}),
				];
	const doc = buildDoc({
		appName: "Case write parity",
		caseTypes: CASE_TYPES,
		modules: [
			{
				name: "Patients",
				...(moduleCaseType !== undefined && { caseType: moduleCaseType }),
				...(moduleCaseType !== undefined && {
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
				}),
				forms: [{ name: "Form", type: formType, fields }],
			},
			...["sibling", "child", "grandchild"].map((caseType) => ({
				name: `${caseType} cases`,
				caseType,
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						name: `${caseType} notes`,
						type: "survey" as const,
						fields: [f({ kind: "text", id: `${caseType}_notes` })],
					},
				],
			})),
		],
	});
	const moduleUuid = doc.moduleOrder[0];
	const formUuid = doc.formOrder[moduleUuid][0];
	const inventory = deriveCaseWriteInventory(
		doc,
		formUuid,
		{ caseType: moduleCaseType },
		formType,
	);
	const engine = new FormEngine(
		{
			form: doc.forms[formUuid],
			formUuid,
			fields: doc.fields,
			fieldOrder: doc.fieldOrder,
			caseTypes: CASE_TYPES,
		},
		moduleCaseType,
	);
	if (destination !== undefined) {
		engine.setValue(
			options.ancestorId === undefined
				? "/data/friendly_name"
				: `/data/${options.ancestorId}/friendly_name`,
			"Amina",
		);
	}
	return { doc, moduleUuid, formUuid, inventory, engine };
}

describe("canonical case-write surface parity", () => {
	it.each([
		{
			label: "parent",
			destination: "household",
			issue: "destination-not-direct-child",
			code: "CASE_WRITE_NOT_DIRECT_CHILD",
		},
		{
			label: "sibling",
			destination: "sibling",
			issue: "destination-not-direct-child",
			code: "CASE_WRITE_NOT_DIRECT_CHILD",
		},
		{
			label: "grandchild",
			destination: "grandchild",
			issue: "destination-not-direct-child",
			code: "CASE_WRITE_NOT_DIRECT_CHILD",
		},
		{
			label: "unrelated",
			destination: "unrelated",
			issue: "destination-not-direct-child",
			code: "CASE_WRITE_NOT_DIRECT_CHILD",
		},
		{
			label: "unknown",
			destination: "missing",
			issue: "destination-type-unknown",
			code: "CASE_WRITE_UNKNOWN_TYPE",
		},
	] as const)(
		"rejects a $label destination identically in inventory, gate, wire, and Preview",
		({ destination, issue, code }) => {
			const built = fixture(destination);
			expect(caseWriteAdmissionIssues(built.inventory)[0]?.kind).toBe(issue);
			expect(
				runValidation(built.doc, LOOKUP_CONTEXT_UNAVAILABLE).map(
					(finding) => finding.code,
				),
			).toContain(code);
			expect(() =>
				buildFormActions(built.doc, built.formUuid, "patient"),
			).toThrow();
			expect(() =>
				built.engine.computeSubmissionMutation({
					caseId: "patient-1",
					entryKey: "11111111-1111-4111-8111-111111111111",
				}),
			).toThrow();
		},
	);

	it("rejects blank destination members at the shared builder/SA/MCP schema boundary", () => {
		expect(
			caseWriteSchema.safeParse({ caseType: "", property: "case_name" })
				.success,
		).toBe(false);
		expect(
			caseWriteSchema.safeParse({ caseType: "patient", property: "" }).success,
		).toBe(false);
	});

	it.each([...FORBIDDEN_CASE_WRITE_PROPERTIES])(
		"rejects the field write destination %s at the shared gate and every downstream boundary",
		(property) => {
			const built = fixture("patient", { property });
			expect(caseWriteAdmissionIssues(built.inventory)).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						kind: "reserved-property",
						writer: expect.objectContaining({ property }),
					}),
				]),
			);
			expect(
				runValidation(built.doc, LOOKUP_CONTEXT_UNAVAILABLE).map(
					(finding) => finding.code,
				),
			).toContain("RESERVED_CASE_PROPERTY");
			expect(() =>
				buildFormActions(built.doc, built.formUuid, "patient"),
			).toThrow();
			expect(() =>
				built.engine.computeSubmissionMutation({
					caseId: "patient-1",
					entryKey: "11111111-1111-4111-8111-111111111111",
				}),
			).toThrow();
		},
	);

	it.each([...WRITABLE_STANDARD_CASE_PROPERTIES])(
		"admits the ordinary standard-scalar field destination %s",
		(property) => {
			const built = fixture("patient", { property });
			expect(caseWriteAdmissionIssues(built.inventory)).toEqual([]);
			expect(
				runValidation(built.doc, LOOKUP_CONTEXT_UNAVAILABLE)
					.filter((finding) => finding.code.startsWith("CASE_WRITE_"))
					.map((finding) => finding.code),
			).toEqual([]);
		},
	);

	it("routes an active blank external_id field to the scalar slot, never JSONB", () => {
		const built = fixture("patient", { property: "external_id" });
		built.engine.setValue("/data/friendly_name", "");

		const actions = buildFormActions(built.doc, built.formUuid, "patient");
		expect(actions.update_case.update.external_id).toMatchObject({
			question_path: "/data/friendly_name",
			update_mode: "always",
		});

		const mutation = built.engine.computeSubmissionMutation({
			caseId: "patient-1",
			entryKey: "11111111-1111-4111-8111-111111111111",
		});
		expect(mutation.kind).toBe("followup");
		if (mutation.kind !== "followup") return;
		expect(mutation.patch).toEqual({
			externalId: "",
			properties: {},
		});
		expect(mutation.patch.properties).not.toHaveProperty("external_id");
	});

	it("normalizes an ordinary case_name field through its scalar slot", () => {
		const built = fixture("patient", { property: "case_name" });
		built.engine.setValue(
			"/data/friendly_name",
			"\u0000\u0020 Alice B. \u001f",
		);

		const mutation = built.engine.computeSubmissionMutation({
			caseId: "patient-1",
			entryKey: "11111111-1111-4111-8111-111111111111",
		});
		expect(mutation.kind).toBe("followup");
		if (mutation.kind !== "followup") return;
		expect(mutation.patch).toEqual({
			caseName: "Alice B.",
			properties: {},
		});
		expect(mutation.patch.properties).not.toHaveProperty("case_name");
	});

	it("rejects an ordinary scalar field longer than 255 UTF-16 units", () => {
		const built = fixture("patient", { property: "external_id" });
		built.engine.setValue("/data/friendly_name", "😀".repeat(128));

		expect(() =>
			built.engine.computeSubmissionMutation({
				caseId: "patient-1",
				entryKey: "11111111-1111-4111-8111-111111111111",
			}),
		).toThrow(/longer than 255 UTF-16 code units/);
	});

	it("routes a child external_id through the child scalar slot, never its JSONB document", () => {
		const doc = buildDoc({
			appName: "Child external ID",
			caseTypes: CASE_TYPES,
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					forms: [
						{
							name: "Register",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "patient_name",
									caseWrite: {
										caseType: "patient",
										property: "case_name",
									},
								}),
								f({
									kind: "group",
									id: "child",
									children: [
										f({
											kind: "text",
											id: "child_name",
											caseWrite: {
												caseType: "child",
												property: "case_name",
											},
										}),
										f({
											kind: "text",
											id: "child_external",
											caseWrite: {
												caseType: "child",
												property: "external_id",
											},
										}),
									],
								}),
							],
						},
					],
				},
			],
		});
		const moduleUuid = doc.moduleOrder[0];
		const formUuid = doc.formOrder[moduleUuid][0];
		const actions = buildFormActions(doc, formUuid, "patient");
		expect(actions.subcases[0]?.case_properties.external_id).toMatchObject({
			question_path: "/data/child/child_external",
			update_mode: "always",
		});

		const engine = new FormEngine(
			{
				form: doc.forms[formUuid],
				formUuid,
				fields: doc.fields,
				fieldOrder: doc.fieldOrder,
				caseTypes: CASE_TYPES,
			},
			"patient",
		);
		engine.setValue("/data/patient_name", "Patient");
		engine.setValue("/data/child/child_name", "Child");
		engine.setValue("/data/child/child_external", "  CHILD-1  ");
		const mutation = engine.computeSubmissionMutation({
			entryKey: "11111111-1111-4111-8111-111111111111",
		});
		expect(mutation.kind).toBe("registration");
		if (mutation.kind !== "registration") return;
		expect(mutation.children[0]).toMatchObject({
			caseName: "Child",
			externalId: "CHILD-1",
			properties: {},
		});
		expect(mutation.children[0]?.properties).not.toHaveProperty("external_id");
	});

	it("preserves external_id when its source node is absent or irrelevant", () => {
		const doc = buildDoc({
			appName: "Dormant external ID",
			caseTypes: CASE_TYPES,
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					forms: [
						{
							name: "Follow up",
							type: "followup",
							fields: [
								f({
									kind: "text",
									id: "show",
									label: proseText("Show"),
								}),
								f({
									kind: "text",
									id: "external_code",
									label: proseText("External code"),
									relevant: "#form/show = 'yes'",
									caseWrite: {
										caseType: "patient",
										property: "external_id",
									},
								}),
							],
						},
					],
				},
			],
		});
		const moduleUuid = doc.moduleOrder[0];
		const formUuid = doc.formOrder[moduleUuid][0];
		const engine = new FormEngine(
			{
				form: doc.forms[formUuid],
				formUuid,
				fields: doc.fields,
				fieldOrder: doc.fieldOrder,
				caseTypes: CASE_TYPES,
			},
			"patient",
		);
		engine.setValue("/data/show", "yes");
		engine.setValue("/data/external_code", "remembered");
		engine.setValue("/data/show", "no");

		const mutation = engine.computeSubmissionMutation({
			caseId: "patient-1",
			entryKey: "11111111-1111-4111-8111-111111111111",
		});
		expect(mutation.kind).toBe("followup");
		if (mutation.kind !== "followup") return;
		expect(mutation.patch).toEqual({ properties: {} });
	});

	it("rejects every forbidden field-write property through builder, SA, and MCP admission", async () => {
		const built = fixture(undefined);
		const field = Object.values(built.doc.fields).find(
			(candidate) => candidate.id === "friendly_name",
		);
		if (field === undefined) throw new Error("fixture writer is missing");

		for (const property of FORBIDDEN_CASE_WRITE_PROPERTIES) {
			const caseWrite = { caseType: "patient", property } as CaseWrite;
			const input = {
				moduleUuid: built.moduleUuid,
				formUuid: built.formUuid,
				fieldUuid: field.uuid,
				updates: { kind: "text" as const, caseWrite },
			};
			const parsed = editFieldTool.inputSchema.safeParse(input);
			if (!parsed.success) {
				// The retired `name` spelling is rejected by the shared authored
				// property schema one boundary before the contextual gate.
				expect(property).toBe("name");
				continue;
			}
			expect(
				caseWriteChoiceVerdict(
					built.doc,
					field,
					caseWrite,
					LOOKUP_CONTEXT_UNAVAILABLE,
				).ok,
			).toBe(false);

			const sa = await makeToolWorkspaceHarness(built.doc).runTool(
				editFieldTool,
				input,
			);
			expect("error" in sa.result, `SA accepted ${property}`).toBe(true);

			const mcp = await new CanonicalMutationWorkspace({
				host: makeMcpTestContext({ initialDoc: built.doc }).ctx,
				initialDoc: built.doc,
			}).invoke({
				toolName: "edit_field",
				execute: (invocationCtx) =>
					editFieldTool.execute(input as never, invocationCtx),
			});
			expect("error" in mcp.result, `MCP accepted ${property}`).toBe(true);
		}
	});

	it.each([
		{
			label: "own type",
			destination: "patient",
			options: {},
			accepted: true,
		},
		{
			label: "exact direct child",
			destination: "child",
			options: {},
			accepted: true,
		},
		{
			label: "parent",
			destination: "household",
			options: {},
			accepted: false,
		},
		{
			label: "sibling",
			destination: "sibling",
			options: {},
			accepted: false,
		},
		{
			label: "grandchild",
			destination: "grandchild",
			options: {},
			accepted: false,
		},
		{
			label: "unrelated",
			destination: "unrelated",
			options: {},
			accepted: false,
		},
		{
			label: "unknown",
			destination: "missing",
			options: {},
			accepted: false,
		},
		{
			label: "blank",
			destination: "",
			options: {},
			accepted: false,
		},
		{
			label: "module-less",
			destination: "patient",
			options: { moduleCaseType: undefined },
			accepted: false,
		},
		{
			label: "survey/no-action",
			destination: "patient",
			options: { formType: "survey" as const },
			accepted: false,
		},
	] as const)(
		"keeps builder, SA, and MCP admission identical for $label",
		async ({ destination, options, accepted }) => {
			const built = fixture(undefined, options);
			const field = Object.values(built.doc.fields).find(
				(candidate) => candidate.id === "friendly_name",
			);
			if (field === undefined) throw new Error("fixture writer is missing");
			const caseWrite = {
				caseType: destination,
				property: "case_name",
			} as CaseWrite;

			// The builder's Saves-to picker runs the exact prospective mutation
			// through the commit gate. A blank pair is stopped one boundary
			// earlier by the same schema the SA and MCP publish.
			if (destination === "") {
				expect(caseWriteSchema.safeParse(caseWrite).success).toBe(false);
				expect(
					editFieldTool.inputSchema.safeParse({
						moduleUuid: built.moduleUuid,
						formUuid: built.formUuid,
						fieldUuid: field.uuid,
						updates: { kind: "text", caseWrite },
					}).success,
				).toBe(false);
				return;
			}
			expect(
				caseWriteChoiceVerdict(
					built.doc,
					field,
					caseWrite,
					LOOKUP_CONTEXT_UNAVAILABLE,
				).ok,
			).toBe(accepted);

			const input = {
				moduleUuid: built.moduleUuid,
				formUuid: built.formUuid,
				fieldUuid: field.uuid,
				updates: { kind: "text" as const, caseWrite },
			};
			expect(editFieldTool.inputSchema.safeParse(input).success).toBe(true);

			const sa = await makeToolWorkspaceHarness(built.doc).runTool(
				editFieldTool,
				input,
			);
			expect("message" in sa.result).toBe(accepted);
			expect("error" in sa.result).toBe(!accepted);

			const mcp = await new CanonicalMutationWorkspace({
				host: makeMcpTestContext({ initialDoc: built.doc }).ctx,
				initialDoc: built.doc,
			}).invoke({
				toolName: "edit_field",
				execute: (invocationCtx) =>
					editFieldTool.execute(input as never, invocationCtx),
			});
			expect("message" in mcp.result).toBe(accepted);
			expect("error" in mcp.result).toBe(!accepted);
		},
	);

	it.each([
		{
			label: "module-less",
			options: { moduleCaseType: undefined },
		},
		{
			label: "survey",
			options: { formType: "survey" as const },
		},
	])(
		"rejects a writer on a $label form identically across surfaces",
		({ options }) => {
			const built = fixture("patient", options);
			expect(caseWriteAdmissionIssues(built.inventory)[0]?.kind).toBe(
				"no-case-action",
			);
			expect(
				runValidation(built.doc, LOOKUP_CONTEXT_UNAVAILABLE).map(
					(finding) => finding.code,
				),
			).toContain("CASE_WRITE_NO_CASE_ACTION");
			expect(() =>
				buildFormActions(built.doc, built.formUuid, options.moduleCaseType),
			).toThrow();
			expect(() =>
				built.engine.computeSubmissionMutation({
					entryKey: "11111111-1111-4111-8111-111111111111",
				}),
			).toThrow();
		},
	);

	it.each([
		{ label: "own update", destination: "patient", child: false },
		{ label: "exact direct child", destination: "child", child: true },
	])(
		"admits an $label through the same inventory in wire and Preview",
		({ destination, child }) => {
			const built = fixture(destination);
			const projected = assertAndProjectCaseWriteInventory(built.inventory);
			expect(
				projected.buckets.flatMap((bucket) => bucket.writers),
			).toHaveLength(1);
			expect(
				runValidation(built.doc, LOOKUP_CONTEXT_UNAVAILABLE).filter((finding) =>
					finding.code.startsWith("CASE_WRITE_"),
				),
			).toEqual([]);
			const actions = buildFormActions(built.doc, built.formUuid, "patient");
			expect(actions.subcases.length > 0).toBe(child);
			const mutation = built.engine.computeSubmissionMutation({
				caseId: "patient-1",
				entryKey: "11111111-1111-4111-8111-111111111111",
			});
			expect(mutation.kind).toBe("followup");
			if (mutation.kind !== "followup") return;
			expect(mutation.children.length > 0).toBe(child);
		},
	);

	it("projects one nested writer and its nearest repeat identically across builder, validator, wire, and Preview", () => {
		const doc = buildDoc({
			appName: "Nested case-write parity",
			caseTypes: CASE_TYPES,
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							name: "Follow up",
							type: "followup",
							fields: [
								f({
									kind: "group",
									id: "outer",
									children: [
										f({
											kind: "repeat",
											id: "rows",
											repeat_mode: "query_bound",
											data_source: {
												ids_query: "instance('casedb')/casedb/case",
											},
											children: [
												f({
													kind: "group",
													id: "details",
													children: [
														f({
															kind: "repeat",
															id: "children",
															repeat_mode: "user_controlled",
															children: [
																f({
																	kind: "text",
																	id: "friendly_name",
																	caseWrite: {
																		caseType: "child",
																		property: "case_name",
																	},
																}),
															],
														}),
													],
												}),
											],
										}),
									],
								}),
							],
						},
					],
				},
				...["sibling", "child", "grandchild"].map((caseType) => ({
					name: `${caseType} cases`,
					caseType,
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							name: `${caseType} notes`,
							type: "survey" as const,
							fields: [f({ kind: "text", id: `${caseType}_notes` })],
						},
					],
				})),
			],
		});
		const moduleUuid = doc.moduleOrder[0];
		const formUuid = doc.formOrder[moduleUuid][0];
		const byId = new Map(
			Object.values(doc.fields).map((field) => [field.id, field]),
		);
		const outer = byId.get("outer");
		const rows = byId.get("rows");
		const details = byId.get("details");
		const children = byId.get("children");
		const writerField = byId.get("friendly_name");
		if (!outer || !rows || !details || !children || !writerField) {
			throw new Error("nested parity fixture is incomplete");
		}

		const inventory = deriveCaseWriteInventory(
			doc,
			formUuid,
			{ caseType: "patient" },
			"followup",
		);
		expect(inventory.writers).toHaveLength(1);
		const writer = inventory.writers[0];
		expect(writer).toMatchObject({
			fieldUuid: writerField.uuid,
			fieldId: "friendly_name",
			repeatUuid: children.uuid,
			repeatId: "children",
		});
		expect(writer.path).toEqual([
			{
				fieldUuid: outer.uuid,
				fieldId: "outer",
				queryBoundIteration: false,
			},
			{
				fieldUuid: rows.uuid,
				fieldId: "rows",
				queryBoundIteration: true,
			},
			{
				fieldUuid: details.uuid,
				fieldId: "details",
				queryBoundIteration: false,
			},
			{
				fieldUuid: children.uuid,
				fieldId: "children",
				queryBoundIteration: false,
			},
			{
				fieldUuid: writerField.uuid,
				fieldId: "friendly_name",
				queryBoundIteration: false,
			},
		]);
		expect(writer.repeatPath).toEqual(writer.path.slice(0, -1));

		const projected = assertAndProjectCaseWriteInventory(inventory);
		const projectedWriter = projected.writerByUuid.get(writerField.uuid);
		expect(projectedWriter?.path.toXPath()).toBe(
			"/data/outer/rows/item/details/children/friendly_name",
		);
		const childBucket = projected.buckets.find(
			(candidate) => candidate.bucket.kind === "child",
		);
		expect(childBucket?.bucket.repeatUuid).toBe(children.uuid);
		expect(childBucket?.bucket.repeatId).toBe("children");
		expect(childBucket?.repeatPath?.toXPath()).toBe(
			"/data/outer/rows/item/details/children",
		);

		expect(
			caseWriteChoiceVerdict(
				doc,
				writerField,
				{ caseType: "child", property: "case_name" },
				LOOKUP_CONTEXT_UNAVAILABLE,
			),
		).toEqual({ ok: true });
		expect(
			runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter((finding) =>
				finding.code.startsWith("CASE_WRITE_"),
			),
		).toEqual([]);
		const actions = buildFormActions(doc, formUuid, "patient");
		expect(actions.subcases).toHaveLength(1);
		expect(actions.subcases[0]?.repeat_context).toBe(
			"/data/outer/rows/item/details/children",
		);

		const engine = new FormEngine(
			{
				form: doc.forms[formUuid],
				formUuid,
				fields: doc.fields,
				fieldOrder: doc.fieldOrder,
				caseTypes: CASE_TYPES,
			},
			"patient",
		);
		engine.setValue(
			"/data/outer/rows[0]/details/children[0]/friendly_name",
			"Amina",
		);
		const mutation = engine.computeSubmissionMutation({
			caseId: "patient-1",
			entryKey: "11111111-1111-4111-8111-111111111111",
		});
		expect(mutation.kind).toBe("followup");
		if (mutation.kind !== "followup") return;
		expect(mutation.children).toHaveLength(1);
		expect(mutation.children[0]).toMatchObject({
			caseType: "child",
			caseName: "Amina",
			properties: {},
		});
	});

	it("keeps INVALID_FIELD_ID as the only authoring finding while every lowering/runtime path rejects the same XML-illegal ancestor", () => {
		const built = fixture("patient", { ancestorId: "bad-id" });
		expect(caseWriteAdmissionIssues(built.inventory)).toEqual([]);
		const findings = runValidation(
			built.doc,
			LOOKUP_CONTEXT_UNAVAILABLE,
		).filter(
			(finding) =>
				finding.code === "INVALID_FIELD_ID" ||
				finding.code.startsWith("CASE_WRITE_"),
		);
		expect(findings.map((finding) => finding.code)).toEqual([
			"INVALID_FIELD_ID",
		]);
		expect(() => assertAndProjectCaseWriteInventory(built.inventory)).toThrow(
			/invalid element name "bad-id"/,
		);
		expect(() =>
			buildFormActions(built.doc, built.formUuid, "patient"),
		).toThrow(/invalid element name "bad-id"/);
		expect(() =>
			built.engine.computeSubmissionMutation({
				caseId: "patient-1",
				entryKey: "11111111-1111-4111-8111-111111111111",
			}),
		).toThrow(/invalid element name "bad-id"/);
	});
});
/**
 * A capture writer is the one destination whose wire spelling is not the
 * field's own node, so the surfaces have a fresh way to disagree: the
 * validator could admit it, the emitter could point at the upload, and
 * Preview could invent an address none of them can resolve. This block
 * holds all three to the same answer.
 */
describe("capture case-write surface parity", () => {
	const CAPTURE_CASE_TYPES = [
		{
			name: "patient",
			properties: [
				{ name: "case_name", label: proseText("Name") },
				{ name: "photo_url", label: proseText("Photo") },
			],
		},
	];

	const TARGET: AttachmentUrlTarget = {
		origin: "https://www.commcarehq.org",
		domain: "demo-project",
	};

	function captureFixture(caseWrite?: CaptureCaseWrite) {
		const doc = buildDoc({
			appName: "Capture case-write parity",
			caseTypes: CAPTURE_CASE_TYPES,
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							name: "Visit",
							type: "followup",
							fields: [
								f({
									kind: "image",
									id: "photo",
									label: proseText("Photo"),
									...(caseWrite !== undefined && { caseWrite }),
								}),
							],
						},
					],
				},
			],
		});
		const moduleUuid = doc.moduleOrder[0];
		const formUuid = doc.formOrder[moduleUuid][0];
		const field = Object.values(doc.fields).find(
			(candidate) => candidate.id === "photo",
		);
		if (field === undefined)
			throw new Error("capture fixture writer is missing");
		const inventory = deriveCaseWriteInventory(
			doc,
			formUuid,
			{ caseType: "patient" },
			"followup",
		);
		const engine = new FormEngine(
			{
				form: doc.forms[formUuid],
				formUuid,
				fields: doc.fields,
				fieldOrder: doc.fieldOrder,
				caseTypes: CAPTURE_CASE_TYPES,
			},
			"patient",
		);
		// The answer a capture carries is the submitted file's name, which is
		// also the last segment of the address the case property stores.
		engine.setValue("/data/photo", "24b0f1e8-6f66-4a2e-9f2f-9a5b0c1d2e3f.jpg");
		return { doc, moduleUuid, formUuid, field, inventory, engine };
	}

	it("admits a capture saving to its own property across builder, SA, and MCP", async () => {
		const caseWrite: CaptureCaseWrite = {
			caseType: "patient",
			property: "photo_url",
			mode: "url",
		};
		const built = captureFixture(caseWrite);
		expect(caseWriteAdmissionIssues(built.inventory)).toEqual([]);
		expect(
			runValidation(built.doc, LOOKUP_CONTEXT_UNAVAILABLE)
				.map((finding) => finding.code)
				.filter(
					(code) =>
						code.startsWith("CASE_WRITE_") || code.startsWith("CAPTURE_"),
				),
		).toEqual([]);

		const unset = captureFixture();
		expect(
			caseWriteChoiceVerdict(
				unset.doc,
				unset.field,
				caseWrite,
				LOOKUP_CONTEXT_UNAVAILABLE,
			),
		).toEqual({ ok: true });

		const input = {
			moduleUuid: unset.moduleUuid,
			formUuid: unset.formUuid,
			fieldUuid: unset.field.uuid,
			updates: { kind: "image" as const, caseWrite },
		};
		expect(editFieldTool.inputSchema.safeParse(input).success).toBe(true);

		const sa = await makeToolWorkspaceHarness(unset.doc).runTool(
			editFieldTool,
			input,
		);
		expect("message" in sa.result).toBe(true);

		const mcp = await new CanonicalMutationWorkspace({
			host: makeMcpTestContext({ initialDoc: unset.doc }).ctx,
			initialDoc: unset.doc,
		}).invoke({
			toolName: "edit_field",
			execute: (invocationCtx) =>
				editFieldTool.execute(input as never, invocationCtx),
		});
		expect("message" in mcp.result).toBe(true);
	});

	it("names the address node on the wire and writes nothing in Preview", () => {
		const built = captureFixture({
			caseType: "patient",
			property: "photo_url",
			mode: "url",
		});

		expect(
			buildFormActions(built.doc, built.formUuid, "patient", TARGET).update_case
				.update.photo_url,
		).toEqual({
			question_path: "/data/__nova_url_photo",
			update_mode: "always",
		});
		// No CommCare HQ project space holds this app, so there is no origin to
		// build an address from and the property is left unwritten rather than
		// written against a guess.
		expect(
			buildFormActions(built.doc, built.formUuid, "patient").update_case.update
				.photo_url,
		).toBeUndefined();

		// Preview runs on Nova's own case rows, where the submission the
		// address would name does not exist. It declines to invent one.
		const mutation = built.engine.computeSubmissionMutation({
			caseId: "patient-1",
			entryKey: "11111111-1111-4111-8111-111111111111",
		});
		expect(mutation.kind).toBe("followup");
		if (mutation.kind !== "followup") return;
		expect(mutation.patch).toEqual({ properties: {} });
	});

	it.each([...WRITABLE_STANDARD_CASE_PROPERTIES])(
		"rejects a capture aimed at the standard property %s across every surface",
		async (property) => {
			const caseWrite: CaptureCaseWrite = {
				caseType: "patient",
				property,
				mode: "url",
			};
			const built = captureFixture(caseWrite);

			expect(caseWriteAdmissionIssues(built.inventory)).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						kind: "capture-standard-property",
						writer: expect.objectContaining({ property }),
					}),
				]),
			);
			expect(
				runValidation(built.doc, LOOKUP_CONTEXT_UNAVAILABLE).map(
					(finding) => finding.code,
				),
			).toContain("CAPTURE_CASE_WRITE_STANDARD_PROPERTY");
			expect(() =>
				buildFormActions(built.doc, built.formUuid, "patient", TARGET),
			).toThrow();
			expect(() =>
				built.engine.computeSubmissionMutation({
					caseId: "patient-1",
					entryKey: "11111111-1111-4111-8111-111111111111",
				}),
			).toThrow();

			const unset = captureFixture();
			expect(
				caseWriteChoiceVerdict(
					unset.doc,
					unset.field,
					caseWrite,
					LOOKUP_CONTEXT_UNAVAILABLE,
				).ok,
			).toBe(false);

			const input = {
				moduleUuid: unset.moduleUuid,
				formUuid: unset.formUuid,
				fieldUuid: unset.field.uuid,
				updates: { kind: "image" as const, caseWrite },
			};
			const sa = await makeToolWorkspaceHarness(unset.doc).runTool(
				editFieldTool,
				input,
			);
			expect("error" in sa.result, `SA accepted ${property}`).toBe(true);

			const mcp = await new CanonicalMutationWorkspace({
				host: makeMcpTestContext({ initialDoc: unset.doc }).ctx,
				initialDoc: unset.doc,
			}).invoke({
				toolName: "edit_field",
				execute: (invocationCtx) =>
					editFieldTool.execute(input as never, invocationCtx),
			});
			expect("error" in mcp.result, `MCP accepted ${property}`).toBe(true);
		},
	);
});
