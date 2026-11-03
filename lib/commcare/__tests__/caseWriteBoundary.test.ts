import { expect, it } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { makeToolWorkspaceHarness } from "@/lib/agent/__tests__/fixtures";
import { editFieldTool } from "@/lib/agent/tools/editField";
import { buildFormActions } from "@/lib/commcare/formActions";
import { runValidation } from "@/lib/commcare/validator/runner";
import { caseWriteChoiceVerdict } from "@/lib/doc/caseWriteChoices";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { planFieldCaseWrite } from "@/lib/doc/fieldCaseWriteMutations";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	type BlueprintDoc,
	blueprintDocSchema,
	type Field,
	fieldCaseWriteViews,
	proseText,
	type Uuid,
} from "@/lib/domain";
import { buildEngineInput } from "@/lib/preview/engine/engineInput";
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
/** Where a field's answer is saved: the one "Saves to" a choice names. */
type CaseWrite = { caseType: string; property: string };

/** The batch the one "Saves to" planner gives `field` for `caseWrite`. */
function saveTo(doc: BlueprintDoc, field: Field, caseWrite: CaseWrite) {
	const plan = planFieldCaseWrite(doc, field.uuid, caseWrite);
	if (!plan.ok) throw new Error(plan.message);
	return plan.mutations;
}

/** The field's view of the writes that save it, by destination. */
function savesTo(doc: BlueprintDoc, fieldUuid: Uuid): CaseWrite[] {
	return fieldCaseWriteViews(doc, fieldUuid).map((view) => ({
		caseType: view.caseType,
		property: view.property,
	}));
}

/** The planner's verdict of one choice, through the same gate a commit runs. */
function choiceOk(doc: BlueprintDoc, field: Field, caseWrite: CaseWrite) {
	return caseWriteChoiceVerdict(
		doc,
		field.uuid,
		{ destination: caseWrite },
		LOOKUP_CONTEXT_UNAVAILABLE,
	).ok;
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
				caseListMenuItem: {},
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
	const input = buildEngineInput(doc, formUuid, null);
	if (input === undefined) throw new Error("The form is missing.");
	return new FormEngine(input, doc.modules[doc.moduleOrder[0]].caseType);
}

/** The root answers a submission carries for its case operations. */
function rootAnswers(
	mutation: ReturnType<FormEngine["computeSubmissionMutation"]>,
): Record<string, string | readonly string[]> {
	return Object.fromEntries(
		(mutation.operationAnswers?.root ?? []).map((entry) => [
			entry.fieldUuid,
			entry.value,
		]),
	);
}

/**
 * `next` with every operation uuid it holds beyond `before`'s replaced, in
 * order, by `reference`'s: a planner mints a new operation's uuid, so two
 * plans of one edit differ in that uuid alone.
 */
function withMintedOperationUuidsOf(
	next: BlueprintDoc,
	reference: BlueprintDoc,
	before: BlueprintDoc,
): BlueprintDoc {
	const known = new Set(
		Object.values(before.forms).flatMap((form) =>
			(form.caseOperations ?? []).map((operation) => operation.uuid),
		),
	);
	const minted = (doc: BlueprintDoc) =>
		Object.values(doc.forms).flatMap((form) =>
			(form.caseOperations ?? [])
				.map((operation) => operation.uuid)
				.filter((uuid) => !known.has(uuid)),
		);
	const from = minted(next);
	const to = minted(reference);
	let text = JSON.stringify(toPersistableDoc(next));
	from.forEach((uuid, index) => {
		const replacement = to[index];
		if (replacement !== undefined) text = text.replaceAll(uuid, replacement);
	});
	return JSON.parse(text) as BlueprintDoc;
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
		const plan = planFieldCaseWrite(built.doc, built.field.uuid, caseWrite);
		const verdict = plan.ok
			? mutationCommitVerdict(
					built.doc,
					plan.mutations,
					LOOKUP_CONTEXT_UNAVAILABLE,
				)
			: undefined;
		expect(verdict?.ok === true).toBe(accepted);
		expect(choiceOk(built.doc, built.field, caseWrite)).toBe(accepted);
		const harness = makeToolWorkspaceHarness(built.doc);
		const result = await harness.runTool(editFieldTool, input);
		expect("error" in result.result).toBe(!accepted);
		expect(toPersistableDoc(built.doc)).toEqual(before);
		if (!accepted) {
			expect(harness.recordMutations).not.toHaveBeenCalled();
			expect(harness.recordMutationStages).not.toHaveBeenCalled();
			expect(toPersistableDoc(harness.currentDoc())).toEqual(before);
			return;
		}
		if (verdict === undefined || !verdict.ok)
			throw new Error("An accepted destination has a committed batch");
		const committed = harness.currentDoc();
		valid(committed);
		expect(toPersistableDoc(committed)).toEqual(
			withMintedOperationUuidsOf(verdict.nextDoc, committed, built.doc),
		);
		expect(committed.fields[built.field.uuid]).toMatchObject({ id: "answer" });
		expect(savesTo(committed, built.field.uuid)).toEqual([caseWrite]);
		const actions = buildFormActions(committed, built.formUuid);
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
				name: {
					question_path: "/data/nova_trimmed_answer",
					update_mode: "always",
				},
			});
			expect(actions.subcases).toEqual([]);
		} else {
			expect(actions.subcases).toHaveLength(1);
			expect(actions.subcases[0]).toMatchObject({
				case_type: "child",
				name_update: {
					question_path: "/data/nova_trimmed_answer",
					update_mode: "always",
				},
			});
		}
		// The answer reaches the operation that saves it.
		expect(rootAnswers(mutation)[built.field.uuid]).toBe("Amina");
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
		const saved = property === "external_id" || property === "owner_id";
		expect("error" in result.result).toBe(!saved);
		if (saved) {
			valid(harness.currentDoc());
			expect(savesTo(harness.currentDoc(), built.field.uuid)).toEqual([
				caseWrite,
			]);
		} else {
			expect(choiceOk(built.doc, built.field, caseWrite)).toBe(false);
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
	expect(choiceOk(first, another, caseWrite)).toBe(false);
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
	expect(buildFormActions(first, built.formUuid).update_case.update).toEqual({
		note: { question_path: "/data/answer", update_mode: "always" },
	});
});

it.each([
	{ property: "external_id", value: "" },
	{ property: "external_id", value: "  EXT-1\u001f" },
	{ property: "case_name", value: "\u0000 Alice B. \u001f" },
])(
	"carries an active $property answer, as written, to the own case's change",
	({ property, value }) => {
		const built = fixture();
		const verdict = mutationCommitVerdict(
			built.doc,
			saveTo(built.doc, built.field, { caseType: "patient", property }),
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
		// The submission program trims it, as the device does
		// (`lib/domain/caseScalarText.ts`); the answer itself is unchanged.
		expect(rootAnswers(mutation)[built.field.uuid]).toBe(value);
	},
);

it.each([
	{ property: "case_name", value: " \u001f", fits: "Amina" },
	{ property: "external_id", value: "😀".repeat(128), fits: "😀".repeat(127) },
])(
	"refuses an invalid scalar value for $property at its question",
	({ property, value, fits }) => {
		const built = fixture();
		const verdict = mutationCommitVerdict(
			built.doc,
			saveTo(built.doc, built.field, { caseType: "patient", property }),
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(verdict.ok).toBe(true);
		const runtime = engine(verdict.nextDoc, built.formUuid);
		runtime.setValue("/data/answer", value);
		// The question refuses it, as the device's constraint does.
		expect(runtime.validateAll()).toBe(false);
		expect(runtime.getState("/data/answer")).toMatchObject({
			valid: false,
			errorMessage: "Invalid value",
		});
		runtime.setValue("/data/answer", fits);
		expect(runtime.validateAll()).toBe(true);
	},
);

it.each(["case_name", "external_id", "photo_url"])(
	"checks capture destination %s before persistence",
	async (property) => {
		const built = fixture({ capture: true });
		const caseWrite: CaseWrite = {
			caseType: "patient",
			property,
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
		expect(choiceOk(built.doc, built.field, caseWrite)).toBe(accepted);
		if (!accepted) {
			expect(harness.recordMutations).not.toHaveBeenCalled();
			expect(harness.recordMutationStages).not.toHaveBeenCalled();
			expect(harness.currentDoc()).toBe(built.doc);
			return;
		}
		const doc = harness.currentDoc();
		valid(doc);
		expect(
			buildFormActions(doc, built.formUuid, TARGET).update_case.update,
		).toEqual({
			photo_url: {
				question_path: "/data/nova_url_answer",
				update_mode: "always",
			},
		});
		expect(buildFormActions(doc, built.formUuid).update_case.update).toEqual(
			{},
		);
		const runtime = engine(doc, built.formUuid);
		runtime.setValue("/data/answer", "photo.jpg");
		const mutation = runtime.computeSubmissionMutation({
			caseIds: ["patient-1"],
			entryKey: ENTRY,
		});
		if (mutation.kind !== "followup") throw new Error("Expected follow-up");
		expect(rootAnswers(mutation)[built.field.uuid]).toBe("photo.jpg");
	},
);

it("saves an external ID from a conditional question through the action the wire guards", () => {
	const built = fixture({ conditional: true });
	const verdict = mutationCommitVerdict(
		built.doc,
		saveTo(built.doc, built.field, {
			caseType: "patient",
			property: "external_id",
		}),
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	expect(verdict.ok).toBe(true);
	valid(verdict.nextDoc);
	// The basic update names the trimmed node, whose update bind carries
	// `count(<question>) > 0` (`caseBlocks.test.ts`), so a hidden question
	// leaves the stored value as it was.
	expect(
		buildFormActions(verdict.nextDoc, built.formUuid).update_case.update,
	).toEqual({
		external_id: {
			question_path: "/data/nova_trimmed_answer",
			update_mode: "always",
		},
	});
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
				caseListMenuItem: {},
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [],
			},
		],
	});
	valid(doc);
	const formUuid = doc.formOrder[doc.moduleOrder[0]][0];
	const actions = buildFormActions(doc, formUuid);
	expect(
		actions.subcases.map((subcase) => ({
			repeat: subcase.repeat_context,
			name: subcase.name_update.question_path,
			external: subcase.case_properties.external_id.question_path,
		})),
	).toEqual([
		{
			repeat: "/data/outer/rows/item/left/kids",
			name: "/data/outer/rows/item/left/kids/nova_trimmed_name",
			external: "/data/outer/rows/item/left/kids/nova_trimmed_external",
		},
		{
			repeat: "/data/outer/rows/item/right/kids",
			name: "/data/outer/rows/item/right/kids/nova_trimmed_name",
			external: "/data/outer/rows/item/right/kids/nova_trimmed_external",
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
	// Each kids repeat is its own scope: its rows, parent-major, each carry
	// the name and the external id the child created for that row saves.
	const kids = Object.values(doc.fields).filter(
		(field) => field.kind === "repeat" && field.id === "kids",
	);
	const namesIn = (repeat: (typeof kids)[number]) => {
		const childUuids = doc.fieldOrder[repeat.uuid] ?? [];
		const [nameUuid, externalUuid] = childUuids;
		const scope = mutation.operationAnswers?.repeats.find(
			(candidate) => candidate.repeat === repeat.uuid,
		);
		return (scope?.iterations ?? []).map((iteration) => {
			const values = Object.fromEntries(
				iteration.map((entry) => [entry.fieldUuid, entry.value]),
			);
			return {
				name: values[nameUuid as string],
				external: values[externalUuid as string],
			};
		});
	};
	expect(kids.map(namesIn)).toEqual([
		[
			{ name: "Amina", external: "  ID-Amina  " },
			{ name: "Chandra", external: "  ID-Chandra  " },
		],
		[
			{ name: "Bela", external: "  ID-Bela  " },
			{ name: "Dara", external: "  ID-Dara  " },
			{ name: "Esi", external: "  ID-Esi  " },
		],
	]);
});

it("fails closed on a question id no XML element can carry", () => {
	const built = fixture();
	const verdict = mutationCommitVerdict(
		built.doc,
		saveTo(built.doc, built.field, {
			caseType: "patient",
			property: "case_name",
		}),
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	expect(verdict.ok).toBe(true);
	valid(verdict.nextDoc);
	const corrupted = structuredClone(verdict.nextDoc);
	corrupted.fields[built.field.uuid].id = "bad-id";
	expect(
		runValidation(corrupted, LOOKUP_CONTEXT_UNAVAILABLE).map(
			(finding) => finding.code,
		),
	).toEqual(["INVALID_FIELD_ID"]);
	expect(() => buildFormActions(corrupted, built.formUuid)).toThrow(
		/invalid element name "bad-id"/,
	);
});
