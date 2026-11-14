/** Real input admission, tool planners, commit gate and reducer. The writer
 * is controlled; these tests do not prove SQL concurrency or wire execution. */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { expectAdmittedDoc } from "@/lib/agent/__tests__/admittedFixture";
import { projectAuthoringRead } from "@/lib/agent/authoring/output";
import { emittedModuleKind } from "@/lib/commcare/moduleKind";
import type { ValidationErrorCode } from "@/lib/commcare/validator/errors";
import { runValidation } from "@/lib/commcare/validator/runner";
import { BlueprintCommitRejectedError } from "@/lib/db/commitGuard";
import {
	HOUSEHOLD_VISIT,
	HOUSEHOLDS,
	kindFixture,
	publishedAdvanced,
} from "@/lib/doc/__tests__/moduleKindMoveFixture";
import {
	addCaseOperationAfterMutations,
	planCaseOperationUpdate,
} from "@/lib/doc/caseOperationMutations";
import {
	type CasePlacementEntry,
	formCasePlacementView,
} from "@/lib/doc/casePlacements";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc, CaseOperationWrite, Uuid } from "@/lib/domain";
import {
	caseOperationSchema,
	lookupColumnIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain";
import { eq, literal, tableColumn, tableLookup } from "@/lib/domain/expression";
import { proseText } from "@/lib/domain/prose";
import { makeToolWorkspaceHarness } from "../../../__tests__/fixtures";
import { applyToDoc } from "../../common";
import { getFormTool } from "../../getForm";
import { addUserPropertiesTool } from "../../users";
import {
	addCaseOperationsInputSchema,
	addCaseOperationsTool,
} from "../addCaseOperations";
import { getCaseOperationsTool } from "../getCaseOperations";
import {
	moveCaseOperationInputSchema,
	moveCaseOperationTool,
} from "../moveCaseOperation";
import { removeCaseOperationTool } from "../removeCaseOperation";
import {
	type CaseOperationInput,
	caseOperationInputSchema,
	OWN_CASE_OPERATION_REFUSAL,
	resolveCaseOperationInput,
} from "../shared";
import {
	updateCaseOperationInputSchema,
	updateCaseOperationTool,
} from "../updateCaseOperation";

const TEXT = testUuid("case-operation-field");
const CREATE_UUID = testUuid("create-visit-operation");
const UPDATE_UUID = testUuid("update-visit-operation");
const RETYPE_UUID = testUuid("retype-lead-operation");
const TAG_UUID = testUuid("tag-lead-operation");
const LOOKUP_TABLE = lookupTableIdSchema.parse(
	"018f3e8a-7b2c-7def-8abc-1234567890ab",
);
const LOOKUP_VALUE = lookupColumnIdSchema.parse(
	"018f3e8a-7b2c-7def-8abc-1234567890ad",
);
const LOOKUP_FILTER = lookupColumnIdSchema.parse(
	"018f3e8a-7b2c-7def-8abc-1234567890ae",
);

const fieldValue = {
	kind: "term",
	term: { kind: "field", uuid: TEXT },
} as const;

const createVisit = {
	id: "create_visit",
	action: "create",
	caseType: "visit",
	target: { kind: "new" },
	name: fieldValue,
	writes: [{ property: "source_id", value: fieldValue }],
} as const satisfies CaseOperationInput;

const updateVisit = {
	id: "tag_visit",
	action: "update",
	caseType: "visit",
	target: { kind: "op", opUuid: CREATE_UUID },
	writes: [
		{
			property: "source_id",
			value: { kind: "id-of", opUuid: CREATE_UUID },
		},
	],
} as const satisfies CaseOperationInput;

const lookupExpression = tableLookup(
	LOOKUP_TABLE,
	LOOKUP_VALUE,
	eq(tableColumn(LOOKUP_TABLE, LOOKUP_FILTER), literal("enabled")),
);

function fixture(): {
	readonly doc: BlueprintDoc;
	readonly moduleUuid: Uuid;
	readonly formUuid: Uuid;
} {
	const doc = buildDoc({
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "nickname", label: "Nickname", data_type: "text" },
				],
			},
			{
				name: "visit",
				properties: [
					{ name: "source_id", label: "Source ID", data_type: "text" },
				],
			},
		],
		modules: [
			{
				id: "patients",
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "nickname", header: "Nickname" },
				]),
				forms: [
					{
						id: "edit",
						name: "Edit",
						type: "followup",
						fields: [
							f({
								uuid: TEXT,
								kind: "text",
								id: "nickname",
								label: proseText("Nickname"),
								caseWrite: { caseType: "patient", property: "nickname" },
							}),
						],
					},
				],
			},
		],
	});
	const moduleUuid = doc.moduleOrder[0];
	return {
		doc: expectAdmittedDoc(doc),
		moduleUuid,
		formUuid: doc.formOrder[moduleUuid][0],
	};
}

/** The follow-up form's own case: always its first change. */
function ownOf(doc: BlueprintDoc, formUuid: Uuid): Uuid {
	const own = doc.forms[formUuid].caseOperations?.[0];
	if (own?.action !== "own") throw new Error("fixture own case");
	return own.uuid;
}

/** The words a read gives the place `formCasePlacementView` names. */
function wordsOf(entry: CasePlacementEntry): string {
	switch (entry.placement.kind) {
		case "basic":
			return "case management";
		case "advanced":
			return "case actions";
		case "save-to-case":
			return "save to case";
	}
}

/** An authored getCaseOperations read's changes, each with the placement
 *  words the read adds. */
function readOperations(data: unknown) {
	return z
		.object({ operations: z.array(z.record(z.string(), z.unknown())) })
		.parse(data)
		.operations.map(({ placement, ...operation }) => ({
			operation,
			placement,
		}));
}

function item(operation: CaseOperationInput, operationUuid: Uuid) {
	return { operationUuid, operation };
}

function visitBatch() {
	return [item(createVisit, CREATE_UUID), item(updateVisit, UPDATE_UUID)];
}

describe("case-operation canonical author boundary", () => {
	it("accepts UUID expression leaves and rejects path/id aliases", () => {
		expect(caseOperationInputSchema.safeParse(createVisit).success).toBe(true);
		expect(caseOperationInputSchema.safeParse(updateVisit).success).toBe(true);

		expect(
			caseOperationInputSchema.safeParse({
				...createVisit,
				name: {
					kind: "term",
					term: { kind: "field", path: "nickname" },
				},
			}).success,
		).toBe(false);
		expect(
			caseOperationInputSchema.safeParse({
				...updateVisit,
				target: { kind: "operation", operationId: "create_visit" },
			}).success,
		).toBe(false);
		expect(
			caseOperationInputSchema.safeParse({
				...updateVisit,
				writes: [
					{
						property: "source_id",
						value: { kind: "id-of", operationId: "create_visit" },
					},
				],
			}).success,
		).toBe(false);
	});

	it("makes illegal action facets and platform-owned types unconstructible", () => {
		expect(
			caseOperationInputSchema.safeParse({
				...createVisit,
				target: { kind: "session" },
			}).success,
		).toBe(false);
		expect(
			caseOperationInputSchema.safeParse({
				...createVisit,
				caseType: "commcare-user",
			}).success,
		).toBe(false);
		expect(
			caseOperationInputSchema.safeParse({
				id: "close_visit",
				action: "close",
				caseType: "visit",
				target: { kind: "session" },
				owner: fieldValue,
			}).success,
		).toBe(false);
	});

	it("constructs strict stored arms without own undefined facets", () => {
		const closeInput = {
			id: "close_visit",
			action: "close",
			caseType: "visit",
			target: { kind: "session" },
		} as const satisfies CaseOperationInput;
		const resolved = resolveCaseOperationInput(closeInput, CREATE_UUID);

		expect(caseOperationSchema.parse(resolved)).toEqual(resolved);
		expect(Object.hasOwn(resolved, "writes")).toBe(false);
		expect(Object.hasOwn(resolved, "links")).toBe(false);
		expect(Object.hasOwn(resolved, "name")).toBe(false);
		expect(Object.hasOwn(resolved, "owner")).toBe(false);
	});

	it("uses the validator's exact identifier vocabulary", () => {
		const accepted = {
			...createVisit,
			id: "_create_visit2",
			writes: [{ property: "source_id2", value: fieldValue }],
			links: [
				{
					identifier: "_parent2",
					targetType: "patient",
					target: null,
					relationship: "child",
				},
			],
		} as const;
		expect(caseOperationInputSchema.safeParse(accepted).success).toBe(true);

		for (const id of ["create-visit", "create.visit"]) {
			expect(
				caseOperationInputSchema.safeParse({ ...accepted, id }).success,
			).toBe(false);
		}
		for (const property of ["source.id", "-source"]) {
			expect(
				caseOperationInputSchema.safeParse({
					...accepted,
					writes: [{ property, value: fieldValue }],
				}).success,
			).toBe(false);
		}
		expect(
			caseOperationInputSchema.safeParse({
				...accepted,
				caseType: "1st-visit",
				writes: [{ property: "source-id", value: fieldValue }],
			}).success,
		).toBe(true);
		for (const identifier of ["parent-link", "parent.link"]) {
			expect(
				caseOperationInputSchema.safeParse({
					...accepted,
					links: [{ ...accepted.links[0], identifier }],
				}).success,
			).toBe(false);
		}
	});

	it("refuses at the schema the names CommCare HQ's form builder can't keep, with the verdicts' sentences", () => {
		const accepted = {
			...createVisit,
			writes: [{ property: "source_id", value: fieldValue }],
			links: [
				{
					identifier: "parent",
					targetType: "patient",
					target: null,
					relationship: "child",
				},
			],
		} as const;
		const messages = (input: unknown) => {
			const result = caseOperationInputSchema.safeParse(input);
			return result.success
				? []
				: result.error.issues.map((issue) => issue.message);
		};
		expect(messages({ ...accepted, id: "instance" })).toEqual([
			'"instance" is a name CommCare HQ\'s form builder can\'t open a form with. You could call it "q_instance" instead.',
		]);
		/* An operation's wrapper sits above its `<case>`, where the form
		 * builder never looks for a case action. */
		expect(messages({ ...accepted, id: "close" })).toEqual([]);
		expect(
			messages({
				...accepted,
				writes: [{ property: "close", value: fieldValue }],
			}),
		).toEqual([
			"CommCare HQ's form builder reads a property named \"close\" as closing the case, so editing this form there would close the case every time it's sent. Save it under another property name here.",
		]);
		expect(
			messages({
				...accepted,
				writes: [{ property: "parsererror", value: fieldValue }],
			}),
		).toEqual([
			"CommCare HQ's form builder can't open a form that saves a property named \"parsererror\" from a case change. Save it under another property name here.",
		]);
		const link = (identifier: string) =>
			messages({ ...accepted, links: [{ ...accepted.links[0], identifier }] });
		expect(link("close")).toEqual([
			'"close" is a name CommCare HQ\'s form builder reads as closing the case. You could call it "q_close" instead.',
		]);
		expect(link("create")).toEqual([
			'"create" is a name CommCare HQ\'s form builder reads as starting a new case. You could call it "q_create" instead.',
		]);
		expect(link("bind")).toEqual([
			'"bind" is a name CommCare HQ\'s form builder can\'t open a form with. You could call it "q_bind" instead.',
		]);
		expect(link("update")).toEqual([]);
	});

	it("admits UUID and lookup vocabulary in canonical schemas", () => {
		const { moduleUuid, formUuid } = fixture();
		expect(
			caseOperationInputSchema.safeParse({
				...createVisit,
				owner: lookupExpression,
			}).success,
		).toBe(true);

		const validInput = {
			moduleUuid,
			formUuid,
			operations: [
				item({ ...createVisit, owner: lookupExpression }, CREATE_UUID),
			],
		};
		expect(addCaseOperationsInputSchema.safeParse(validInput).success).toBe(
			true,
		);
		const invalidInput = {
			moduleUuid,
			formUuid,
			operations: [
				{
					operationUuid: CREATE_UUID,
					operation: {
						...createVisit,
						name: {
							kind: "term",
							term: { kind: "field", path: "nickname" },
						},
					},
				},
			],
		};
		expect(
			addCaseOperationsInputSchema.safeParse({
				...validInput,
				operations: [
					{ ...validInput.operations[0], operationUuid: "create_visit" },
				],
			}).success,
		).toBe(false);
		expect(addCaseOperationsInputSchema.safeParse(invalidInput).success).toBe(
			false,
		);
	});

	it("accepts UUID anchors and rejects numeric placement on add and move", () => {
		const { moduleUuid, formUuid } = fixture();
		expect(
			addCaseOperationsInputSchema.safeParse({
				moduleUuid,
				formUuid,
				operations: [item(createVisit, CREATE_UUID)],
				afterOperationUuid: null,
			}).success,
		).toBe(true);
		expect(
			addCaseOperationsInputSchema.safeParse({
				moduleUuid,
				formUuid,
				operations: [item(createVisit, CREATE_UUID)],
				index: 0,
			}).success,
		).toBe(false);
		expect(
			moveCaseOperationInputSchema.safeParse({
				moduleUuid,
				formUuid,
				operationUuid: CREATE_UUID,
				afterOperationUuid: null,
			}).success,
		).toBe(true);
		expect(
			moveCaseOperationInputSchema.safeParse({
				moduleUuid,
				formUuid,
				operationUuid: CREATE_UUID,
				index: 0,
			}).success,
		).toBe(false);
	});
});

describe("shared case-operation tools", () => {
	it("adds a UUID-predeclared dependent batch atomically", async () => {
		const { doc, moduleUuid, formUuid } = fixture();
		const h = makeToolWorkspaceHarness(doc);
		const result = await h.runTool(addCaseOperationsTool, {
			moduleUuid,
			formUuid,
			operations: visitBatch(),
		});

		expect(result.result).toMatchObject({
			operationUuids: [CREATE_UUID, UPDATE_UUID],
			operationIds: ["create_visit", "tag_visit"],
			summary: { location: "Edit", count: 2 },
		});
		expect(h.recordMutations).toHaveBeenCalledTimes(1);
		const operations = h.currentDoc().forms[formUuid].caseOperations ?? [];
		// The new changes run after this form's own case.
		expect(operations).toHaveLength(3);
		expect(operations[0]).toMatchObject({ action: "own" });
		expect(operations[1]).toMatchObject({
			uuid: CREATE_UUID,
			name: fieldValue,
		});
		expect(operations[2]).toMatchObject({
			uuid: UPDATE_UUID,
			target: { kind: "op", opUuid: CREATE_UUID },
			writes: [
				{
					property: "source_id",
					value: { kind: "id-of", opUuid: CREATE_UUID },
				},
			],
		});
	});

	it("returns canonical UUID references from both read tools", async () => {
		const { doc, moduleUuid, formUuid } = fixture();
		const h = makeToolWorkspaceHarness(doc);
		await h.runTool(addCaseOperationsTool, {
			moduleUuid,
			formUuid,
			operations: visitBatch(),
		});
		const read = await h.runTool(getCaseOperationsTool, {
			moduleUuid,
			formUuid,
		});
		const projected = z
			.object({ operations: z.array(caseOperationSchema) })
			.parse(read.data).operations;
		expect(projected).toEqual(h.currentDoc().forms[formUuid].caseOperations);
		expect(projected[0]).toMatchObject({ action: "own" });
		expect(projected[1]).toMatchObject({ uuid: CREATE_UUID, name: fieldValue });
		expect(projected[2]).toMatchObject({
			uuid: UPDATE_UUID,
			target: { kind: "op", opUuid: CREATE_UUID },
			writes: updateVisit.writes,
		});

		const formRead = await h.runTool(getFormTool, { moduleUuid, formUuid });
		const formOperations =
			"form" in formRead.data ? formRead.data.form.caseOperations : undefined;
		expect(formOperations).toEqual(
			h.currentDoc().forms[formUuid].caseOperations,
		);
	});

	it("updates through granular patches with no whole-operation fallback", async () => {
		const { doc, moduleUuid, formUuid } = fixture();
		const h = makeToolWorkspaceHarness(doc);
		await h.runTool(addCaseOperationsTool, {
			moduleUuid,
			formUuid,
			operations: [item(createVisit, CREATE_UUID)],
		});
		const result = await h.runTool(updateCaseOperationTool, {
			moduleUuid,
			formUuid,
			operationUuid: CREATE_UUID,
			operation: {
				...createVisit,
				id: "create_encounter",
				condition: { kind: "match-all" },
			},
		});

		expect(result.mutations).toEqual([
			expect.objectContaining({
				kind: "updateForm",
				caseOperationPatch: {
					operation: "update",
					uuid: CREATE_UUID,
					targetAction: "create",
					patch: {
						id: "create_encounter",
						condition: { kind: "match-all" },
					},
				},
			}),
		]);
		expect(
			result.mutations.some(
				(mutation) =>
					mutation.kind === "updateForm" &&
					mutation.caseOperationChange !== undefined,
			),
		).toBe(false);
	});

	it("retargets across case types atomically", async () => {
		const { doc, moduleUuid, formUuid } = fixture();
		const h = makeToolWorkspaceHarness(doc);
		await h.runTool(addCaseOperationsTool, {
			moduleUuid,
			formUuid,
			operations: visitBatch(),
		});
		h.recordMutations.mockClear();

		const desired = {
			...updateVisit,
			caseType: "patient",
			target: { kind: "session" },
		} as const satisfies CaseOperationInput;
		const result = await h.runTool(updateCaseOperationTool, {
			moduleUuid,
			formUuid,
			operationUuid: UPDATE_UUID,
			operation: desired,
		});

		expect(h.recordMutations).toHaveBeenCalledTimes(1);
		expect(
			result.mutations.filter(
				(mutation) =>
					mutation.kind === "updateForm" &&
					mutation.caseOperationPatch?.operation === "update",
			),
		).toEqual([
			expect.objectContaining({
				caseOperationPatch: {
					operation: "update",
					uuid: UPDATE_UUID,
					targetAction: "update",
					patch: {
						caseType: "patient",
						target: { kind: "session" },
					},
				},
			}),
		]);
	});

	it("refuses removing or moving a producer past its dependent", async () => {
		const { doc, moduleUuid, formUuid } = fixture();
		const h = makeToolWorkspaceHarness(doc);
		await h.runTool(addCaseOperationsTool, {
			moduleUuid,
			formUuid,
			operations: visitBatch(),
		});
		h.recordMutations.mockClear();

		const removed = await h.runTool(removeCaseOperationTool, {
			moduleUuid,
			formUuid,
			operationUuid: CREATE_UUID,
		});
		expect(removed.result).toEqual(
			expect.objectContaining({ error: expect.stringContaining("tag_visit") }),
		);

		const moved = await h.runTool(moveCaseOperationTool, {
			moduleUuid,
			formUuid,
			operationUuid: CREATE_UUID,
			afterOperationUuid: UPDATE_UUID,
		});
		expect(moved.result).toEqual(
			expect.objectContaining({ error: expect.stringContaining("tag_visit") }),
		);
		expect(h.recordMutations).not.toHaveBeenCalled();
	});

	it("moves an independent operation and removes dependents before their producer", async () => {
		const { doc, moduleUuid, formUuid } = fixture();
		const h = makeToolWorkspaceHarness(doc);
		const independentUuid = testUuid("independent-visit");
		await h.runTool(addCaseOperationsTool, {
			moduleUuid,
			formUuid,
			operations: [
				...visitBatch(),
				item({ ...createVisit, id: "independent_visit" }, independentUuid),
			],
		});
		h.recordMutations.mockClear();
		const own = ownOf(doc, formUuid);
		const moved = await h.runTool(moveCaseOperationTool, {
			moduleUuid,
			formUuid,
			operationUuid: independentUuid,
			afterOperationUuid: own,
		});
		expect(moved.result).toMatchObject({
			afterOperationUuid: own,
			operationOrder: [own, independentUuid, CREATE_UUID, UPDATE_UUID],
		});
		expect(
			h.currentDoc().forms[formUuid].caseOperations?.map((op) => op.uuid),
		).toEqual([own, independentUuid, CREATE_UUID, UPDATE_UUID]);
		expect(h.recordMutations).toHaveBeenCalledTimes(1);
		for (const operationUuid of [UPDATE_UUID, CREATE_UUID]) {
			const removed = await h.runTool(removeCaseOperationTool, {
				moduleUuid,
				formUuid,
				operationUuid,
			});
			expect(removed.result).not.toHaveProperty("error");
		}
		expect(
			h.currentDoc().forms[formUuid].caseOperations?.map((op) => op.uuid),
		).toEqual([own, independentUuid]);
		expect(h.recordMutations).toHaveBeenCalledTimes(3);
		expectAdmittedDoc(h.currentDoc());
	});

	it("reports canonical UUID placement for a no-op move", async () => {
		const { doc, moduleUuid, formUuid } = fixture();
		const h = makeToolWorkspaceHarness(doc);
		await h.runTool(addCaseOperationsTool, {
			moduleUuid,
			formUuid,
			operations: [item(createVisit, CREATE_UUID)],
		});
		h.recordMutations.mockClear();
		const own = ownOf(doc, formUuid);
		const moved = await h.runTool(moveCaseOperationTool, {
			moduleUuid,
			formUuid,
			operationUuid: CREATE_UUID,
			afterOperationUuid: own,
		});
		expect(moved.result).toMatchObject({
			afterOperationUuid: own,
			operationOrder: [own, CREATE_UUID],
			ok: true,
		});
		expect(moved.mutations).toEqual([]);
		expect(h.recordMutations).not.toHaveBeenCalled();
	});

	it("propagates a writer refusal without adopting its prepared proposal", async () => {
		const { doc, moduleUuid, formUuid } = fixture();
		const setup = makeToolWorkspaceHarness(doc);
		await setup.runTool(addCaseOperationsTool, {
			moduleUuid,
			formUuid,
			operations: [item(createVisit, CREATE_UUID)],
		});
		const stale = setup.currentDoc();
		const h = makeToolWorkspaceHarness(expectAdmittedDoc(stale));
		h.recordMutations.mockRejectedValueOnce(
			new BlueprintCommitRejectedError(
				"A peer changed this case operation first.",
			),
		);

		await expect(
			h.runTool(updateCaseOperationTool, {
				moduleUuid,
				formUuid,
				operationUuid: CREATE_UUID,
				operation: { ...createVisit, id: "create_encounter" },
			}),
		).rejects.toBeInstanceOf(BlueprintCommitRejectedError);
		expect(h.recordMutations).toHaveBeenCalledTimes(1);
		expect(h.currentDoc()).toEqual(stale);
	});
});

describe("dependency refusals name the actual constraint", () => {
	function retypeFixture(): {
		doc: BlueprintDoc;
		moduleUuid: Uuid;
		formUuid: Uuid;
	} {
		const doc = buildDoc({
			caseTypes: [
				{
					name: "lead",
					properties: [{ name: "note", label: "Note", data_type: "text" }],
				},
				{
					name: "lead_copy",
					properties: [{ name: "note", label: "Note", data_type: "text" }],
				},
			],
			modules: [
				{
					name: "Leads",
					caseType: "lead",
					caseListConfig: caseListConfig([{ field: "note", header: "Note" }]),
					forms: [
						{
							name: "Edit",
							type: "followup",
							fields: [
								f({
									uuid: testUuid("lead-note-field"),
									kind: "text",
									id: "note",
									label: proseText("Note"),
								}),
							],
						},
					],
				},
			],
		});
		const moduleUuid = doc.moduleOrder[0];
		return {
			doc: expectAdmittedDoc(doc),
			moduleUuid,
			formUuid: doc.formOrder[moduleUuid][0],
		};
	}

	it("distinguishes target-type dependencies from identity references", async () => {
		const { doc, moduleUuid, formUuid } = retypeFixture();
		const noteUuid = doc.fieldOrder[formUuid][0];
		const retypeLead = {
			id: "retype_lead",
			action: "update",
			caseType: "lead",
			target: { kind: "session" },
			retype: "lead_copy",
		} as const satisfies CaseOperationInput;
		const tagLead = {
			id: "tag_lead",
			action: "update",
			caseType: "lead_copy",
			target: { kind: "session" },
			writes: [
				{
					property: "note",
					value: {
						kind: "term",
						term: { kind: "field", uuid: noteUuid },
					},
				},
			],
		} as const satisfies CaseOperationInput;
		const h = makeToolWorkspaceHarness(doc);
		await h.runTool(addCaseOperationsTool, {
			moduleUuid,
			formUuid,
			operations: [item(retypeLead, RETYPE_UUID), item(tagLead, TAG_UUID)],
		});
		h.recordMutations.mockClear();

		const removed = await h.runTool(removeCaseOperationTool, {
			moduleUuid,
			formUuid,
			operationUuid: RETYPE_UUID,
		});
		const removeError = z
			.object({ error: z.string() })
			.parse(removed.result).error;
		expect(removeError).toContain("kind of case");
		expect(removeError).toContain("tag_lead");
		expect(removeError).not.toContain("uses its result");

		const moved = await h.runTool(moveCaseOperationTool, {
			moduleUuid,
			formUuid,
			operationUuid: RETYPE_UUID,
			afterOperationUuid: TAG_UUID,
		});
		const moveError = z.object({ error: z.string() }).parse(moved.result).error;
		expect(moveError).toContain("kind of case");
		expect(moveError).not.toContain("reference");
		expect(h.recordMutations).not.toHaveBeenCalled();
	});

	it("still names a reference when that is what breaks", async () => {
		const { doc, moduleUuid, formUuid } = fixture();
		const h = makeToolWorkspaceHarness(doc);
		await h.runTool(addCaseOperationsTool, {
			moduleUuid,
			formUuid,
			operations: visitBatch(),
		});
		const removed = await h.runTool(removeCaseOperationTool, {
			moduleUuid,
			formUuid,
			operationUuid: CREATE_UUID,
		});
		const error = z.object({ error: z.string() }).parse(removed.result).error;
		expect(error).toContain("uses its result");
		expect(error).not.toContain("kind of case");
	});
});

describe("this form's own case on the case change tools", () => {
	it("edits the own case in place, keeping its identity", async () => {
		const { doc, moduleUuid, formUuid } = fixture();
		const h = makeToolWorkspaceHarness(doc);
		const own = ownOf(doc, formUuid);
		const before = h.currentDoc().forms[formUuid].caseOperations?.[0];
		if (before?.action !== "own") throw new Error("fixture own case");
		const visits = {
			property: "visits",
			value: { kind: "term", term: { kind: "literal", value: 1 } },
		} as const;

		const result = await h.runTool(updateCaseOperationTool, {
			moduleUuid,
			formUuid,
			operationUuid: own,
			operation: {
				action: "own",
				writes: [...(before.writes ?? []), visits],
			},
		});

		expect(result.result).not.toHaveProperty("error");
		// One granular write addition on the own arm, never a replacement.
		expect(
			result.mutations.some(
				(mutation) =>
					mutation.kind === "updateForm" &&
					mutation.caseOperationChange !== undefined,
			),
		).toBe(false);
		const after = h.currentDoc().forms[formUuid].caseOperations ?? [];
		expect(after[0]).toMatchObject({
			uuid: own,
			id: before.id,
			action: "own",
			writes: [...(before.writes ?? []), visits],
		});
		expectAdmittedDoc(h.currentDoc());
	});

	it("refuses turning the own case into another change or another change into it", async () => {
		const { doc, moduleUuid, formUuid } = fixture();
		const h = makeToolWorkspaceHarness(doc);
		await h.runTool(addCaseOperationsTool, {
			moduleUuid,
			formUuid,
			operations: [item(createVisit, CREATE_UUID)],
		});
		h.recordMutations.mockClear();

		const intoCreate = await h.runTool(updateCaseOperationTool, {
			moduleUuid,
			formUuid,
			operationUuid: ownOf(doc, formUuid),
			operation: createVisit,
		});
		const intoOwn = await h.runTool(updateCaseOperationTool, {
			moduleUuid,
			formUuid,
			operationUuid: CREATE_UUID,
			operation: { action: "own" },
		});

		expect(intoCreate.result).toHaveProperty("error");
		expect(intoOwn.result).toHaveProperty("error");
		expect(h.recordMutations).not.toHaveBeenCalled();
	});

	it("refuses adding, removing or moving the own case", async () => {
		const { doc, moduleUuid, formUuid } = fixture();
		const h = makeToolWorkspaceHarness(doc);
		await h.runTool(addCaseOperationsTool, {
			moduleUuid,
			formUuid,
			operations: [item(createVisit, CREATE_UUID)],
		});
		h.recordMutations.mockClear();
		const own = ownOf(doc, formUuid);

		// A new change is never the own case: the strict union has no own arm.
		expect(
			addCaseOperationsInputSchema.safeParse({
				moduleUuid,
				formUuid,
				operations: [{ operation: { action: "own" } }],
			}).success,
		).toBe(false);
		const added = await h.runTool(addCaseOperationsTool, {
			moduleUuid,
			formUuid,
			operations: [
				item({ ...createVisit, id: "first_visit" }, testUuid("first-visit")),
			],
			afterOperationUuid: null,
		});
		const removed = await h.runTool(removeCaseOperationTool, {
			moduleUuid,
			formUuid,
			operationUuid: own,
		});
		const movedOwn = await h.runTool(moveCaseOperationTool, {
			moduleUuid,
			formUuid,
			operationUuid: own,
			afterOperationUuid: CREATE_UUID,
		});
		const movedAbove = await h.runTool(moveCaseOperationTool, {
			moduleUuid,
			formUuid,
			operationUuid: CREATE_UUID,
			afterOperationUuid: null,
		});

		for (const refused of [added, removed, movedOwn, movedAbove])
			expect(refused.result).toEqual({ error: OWN_CASE_OPERATION_REFUSAL });
		expect(h.recordMutations).not.toHaveBeenCalled();
		expect(
			h.currentDoc().forms[formUuid].caseOperations?.map((op) => op.uuid),
		).toEqual([own, CREATE_UUID]);
	});

	it("reads the own case first, each change with where CommCare HQ keeps it", async () => {
		const { doc, moduleUuid, formUuid } = fixture();
		const h = makeToolWorkspaceHarness(doc);
		await h.runTool(addCaseOperationsTool, {
			moduleUuid,
			formUuid,
			operations: visitBatch(),
		});
		const read = await h.runTool(getCaseOperationsTool, {
			moduleUuid,
			formUuid,
		});

		// The authored read every client sees: the projector puts each
		// change's placement on it.
		const authored = projectAuthoringRead({
			toolName: "getCaseOperations",
			data: read.data,
			doc: h.currentDoc(),
		});
		const operations = readOperations(authored);
		expect(operations[0]?.operation).toMatchObject({
			uuid: ownOf(doc, formUuid),
			action: "own",
		});
		// The read relays the placement planner the export reads: a plain
		// write of the loaded case is kept in Case Management.
		expect(operations[0]?.placement).toBe("case management");
		const view = formCasePlacementView(h.currentDoc(), formUuid);
		expect(operations.map(({ placement }) => placement)).toEqual(
			view.operations.map(({ entry }) => wordsOf(entry)),
		);
		expect(authored).not.toHaveProperty("placements");
	});

	it("reads a change an advanced menu's form keeps in case actions", async () => {
		// Households as a publish recorded it advanced: its forms' changes are
		// held where an advanced form keeps them.
		const doc = expectAdmittedDoc(publishedAdvanced(kindFixture(), HOUSEHOLDS));
		expect(emittedModuleKind(doc, HOUSEHOLDS)).toBe("advanced");
		const h = makeToolWorkspaceHarness(doc);
		const read = await h.runTool(getCaseOperationsTool, {
			moduleUuid: HOUSEHOLDS,
			formUuid: HOUSEHOLD_VISIT,
		});
		const operations = readOperations(
			projectAuthoringRead({
				toolName: "getCaseOperations",
				data: read.data,
				doc: h.currentDoc(),
			}),
		);
		expect(operations[0]?.operation).toMatchObject({ action: "own" });
		expect(operations[0]?.placement).toBe("case actions");
		const view = formCasePlacementView(h.currentDoc(), HOUSEHOLD_VISIT);
		expect(operations.map(({ placement }) => placement)).toEqual(
			view.operations.map(({ entry }) => wordsOf(entry)),
		);
	});
});

describe("saves to a case above, changed answers and the worker's record", () => {
	const PATIENT_NAME = testUuid("above-patient-name");
	const REGISTER_NAME = testUuid("above-register-name");
	const toHousehold = [{ identifier: "parent" }] as const;

	/** A patient whose parent is a household with an `address`, edited by
	 *  a follow-up form and registered by a registration form. */
	function aboveFixture(): {
		readonly doc: BlueprintDoc;
		readonly moduleUuid: Uuid;
		readonly followupUuid: Uuid;
		readonly registrationUuid: Uuid;
	} {
		const doc = buildDoc({
			caseTypes: [
				{
					name: "household",
					properties: [
						{ name: "address", label: "Address", data_type: "text" },
					],
				},
				{
					name: "patient",
					parent_type: "household",
					properties: [
						{ name: "nickname", label: "Nickname", data_type: "text" },
					],
				},
			],
			modules: [
				{
					id: "patients",
					name: "Patients",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "nickname", header: "Nickname" },
					]),
					forms: [
						{
							id: "edit",
							name: "Edit",
							type: "followup",
							fields: [
								f({
									uuid: PATIENT_NAME,
									kind: "text",
									id: "nickname",
									label: proseText("Nickname"),
									caseWrite: { caseType: "patient", property: "nickname" },
								}),
							],
						},
						{
							id: "register",
							name: "Register",
							type: "registration",
							fields: [
								f({
									uuid: REGISTER_NAME,
									kind: "text",
									id: "case_name",
									label: proseText("Name"),
									caseWrite: { caseType: "patient", property: "case_name" },
								}),
							],
						},
					],
				},
			],
		});
		const moduleUuid = doc.moduleOrder[0];
		return {
			doc: expectAdmittedDoc(doc),
			moduleUuid,
			followupUuid: doc.formOrder[moduleUuid][0],
			registrationUuid: doc.formOrder[moduleUuid][1],
		};
	}

	function ownWritesOf(doc: BlueprintDoc, formUuid: Uuid) {
		const own = doc.forms[formUuid].caseOperations?.[0];
		if (own?.action !== "own") throw new Error("fixture own case");
		return own.writes ?? [];
	}

	/** The gate's own findings of `code` for the candidate the own arm's
	 *  edit plans, read from the validator rather than restated here. */
	function gateFindings(
		doc: BlueprintDoc,
		formUuid: Uuid,
		writes: readonly CaseOperationWrite[],
		code: ValidationErrorCode,
	) {
		const own = doc.forms[formUuid].caseOperations?.[0];
		if (own?.action !== "own") throw new Error("fixture own case");
		const plan = planCaseOperationUpdate(doc, formUuid, {
			...own,
			writes: [...writes],
		});
		if (!plan.ok) throw new Error(plan.reason);
		return runValidation(
			applyToDoc(doc, plan.mutations),
			LOOKUP_CONTEXT_UNAVAILABLE,
		).filter((error) => error.code === code);
	}

	const toAddress = {
		property: "address",
		value: { kind: "term", term: { kind: "field", uuid: PATIENT_NAME } },
		via: [...toHousehold],
	} as const;

	it("commits a save to the parent of a follow-up's own case, and one only if changed", async () => {
		const { doc, moduleUuid, followupUuid } = aboveFixture();
		const h = makeToolWorkspaceHarness(doc);
		// The nickname question's save, made to save only a changed answer,
		// beside a save of the same answer to the household's address.
		const writes = [
			...ownWritesOf(doc, followupUuid).map((write) =>
				write.property === "nickname"
					? { ...write, onlyIfChanged: true as const }
					: write,
			),
			toAddress,
		];

		const result = await h.runTool(updateCaseOperationTool, {
			moduleUuid,
			formUuid: followupUuid,
			operationUuid: ownOf(doc, followupUuid),
			operation: { action: "own", writes },
		});

		expect(result.result).not.toHaveProperty("error");
		expect(h.recordMutations).toHaveBeenCalledTimes(1);
		const after = ownWritesOf(h.currentDoc(), followupUuid);
		expect(after).toContainEqual({
			property: "address",
			value: toAddress.value,
			via: [{ identifier: "parent" }],
		});
		expect(after).toContainEqual(
			expect.objectContaining({ property: "nickname", onlyIfChanged: true }),
		);
		expectAdmittedDoc(h.currentDoc());
	});

	it("leaves a registration's save to the case above to the gate, which refuses it", async () => {
		const { doc, moduleUuid, registrationUuid } = aboveFixture();
		const h = makeToolWorkspaceHarness(doc);
		const writes = [
			...ownWritesOf(doc, registrationUuid),
			{
				...toAddress,
				value: { kind: "term", term: { kind: "field", uuid: REGISTER_NAME } },
			} as const,
		];
		const [finding] = gateFindings(
			doc,
			registrationUuid,
			writes as CaseOperationWrite[],
			"CASE_WRITE_VIA_INVALID",
		);
		expect(finding?.details).toMatchObject({ reason: "new-case" });

		const result = await h.runTool(updateCaseOperationTool, {
			moduleUuid,
			formUuid: registrationUuid,
			operationUuid: ownOf(doc, registrationUuid),
			operation: { action: "own", writes },
		});

		const error = z.object({ error: z.string() }).parse(result.result).error;
		expect(error).toContain(finding?.message);
		expect(h.recordMutations).not.toHaveBeenCalled();
		expect(h.currentDoc()).toEqual(doc);
	});

	it("refuses via and onlyIfChanged on every other arm's writes at the schema", async () => {
		const { doc, moduleUuid, followupUuid } = aboveFixture();
		const h = makeToolWorkspaceHarness(doc);
		const plain = {
			property: "nickname",
			value: { kind: "term", term: { kind: "field", uuid: PATIENT_NAME } },
		} as const;
		const arms = [
			{
				id: "make_patient",
				action: "create",
				caseType: "patient",
				target: { kind: "new" },
				name: plain.value,
			},
			{
				id: "tag_patient",
				action: "update",
				caseType: "patient",
				target: { kind: "session" },
			},
			{
				id: "close_patient",
				action: "close",
				caseType: "patient",
				target: { kind: "session" },
			},
		] as const;
		for (const arm of arms) {
			const accepted = { ...arm, writes: [plain] };
			expect(caseOperationInputSchema.safeParse(accepted).success).toBe(true);
			for (const facet of [
				{ via: [...toHousehold] },
				{ onlyIfChanged: true },
			]) {
				const refused = { ...arm, writes: [{ ...plain, ...facet }] };
				expect(caseOperationInputSchema.safeParse(refused).success).toBe(false);
				await expect(
					h.runTool(addCaseOperationsTool, {
						moduleUuid,
						formUuid: followupUuid,
						operations: [{ operation: refused }],
					}),
				).rejects.toBeInstanceOf(z.ZodError);
			}
		}
		expect(h.recordMutations).not.toHaveBeenCalled();
	});

	it("keys the duplicate check by the case a write saves to and its property", () => {
		const own = (writes: readonly unknown[]) =>
			updateCaseOperationInputSchema.safeParse({
				moduleUuid: testUuid("dup-module"),
				formUuid: testUuid("dup-form"),
				operationUuid: testUuid("dup-own"),
				operation: { action: "own", writes },
			});
		const here = { property: "address", value: toAddress.value } as const;
		expect(own([here, toAddress]).success).toBe(true);
		const twice = own([toAddress, toAddress]);
		expect(twice.success).toBe(false);
		expect(twice.error?.issues).toEqual([
			expect.objectContaining({
				path: ["operation", "writes", 1, "property"],
			}),
		]);
		const plainTwice = own([here, here]);
		expect(plainTwice.success).toBe(false);
		const noWalk = own([{ ...toAddress, via: [] }]);
		expect(noWalk.success).toBe(false);
		expect(noWalk.error?.issues).toEqual([
			expect.objectContaining({
				code: "too_small",
				path: ["operation", "writes", 0, "via"],
			}),
		]);
	});

	it("commits an update of the worker's own record", async () => {
		const { doc, moduleUuid, followupUuid } = aboveFixture();
		const h = makeToolWorkspaceHarness(doc);
		const workerUuid = testUuid("worker-record-update");
		const detail = await h.runTool(addUserPropertiesTool, {
			properties: [{ slug: "last_nickname", label: "Last nickname" }],
		});
		expect(detail.result).not.toHaveProperty("error");
		h.recordMutations.mockClear();
		const result = await h.runTool(addCaseOperationsTool, {
			moduleUuid,
			formUuid: followupUuid,
			operations: [
				{
					operationUuid: workerUuid,
					operation: {
						id: "save_worker",
						action: "update",
						caseType: "commcare-user",
						target: { kind: "worker-record" },
						writes: [
							{
								property: "last_nickname",
								value: {
									kind: "term",
									term: { kind: "field", uuid: PATIENT_NAME },
								},
							},
						],
					},
				},
			],
		});

		expect(result.result).not.toHaveProperty("error");
		expect(h.recordMutations).toHaveBeenCalledTimes(1);
		expect(
			h
				.currentDoc()
				.forms[followupUuid].caseOperations?.find(
					(operation) => operation.uuid === workerUuid,
				),
		).toMatchObject({
			action: "update",
			caseType: "commcare-user",
			target: { kind: "worker-record" },
		});
		expectAdmittedDoc(h.currentDoc());
	});

	it("refuses the worker's record on a create at the schema and on another type at the gate", async () => {
		const { doc, moduleUuid, followupUuid } = aboveFixture();
		const h = makeToolWorkspaceHarness(doc);
		const name = {
			kind: "term",
			term: { kind: "field", uuid: PATIENT_NAME },
		} as const;
		for (const caseType of ["commcare-user", "patient"]) {
			expect(
				caseOperationInputSchema.safeParse({
					id: "make_worker",
					action: "create",
					caseType,
					target: { kind: "worker-record" },
					name,
				}).success,
			).toBe(false);
		}
		// Only an update saves to the worker's record.
		expect(
			caseOperationInputSchema.safeParse({
				id: "close_worker",
				action: "close",
				caseType: "patient",
				target: { kind: "worker-record" },
			}).success,
		).toBe(false);
		// commcare-user stays platform-owned for every arm but an update.
		for (const action of ["create", "close"] as const) {
			expect(
				caseOperationInputSchema.safeParse({
					id: "touch_worker",
					action,
					caseType: "commcare-user",
					target: action === "create" ? { kind: "new" } : { kind: "session" },
					...(action === "create" && { name }),
				}).success,
			).toBe(false);
		}

		const patientWorker = {
			id: "save_worker",
			action: "update",
			caseType: "patient",
			target: { kind: "worker-record" },
		} as const satisfies CaseOperationInput;
		const candidate = applyToDoc(
			doc,
			addCaseOperationAfterMutations(
				doc,
				followupUuid,
				resolveCaseOperationInput(
					patientWorker,
					testUuid("patient-worker-update"),
				),
				undefined,
			),
		);
		const [finding] = runValidation(
			candidate,
			LOOKUP_CONTEXT_UNAVAILABLE,
		).filter((error) => error.code === "CASE_OPERATION_TARGET_INVALID");
		expect(finding?.details).toMatchObject({ reason: "worker-record-type" });

		const result = await h.runTool(addCaseOperationsTool, {
			moduleUuid,
			formUuid: followupUuid,
			operations: [
				{
					operationUuid: testUuid("patient-worker-update"),
					operation: patientWorker,
				},
			],
		});
		const error = z.object({ error: z.string() }).parse(result.result).error;
		expect(error).toContain(finding?.message);
		expect(h.recordMutations).not.toHaveBeenCalled();
		expect(h.currentDoc()).toEqual(doc);
	});
});
