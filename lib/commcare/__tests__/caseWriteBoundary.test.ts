import { expect, it } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { makeToolWorkspaceHarness } from "@/lib/agent/__tests__/fixtures";
import { editFieldTool } from "@/lib/agent/tools/editField";
import { buildFormActions } from "@/lib/commcare/formActions";
import { runValidation } from "@/lib/commcare/validator/runner";
import {
	caseWriteCandidateMutations,
	caseWriteChoiceVerdict,
} from "@/lib/doc/caseWriteChoices";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	type BlueprintDoc,
	blueprintDocSchema,
	type CaptureCaseWrite,
	type CaseWrite,
	proseText,
} from "@/lib/domain";
import { FormEngine } from "@/lib/preview/engine/formEngine";

const ENTRY = "11111111-1111-4111-8111-111111111111";
const TARGET = { origin: "https://www.commcarehq.org", domain: "demo-project" };
const CASE_TYPES = [
	{ name: "household" },
	{ name: "patient", parent_type: "household" },
	{ name: "sibling", parent_type: "household" },
	{ name: "child", parent_type: "patient" },
	{ name: "grandchild", parent_type: "child" },
	{ name: "unrelated" },
].map((type) => ({
	...type,
	properties: [{ name: "case_name", label: proseText("Name") }],
}));

function valid(doc: BlueprintDoc) {
	expect(blueprintDocSchema.safeParse(toPersistableDoc(doc)).success).toBe(
		true,
	);
	expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
}
function fixture(
	options: {
		survey?: boolean;
		moduleless?: boolean;
		capture?: boolean;
		conditional?: boolean;
	} = {},
) {
	const doc = buildDoc({
		appName: "Case-write boundary",
		caseTypes: CASE_TYPES,
		modules: [
			{
				name: "Patients",
				...(!options.moduleless && {
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
				}),
				forms: [
					{
						name: "Visit",
						type: options.survey || options.moduleless ? "survey" : "followup",
						fields: [
							f({
								kind: options.capture ? "image" : "text",
								id: "answer",
								label: proseText("Answer"),
								...(options.conditional && {
									relevant: "#form/another = 'yes'",
								}),
							}),
							f({
								kind: "text",
								id: "another",
								label: proseText("Another answer"),
							}),
						],
					},
				],
			},
			...["sibling", "child", "grandchild"].map((caseType) => ({
				name: `${caseType} cases`,
				caseType,
				caseListOnly: true,
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [],
			})),
		],
	});
	valid(doc);
	const moduleUuid = doc.moduleOrder[0];
	const formUuid = doc.formOrder[moduleUuid][0];
	const field = doc.fields[doc.fieldOrder[formUuid][0]];
	return { doc, moduleUuid, formUuid, field };
}
function engine(
	doc: BlueprintDoc,
	formUuid: ReturnType<typeof fixture>["formUuid"],
) {
	return new FormEngine(
		{
			form: doc.forms[formUuid],
			formUuid,
			fields: doc.fields,
			fieldOrder: doc.fieldOrder,
			caseTypes: CASE_TYPES,
		},
		doc.modules[doc.moduleOrder[0]].caseType,
	);
}

// This is the shared tool body's admission boundary, used by SA and MCP. It
// neither simulates their transports nor replaces the database writer with a
// second implementation. The host records the admitted document only.
it.each([
	{ destination: "patient", accepted: true },
	{ destination: "child", accepted: true },
	{ destination: "household", accepted: false },
	{ destination: "sibling", accepted: false },
	{ destination: "grandchild", accepted: false },
	{ destination: "unrelated", accepted: false },
	{ destination: "missing", accepted: false },
	{ destination: "patient", survey: true, accepted: false },
	{ destination: "patient", moduleless: true, accepted: false },
])(
	"admits only an own or direct-child write: %j",
	async ({ destination, accepted, ...options }) => {
		const built = fixture(options);
		const before = toPersistableDoc(built.doc);
		const caseWrite = { caseType: destination, property: "case_name" };
		const input = editFieldTool.inputSchema.parse({
			moduleUuid: built.moduleUuid,
			formUuid: built.formUuid,
			fieldUuid: built.field.uuid,
			updates: { kind: "text", caseWrite },
		});
		const verdict = mutationCommitVerdict(
			built.doc,
			caseWriteCandidateMutations(built.doc, built.field, caseWrite),
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(verdict.ok).toBe(accepted);
		expect(
			caseWriteChoiceVerdict(
				built.doc,
				built.field,
				caseWrite,
				LOOKUP_CONTEXT_UNAVAILABLE,
			).ok,
		).toBe(accepted);
		const harness = makeToolWorkspaceHarness(built.doc);
		const result = await harness.runTool(editFieldTool, input);
		expect("error" in result.result).toBe(!accepted);
		expect(toPersistableDoc(built.doc)).toEqual(before);
		if (!accepted) {
			expect(harness.recordMutations).not.toHaveBeenCalled();
			expect(harness.recordMutationStages).not.toHaveBeenCalled();
			expect(toPersistableDoc(harness.currentDoc())).toEqual(before);
			if (verdict.ok) throw new Error("Rejected destination was accepted");
			expect(verdict.findings.map((finding) => finding.code)).toEqual([
				options.survey || options.moduleless
					? "CASE_WRITE_NO_CASE_ACTION"
					: "CASE_WRITE_NOT_DIRECT_CHILD",
			]);
			return;
		}
		const committed = harness.currentDoc();
		valid(committed);
		expect(toPersistableDoc(committed)).toEqual(
			toPersistableDoc(verdict.nextDoc),
		);
		expect(committed.fields[built.field.uuid]).toMatchObject({
			id: "answer",
			caseWrite,
		});
		const actions = buildFormActions(committed, built.formUuid, "patient");
		const runtime = engine(committed, built.formUuid);
		runtime.setValue("/data/answer", "Amina");
		const mutation = runtime.computeSubmissionMutation({
			caseIds: ["patient-1"],
			entryKey: ENTRY,
		});
		if (mutation.kind !== "followup")
			throw new Error("Expected a follow-up submission");
		if (destination === "patient") {
			expect(actions.update_case.update).toEqual({
				name: { question_path: "/data/answer", update_mode: "always" },
			});
			expect(actions.subcases).toEqual([]);
			expect(mutation.patch).toEqual({ caseName: "Amina", properties: {} });
			expect(mutation.children).toEqual([]);
		} else {
			expect(actions.subcases).toHaveLength(1);
			expect(actions.subcases[0]).toMatchObject({
				case_type: "child",
				name_update: { question_path: "/data/answer", update_mode: "always" },
			});
			expect(mutation.patch).toEqual({ properties: {} });
			expect(mutation.children).toHaveLength(1);
			expect(mutation.children[0]).toMatchObject({
				caseType: "child",
				caseName: "Amina",
				properties: {},
			});
		}
	},
);

// Independent policy examples, including platform metadata, transaction nodes,
// and HQ-managed worker keys. Do not derive test inputs from the forbidden set.
it.each([
	"external_id",
	"actions",
	"case_id",
	"case_type",
	"case_type_id",
	"closed",
	"closed_by",
	"closed_on",
	"commtrack",
	"create",
	"computed_",
	"computed_modified_on_",
	"date",
	"date_modified",
	"date_opened",
	"doc_type",
	"domain",
	"index",
	"indices",
	"initial_processing_complete",
	"last_modified",
	"modified_by",
	"modified_on",
	"opened_by",
	"opened_on",
	"owner_id",
	"parent",
	"referrals",
	"server_modified_on",
	"server_opened_on",
	"status",
	"type",
	"user_id",
	"userid",
	"version",
	"xform_id",
	"xform_ids",
	"location_id",
	"hq_user_id",
	"category",
	"state",
])(
	"routes or refuses metadata destination %s before committing",
	async (property) => {
		const built = fixture();
		const caseWrite: CaseWrite = { caseType: "patient", property };
		const harness = makeToolWorkspaceHarness(built.doc);
		const result = await harness.runTool(
			editFieldTool,
			editFieldTool.inputSchema.parse({
				moduleUuid: built.moduleUuid,
				formUuid: built.formUuid,
				fieldUuid: built.field.uuid,
				updates: { kind: "text", caseWrite },
			}),
		);
		expect("error" in result.result).toBe(property !== "external_id");
		if (property === "external_id") {
			valid(harness.currentDoc());
			expect(harness.currentDoc().fields[built.field.uuid]).toMatchObject({
				caseWrite,
			});
		} else {
			expect(
				caseWriteChoiceVerdict(
					built.doc,
					built.field,
					caseWrite,
					LOOKUP_CONTEXT_UNAVAILABLE,
				).ok,
			).toBe(false);
			expect(harness.recordMutations).not.toHaveBeenCalled();
			expect(harness.recordMutationStages).not.toHaveBeenCalled();
			expect(harness.currentDoc()).toBe(built.doc);
		}
	},
);

it.each([
	{ caseType: "", property: "case_name" },
	{ caseType: "patient", property: "" },
	{ caseType: "patient", property: "name" },
])(
	"refuses malformed or retired destinations at the tool schema: %j",
	(caseWrite) => {
		const built = fixture();
		expect(
			editFieldTool.inputSchema.safeParse({
				moduleUuid: built.moduleUuid,
				formUuid: built.formUuid,
				fieldUuid: built.field.uuid,
				updates: { kind: "text", caseWrite },
			}).success,
		).toBe(false);
	},
);

it("refuses a second writer while preserving the first destination", async () => {
	const built = fixture();
	const harness = makeToolWorkspaceHarness(built.doc);
	const caseWrite = { caseType: "patient", property: "note" };
	const input = {
		moduleUuid: built.moduleUuid,
		formUuid: built.formUuid,
		fieldUuid: built.field.uuid,
		updates: { kind: "text" as const, caseWrite },
	};
	await harness.runTool(editFieldTool, editFieldTool.inputSchema.parse(input));
	const first = harness.currentDoc();
	valid(first);
	const another = first.fields[first.fieldOrder[built.formUuid][1]];
	expect(
		caseWriteChoiceVerdict(
			first,
			another,
			caseWrite,
			LOOKUP_CONTEXT_UNAVAILABLE,
		).ok,
	).toBe(false);
	const calls = harness.recordMutations.mock.calls.length;
	const stages = harness.recordMutationStages.mock.calls.length;
	const result = await harness.runTool(
		editFieldTool,
		editFieldTool.inputSchema.parse({ ...input, fieldUuid: another.uuid }),
	);
	expect("error" in result.result).toBe(true);
	expect(harness.currentDoc()).toBe(first);
	expect(harness.recordMutations).toHaveBeenCalledTimes(calls);
	expect(harness.recordMutationStages).toHaveBeenCalledTimes(stages);
	expect(
		buildFormActions(first, built.formUuid, "patient").update_case.update,
	).toEqual({ note: { question_path: "/data/answer", update_mode: "always" } });
});

it.each([
	{
		property: "external_id",
		value: "",
		patch: { externalId: "", properties: {} },
	},
	{
		property: "external_id",
		value: "  EXT-1\u001f",
		patch: { externalId: "EXT-1", properties: {} },
	},
	{
		property: "case_name",
		value: "\u0000 Alice B. \u001f",
		patch: { caseName: "Alice B.", properties: {} },
	},
])(
	"routes an active $property answer to its scalar column",
	({ property, value, patch }) => {
		const built = fixture();
		const verdict = mutationCommitVerdict(
			built.doc,
			caseWriteCandidateMutations(built.doc, built.field, {
				caseType: "patient",
				property,
			}),
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(verdict.ok).toBe(true);
		const runtime = engine(verdict.nextDoc, built.formUuid);
		runtime.setValue("/data/answer", value);
		const mutation = runtime.computeSubmissionMutation({
			caseIds: ["patient-1"],
			entryKey: ENTRY,
		});
		if (mutation.kind !== "followup") throw new Error("Expected follow-up");
		expect(mutation.patch).toEqual(patch);
	},
);

it.each([
	{ property: "case_name", value: " \u001f", error: /blank after/ },
	{ property: "external_id", value: "😀".repeat(128), error: /255 UTF-16/ },
])(
	"refuses an invalid scalar value for $property",
	({ property, value, error }) => {
		const built = fixture();
		const verdict = mutationCommitVerdict(
			built.doc,
			caseWriteCandidateMutations(built.doc, built.field, {
				caseType: "patient",
				property,
			}),
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(verdict.ok).toBe(true);
		const runtime = engine(verdict.nextDoc, built.formUuid);
		runtime.setValue("/data/answer", value);
		expect(() =>
			runtime.computeSubmissionMutation({
				caseIds: ["patient-1"],
				entryKey: ENTRY,
			}),
		).toThrow(error);
	},
);

it.each(["case_name", "external_id", "photo_url"])(
	"checks capture destination %s before persistence",
	async (property) => {
		const built = fixture({ capture: true });
		const caseWrite: CaptureCaseWrite = {
			caseType: "patient",
			property,
			mode: "url",
		};
		const harness = makeToolWorkspaceHarness(built.doc);
		const input = editFieldTool.inputSchema.parse({
			moduleUuid: built.moduleUuid,
			formUuid: built.formUuid,
			fieldUuid: built.field.uuid,
			updates: { kind: "image", caseWrite },
		});
		const result = await harness.runTool(editFieldTool, input);
		const accepted = property === "photo_url";
		expect("error" in result.result).toBe(!accepted);
		expect(
			caseWriteChoiceVerdict(
				built.doc,
				built.field,
				caseWrite,
				LOOKUP_CONTEXT_UNAVAILABLE,
			).ok,
		).toBe(accepted);
		if (!accepted) {
			expect(harness.recordMutations).not.toHaveBeenCalled();
			expect(harness.recordMutationStages).not.toHaveBeenCalled();
			expect(harness.currentDoc()).toBe(built.doc);
			return;
		}
		const doc = harness.currentDoc();
		valid(doc);
		expect(
			buildFormActions(doc, built.formUuid, "patient", TARGET).update_case
				.update,
		).toEqual({
			photo_url: {
				question_path: "/data/__nova_url_answer",
				update_mode: "always",
			},
		});
		expect(
			buildFormActions(doc, built.formUuid, "patient").update_case.update,
		).toEqual({});
		const runtime = engine(doc, built.formUuid);
		runtime.setValue("/data/answer", "photo.jpg");
		const mutation = runtime.computeSubmissionMutation({
			caseIds: ["patient-1"],
			entryKey: ENTRY,
		});
		if (mutation.kind !== "followup") throw new Error("Expected follow-up");
		expect(mutation.patch).toEqual({ properties: {} });
	},
);

it("preserves an irrelevant external ID, but permits an active answer to clear it", () => {
	const built = fixture({ conditional: true });
	const verdict = mutationCommitVerdict(
		built.doc,
		caseWriteCandidateMutations(built.doc, built.field, {
			caseType: "patient",
			property: "external_id",
		}),
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	expect(verdict.ok).toBe(true);
	valid(verdict.nextDoc);
	const runtime = engine(verdict.nextDoc, built.formUuid);
	runtime.setValue("/data/another", "yes");
	runtime.setValue("/data/answer", "remembered");
	runtime.setValue("/data/another", "no");
	const submit = () => {
		const mutation = runtime.computeSubmissionMutation({
			caseIds: ["patient-1"],
			entryKey: ENTRY,
		});
		if (mutation.kind !== "followup") throw new Error("Expected follow-up");
		return mutation.patch;
	};
	expect(submit()).toEqual({ properties: {} });
	runtime.setValue("/data/another", "yes");
	runtime.setValue("/data/answer", "");
	expect(submit()).toEqual({ externalId: "", properties: {} });
});

it("materializes independent children in cousin repeats nested inside real query iterations", () => {
	const childRepeat = () =>
		f({
			kind: "repeat",
			id: "kids",
			repeat_mode: "user_controlled",
			children: [
				f({
					kind: "text",
					id: "name",
					caseWrite: { caseType: "child", property: "case_name" },
				}),
				f({
					kind: "text",
					id: "external",
					caseWrite: { caseType: "child", property: "external_id" },
				}),
			],
		});
	const doc = buildDoc({
		appName: "Nested children",
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
						name: "Visit",
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
										data_source: { ids_query: "'first second'" },
										children: [
											f({
												kind: "group",
												id: "left",
												children: [childRepeat()],
											}),
											f({
												kind: "group",
												id: "right",
												children: [childRepeat()],
											}),
										],
									}),
								],
							}),
						],
					},
				],
			},
			{
				name: "Children",
				caseType: "child",
				caseListOnly: true,
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [],
			},
		],
	});
	valid(doc);
	const formUuid = doc.formOrder[doc.moduleOrder[0]][0];
	const actions = buildFormActions(doc, formUuid, "patient");
	expect(
		actions.subcases.map((subcase) => ({
			repeat: subcase.repeat_context,
			name: subcase.name_update.question_path,
			external: subcase.case_properties.external_id.question_path,
		})),
	).toEqual([
		{
			repeat: "/data/outer/rows/item/left/kids",
			name: "/data/outer/rows/item/left/kids/name",
			external: "/data/outer/rows/item/left/kids/external",
		},
		{
			repeat: "/data/outer/rows/item/right/kids",
			name: "/data/outer/rows/item/right/kids/name",
			external: "/data/outer/rows/item/right/kids/external",
		},
	]);
	const runtime = engine(doc, formUuid);
	expect(runtime.getRepeatCount("/data/outer/rows")).toBe(2);
	expect(runtime.addRepeat("/data/outer/rows[1]/right/kids")).toBe(1);
	const answers = [
		["/data/outer/rows[0]/left/kids[0]", "Amina"],
		["/data/outer/rows[0]/right/kids[0]", "Bela"],
		["/data/outer/rows[1]/left/kids[0]", "Chandra"],
		["/data/outer/rows[1]/right/kids[0]", "Dara"],
		["/data/outer/rows[1]/right/kids[1]", "Esi"],
	];
	for (const [path, name] of answers) {
		runtime.setValue(`${path}/name`, name);
		runtime.setValue(`${path}/external`, `  ID-${name}  `);
	}
	const mutation = runtime.computeSubmissionMutation({
		caseIds: ["patient-1"],
		entryKey: ENTRY,
	});
	if (mutation.kind !== "followup") throw new Error("Expected follow-up");
	expect(mutation.patch).toEqual({ properties: {} });
	expect(
		mutation.children.map((child) => ({
			type: child.caseType,
			name: child.caseName,
			external: child.externalId,
			properties: child.properties,
		})),
	).toEqual(
		answers.map(([, name]) => ({
			type: "child",
			name,
			external: `ID-${name}`,
			properties: {},
		})),
	);
});

it.each([
	{
		fault: "missing destination",
		code: "CASE_WRITE_UNKNOWN_TYPE",
		error: /unknown case type 'missing'/,
	},
	{
		fault: "invalid field name",
		code: "INVALID_FIELD_ID",
		error: /invalid element name "bad-id"/,
	},
] as const)(
	"fails closed on corrupted persisted state: $fault",
	({ fault, code, error }) => {
		const built = fixture();
		const verdict = mutationCommitVerdict(
			built.doc,
			caseWriteCandidateMutations(built.doc, built.field, {
				caseType: "patient",
				property: "case_name",
			}),
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(verdict.ok).toBe(true);
		valid(verdict.nextDoc);
		const corrupted = structuredClone(verdict.nextDoc);
		const writer = corrupted.fields[built.field.uuid];
		if (writer.kind !== "text") throw new Error("Expected text writer");
		if (fault === "missing destination")
			writer.caseWrite = { caseType: "missing", property: "case_name" };
		else writer.id = "bad-id";
		expect(
			runValidation(corrupted, LOOKUP_CONTEXT_UNAVAILABLE).map(
				(finding) => finding.code,
			),
		).toEqual([code]);
		expect(() =>
			buildFormActions(corrupted, built.formUuid, "patient"),
		).toThrow(error);
		expect(() =>
			engine(corrupted, built.formUuid).computeSubmissionMutation({
				caseIds: ["patient-1"],
				entryKey: ENTRY,
			}),
		).toThrow(error);
	},
);
