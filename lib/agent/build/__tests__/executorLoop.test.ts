/** Pure accepted-design admission and identity projections. Native execution
 * and durable recovery are exercised in executorLoop.postgres.test.ts. */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f, xp } from "@/lib/__tests__/docHelpers";
import {
	cloneContract,
	fixtureValue,
	ids,
	makeBuildPlan,
	makeContract,
	makeNestedMenuContract,
} from "@/lib/agent/design/__tests__/fixtures";
import { deriveBuildPlan } from "@/lib/agent/design/buildPlan";
import { appDesignContractSchema } from "@/lib/agent/design/contract";
import { assertAdmittedDoc } from "@/lib/doc/__tests__/admittedDoc";
import type { LookupValidationContext } from "@/lib/doc/lookupReferences";
import { emptyBlueprintDoc } from "@/lib/doc/scaffolds";
import {
	type BlueprintDoc,
	emptyCaseListConfig,
	proseText,
} from "@/lib/domain";
import { acceptedInputRequirementIssues } from "../acceptedInputParity";
import { acceptedSelectionRealizationIssues } from "../acceptedSelectionParity";
import {
	deriveSliceExecutionBrief,
	type SliceExecutionBrief,
} from "../executionBrief";
import {
	compositionAdmissionIssue,
	type ExecutorWorkspace,
	renderExecutorWorkspaceSummary,
} from "../executorLoop";

function caseListConfig(
	name = "patient-name",
): ReturnType<typeof emptyCaseListConfig> {
	return {
		...emptyCaseListConfig(),
		columns: [
			{
				uuid: testUuid(name),
				kind: "plain",
				field: "case_name",
				header: "Name",
			},
		],
		listColumnOrder: [testUuid(name)],
		detailColumnOrder: [testUuid(name)],
	};
}
function brief(): SliceExecutionBrief {
	const plan = makeBuildPlan();
	return deriveSliceExecutionBrief({
		contract: makeContract(),
		revision: { id: ids.revisionId, digest: "b".repeat(64) },
		plan,
		sliceId: fixtureValue(plan.slices[0], "first slice").id,
	});
}

function severalVisitBrief(): SliceExecutionBrief {
	const contract = cloneContract(makeContract());
	fixtureValue(contract.moduleCompositions[0], "patient module").selection = {
		workflowIds: [ids.taskVisit],
		cases: "several",
		maximum: 12,
	};
	const plan = deriveBuildPlan({
		contract,
		revision: { id: ids.revisionId, digest: "b".repeat(64) },
	});
	const slice = fixtureValue(
		plan.slices.find((entry) => entry.workflowId === ids.taskVisit),
		"visit workflow slice",
	);
	return deriveSliceExecutionBrief({
		contract,
		revision: { id: ids.revisionId, digest: "b".repeat(64) },
		plan,
		sliceId: slice.id,
	});
}

function acceptedWorkspaceFixture(): {
	readonly doc: BlueprintDoc;
	readonly handles: ReturnType<
		ExecutorWorkspace["currentExecutionCheckpoint"]
	>["handles"];
} {
	const sliceBrief = brief();
	const realization = fixtureValue(
		sliceBrief.moduleRealizations[0],
		"accepted module realization",
	);
	const composition = fixtureValue(
		sliceBrief.moduleCompositions.find(
			(entry) => entry.id === realization.compositionId,
		),
		"accepted module composition",
	);
	const caseType = realization.hostRecord?.blueprintCaseType;
	const doc = buildDoc({
		appName: sliceBrief.charter.appName,
		...(caseType === undefined
			? {}
			: { caseTypes: [{ name: caseType, properties: [] }] }),
		modules: [
			{
				name: composition.name,
				...(caseType === undefined
					? {}
					: { caseType, caseListConfig: caseListConfig() }),
				forms: [
					{
						name: "Record visit",
						type: "followup",
						fields: [
							f({ id: "notes", kind: "text", label: proseText("Notes") }),
						],
					},
				],
			},
		],
	});
	assertAdmittedDoc(doc);
	const moduleUuid = fixtureValue(doc.moduleOrder[0], "accepted module");
	return {
		doc,
		handles: [
			{
				handle: realization.blueprintModuleHandle,
				uuid: moduleUuid,
				entityKind: "module",
			},
		],
	};
}

function readonlyWorkspace(options: {
	doc: BlueprintDoc;
	lookupContext?: LookupValidationContext;
	resolveDesignLookupReferences?: (value: unknown) => unknown;
}): ExecutorWorkspace {
	if (options.doc.moduleOrder.length > 0)
		assertAdmittedDoc(options.doc, options.lookupContext);
	return {
		currentSnapshot: () => ({
			doc: options.doc,
			revision: 0,
			canonicalSeq: null,
			projectId: "projection-project",
		}),
		currentExecutionCheckpoint: () => ({ handles: [] }),
		resolveDesignLookupReferences: (value) =>
			options.resolveDesignLookupReferences?.(value) ?? value,
		async stageDispatch() {
			throw new Error("Pure admission must not dispatch tools");
		},
		async inspect() {
			throw new Error("Pure admission must not finalize a workspace");
		},
	};
}
function severalSelectionWorkspace(
	sliceBrief: SliceExecutionBrief,
	maximum?: number,
): ExecutorWorkspace {
	const realization = fixtureValue(
		sliceBrief.moduleRealizations.find(
			(entry) => entry.selectionRealization?.cases === "several",
		),
		"several-case module realization",
	);
	const composition = fixtureValue(
		sliceBrief.moduleCompositions.find(
			(entry) => entry.id === realization.compositionId,
		),
		"several-case module composition",
	);
	const caseType = fixtureValue(
		realization.hostRecord?.blueprintCaseType,
		"several-case module type",
	);
	const doc = buildDoc({
		appName: sliceBrief.charter.appName,
		caseTypes: [{ name: caseType, properties: [] }],
		modules: [
			{
				name: composition.name,
				caseType,
				caseListConfig: {
					...caseListConfig(),
					...(maximum === undefined
						? {}
						: { selection: { kind: "multiple" as const, maximum } }),
				},
				forms: [
					{
						name: "Record visit",
						type: "followup",
						fields: [
							f({ id: "notes", kind: "text", label: proseText("Notes") }),
						],
					},
				],
			},
		],
	});
	const moduleUuid = fixtureValue(doc.moduleOrder[0], "several-case module");
	const workspace = readonlyWorkspace({
		doc,
	});
	workspace.currentExecutionCheckpoint = () => ({
		handles: [
			{
				handle: realization.blueprintModuleHandle,
				uuid: moduleUuid,
				entityKind: "module",
			},
		],
	});
	return workspace;
}

describe("executor workspace overview", () => {
	it("keeps names and usable identities while leaving field details to focused reads", () => {
		const doc = buildDoc({
			appName: "Visits",
			modules: [
				{
					name: "Visits",
					forms: [
						{
							name: "Visit",
							type: "survey",
							fields: Array.from({ length: 30 }, (_, index) =>
								f({
									kind: "text",
									id: `answer_${index}`,
									label: proseText(
										"Detailed wording belongs in a focused read",
									),
								}),
							),
						},
					],
				},
			],
		});
		const overview = renderExecutorWorkspaceSummary(readonlyWorkspace({ doc }));
		expect(overview).toContain("Visit");
		expect(overview).toContain(doc.moduleOrder[0]);
		expect(overview).toContain("+18 more");
		expect(overview).not.toContain(
			"Detailed wording belongs in a focused read",
		);
		expect(overview).not.toContain("parts");
		expect(overview).not.toContain("unbound");
	});
});
describe("accepted selection realization parity", () => {
	it("finds several-case selection invented on an unmarked created module", () => {
		const sliceBrief = brief();
		const fixture = acceptedWorkspaceFixture();
		const moduleUuid = fixtureValue(
			fixture.doc.moduleOrder[0],
			"created module",
		);
		const module = fixtureValue(
			fixture.doc.modules[moduleUuid],
			"created module body",
		);
		const config = fixtureValue(module.caseListConfig, "created case list");
		const doc: BlueprintDoc = {
			...fixture.doc,
			modules: {
				...fixture.doc.modules,
				[moduleUuid]: {
					...module,
					caseListConfig: {
						...config,
						selection: { kind: "multiple", maximum: 9 },
					},
				},
			},
		};
		assertAdmittedDoc(doc);

		expect(
			acceptedSelectionRealizationIssues(doc, sliceBrief, fixture.handles),
		).toMatchObject([
			{
				code: "ACCEPTED_CASE_SELECTION_MISMATCH",
				location: { kind: "module", moduleUuid },
				details: {
					action: "unmarked-create",
					acceptedSelection: null,
					realizedSelection: { kind: "multiple", maximum: 9 },
				},
			},
		]);
	});
});
describe("accepted input requirement parity", () => {
	function visitBrief(requiredWhen?: string): SliceExecutionBrief {
		const base = makeContract();
		const contract = appDesignContractSchema.parse({
			...base,
			workflows: base.workflows.map((workflow) =>
				workflow.id !== ids.taskVisit
					? workflow
					: {
							...workflow,
							inputs: workflow.inputs.map((input) =>
								input.handle !== "visit_summary" || requiredWhen === undefined
									? input
									: { ...input, requiredWhen },
							),
						},
			),
		});
		const plan = deriveBuildPlan({
			contract,
			revision: { id: ids.revisionId, digest: "b".repeat(64) },
		});
		const slice = fixtureValue(
			plan.slices.find((entry) => entry.workflowId === ids.taskVisit),
			"visit workflow slice",
		);
		return deriveSliceExecutionBrief({
			contract,
			revision: { id: ids.revisionId, digest: "b".repeat(64) },
			plan,
			sliceId: slice.id,
		});
	}

	function visitDoc(required: boolean): BlueprintDoc {
		const doc = buildDoc({
			appName: "Patient tracker",
			caseTypes: [{ name: "patient", properties: [] }],
			modules: [
				{
					name: "Patient care",
					caseType: "patient",
					caseListConfig: caseListConfig(),
					forms: [
						{
							name: "Record visit",
							type: "followup",
							fields: [
								{
									kind: "group",
									id: "visit_notes",
									children: [
										{
											kind: "text",
											id: "visit_summary",
											...(required && { required: xp("true()") }),
										},
									],
								},
							],
						},
					],
				},
			],
		});
		assertAdmittedDoc(doc);
		return doc;
	}

	function visitHandles(doc: BlueprintDoc, sliceBrief: SliceExecutionBrief) {
		const moduleUuid = fixtureValue(doc.moduleOrder[0], "visit module");
		const realization = fixtureValue(
			sliceBrief.moduleRealizations[0],
			"visit module realization",
		);
		return [
			{
				handle: realization.blueprintModuleHandle,
				uuid: moduleUuid,
				entityKind: "module",
			},
		];
	}

	it("rejects record-level requiredness that leaked onto an optional workflow input", () => {
		const doc = visitDoc(true);
		const sliceBrief = visitBrief();
		const issues = acceptedInputRequirementIssues(
			doc,
			sliceBrief,
			visitHandles(doc, sliceBrief),
		);
		expect(issues).toHaveLength(1);
		expect(issues[0]).toMatchObject({
			code: "ACCEPTED_INPUT_REQUIREMENT_MISMATCH",
			details: {
				inputHandle: "visit_summary",
				blueprintFieldId: "visit_summary",
				acceptedRequiredWhen: null,
				realizedRequired: true,
			},
		});
	});

	it("requires the realized field to carry an accepted input requirement", () => {
		const missingDoc = visitDoc(false);
		const requiredBrief = visitBrief("Always during a visit");
		const issues = acceptedInputRequirementIssues(
			missingDoc,
			requiredBrief,
			visitHandles(missingDoc, requiredBrief),
		);
		expect(issues).toHaveLength(1);
		expect(issues[0]?.details).toMatchObject({
			acceptedRequiredWhen: "Always during a visit",
			realizedRequired: false,
		});
		const realizedDoc = visitDoc(true);
		expect(
			acceptedInputRequirementIssues(
				realizedDoc,
				requiredBrief,
				visitHandles(realizedDoc, requiredBrief),
			),
		).toEqual([]);
	});
});

describe("accepted composition admission", () => {
	it("admits case-selection configuration only for the exact brief realization", () => {
		const sliceBrief = severalVisitBrief();
		const workspace = severalSelectionWorkspace(sliceBrief);
		const exactInput = {
			moduleUuid: workspace.currentSnapshot().doc.moduleOrder[0],
			selection: { kind: "multiple", maximum: 12 },
		};

		expect(
			compositionAdmissionIssue(
				"configureCaseSelection",
				exactInput,
				sliceBrief,
				workspace,
			),
		).toBeNull();
		expect(
			compositionAdmissionIssue(
				"configureCaseSelection",
				{
					...exactInput,
					selection: { kind: "multiple", maximum: 10 },
				},
				sliceBrief,
				workspace,
			),
		).toContain("exact accepted selectionRealization");
		expect(
			compositionAdmissionIssue(
				"configureCaseSelection",
				{ ...exactInput, moduleUuid: ids.moduleVisits },
				sliceBrief,
				workspace,
			),
		).toContain("exact module");
		expect(
			compositionAdmissionIssue(
				"configureCaseSelection",
				{ ...exactInput, confirmedModuleUuids: [ids.moduleVisits] },
				sliceBrief,
				workspace,
			),
		).toContain("Every confirmed case-selection transition");
	});

	it("admits createModule selection only for an exact create-with-module realization", () => {
		const base = brief();
		const realization = fixtureValue(
			base.moduleRealizations.find((entry) => entry.action === "create"),
			"created module realization",
		);
		const composition = fixtureValue(
			base.moduleCompositions.find(
				(entry) => entry.id === realization.compositionId,
			),
			"created module composition",
		);
		const input = {
			moduleUuid: realization.compositionId,
			name: composition.name,
			case_type: realization.hostRecord?.blueprintCaseType ?? null,
		};
		const workspace = readonlyWorkspace({ doc: emptyBlueprintDoc("creation") });

		expect(
			compositionAdmissionIssue(
				"createModule",
				{ ...input, selection: { kind: "multiple", maximum: 12 } },
				base,
				workspace,
			),
		).toContain("has no create-with-module selectionRealization");
		expect(
			compositionAdmissionIssue("createModule", input, base, workspace),
		).toBeNull();

		const createWithSelection: SliceExecutionBrief = {
			...base,
			moduleRealizations: base.moduleRealizations.map((entry) =>
				entry.compositionId === realization.compositionId
					? {
							...entry,
							selectionRealization: {
								action: "create-with-module",
								workflowIds: [base.workflow.id],
								cases: "several",
								maximum: 12,
								selection: { kind: "multiple", maximum: 12 },
							},
						}
					: entry,
			),
		};
		expect(
			compositionAdmissionIssue(
				"createModule",
				{ ...input, selection: { kind: "multiple", maximum: 10 } },
				createWithSelection,
				workspace,
			),
		).toContain("exact accepted create-with-module");
		expect(
			compositionAdmissionIssue(
				"createModule",
				{ ...input, selection: { kind: "multiple", maximum: 12 } },
				createWithSelection,
				workspace,
			),
		).toBeNull();
	});

	it("allows a child viewer to bootstrap top-level until its parent exists", () => {
		const contract = makeNestedMenuContract();
		const childComposition = fixtureValue(
			contract.moduleCompositions.find(
				(composition) => composition.id === ids.moduleVisits,
			),
			"child module composition",
		);
		const plan = deriveBuildPlan({
			contract,
			revision: { id: ids.revisionId, digest: "b".repeat(64) },
		});
		const slice = fixtureValue(
			plan.slices.find((entry) => entry.workflowId === ids.taskVisit),
			"child slice",
		);
		const sliceBrief = deriveSliceExecutionBrief({
			contract,
			revision: { id: ids.revisionId, digest: "b".repeat(64) },
			plan,
			sliceId: slice.id,
		});
		const childRealization = fixtureValue(
			sliceBrief.moduleRealizations.find(
				(realization) => realization.compositionId === ids.moduleVisits,
			),
			"child realization",
		);
		const workspace = readonlyWorkspace({
			doc: emptyBlueprintDoc("app-executor-test"),
		});

		expect(
			compositionAdmissionIssue(
				"createModule",
				{
					moduleUuid: childRealization.compositionId,
					name: childComposition.name,
					case_type: childRealization.hostRecord?.blueprintCaseType,
					forms: [],
				},
				sliceBrief,
				workspace,
			),
		).toBeNull();
	});

	it("uses exact construction identity to distinguish equal module semantics", () => {
		const contract = makeNestedMenuContract();
		const parentComposition = fixtureValue(
			contract.moduleCompositions.find(
				(composition) => composition.id === ids.modulePatients,
			),
			"parent module composition",
		);
		const childComposition = fixtureValue(
			contract.moduleCompositions.find(
				(composition) => composition.id === ids.moduleVisits,
			),
			"child module composition",
		);
		childComposition.name = parentComposition.name;
		childComposition.parentModuleCompositionId = undefined;
		const plan = deriveBuildPlan({
			contract,
			revision: { id: ids.revisionId, digest: "b".repeat(64) },
		});
		const slice = fixtureValue(
			plan.slices.find((entry) => entry.workflowId === ids.taskVisit),
			"second root slice",
		);
		const sliceBrief = deriveSliceExecutionBrief({
			contract,
			revision: { id: ids.revisionId, digest: "b".repeat(64) },
			plan,
			sliceId: slice.id,
		});
		const parentRealization = fixtureValue(
			sliceBrief.moduleRealizations.find(
				(realization) => realization.compositionId === ids.modulePatients,
			),
			"parent realization",
		);
		const childRealization = fixtureValue(
			sliceBrief.moduleRealizations.find(
				(realization) => realization.compositionId === ids.moduleVisits,
			),
			"child realization",
		);
		const doc = buildDoc({
			caseTypes: [{ name: "patient", properties: [] }],
			modules: [
				{
					name: parentComposition.name,
					caseType: "patient",
					caseListConfig: caseListConfig(),
					caseListOnly: true,
					forms: [],
				},
			],
		});
		const parentUuid = fixtureValue(doc.moduleOrder[0], "parent module");
		const workspace = readonlyWorkspace({ doc });
		workspace.currentExecutionCheckpoint = () => ({
			handles: [
				{
					handle: parentRealization.blueprintModuleHandle,
					uuid: parentUuid,
					entityKind: "module",
				},
			],
		});
		const input = {
			name: childComposition.name,
			case_type: "patient",
			forms: [],
		};
		expect(
			compositionAdmissionIssue(
				"createModule",
				{
					...input,
					moduleUuid: childRealization.compositionId,
				},
				sliceBrief,
				workspace,
			),
		).toBeNull();
		expect(
			compositionAdmissionIssue(
				"createModule",
				{
					...input,
					moduleUuid: parentUuid,
				},
				sliceBrief,
				workspace,
			),
		).toContain("accepted identity");
	});

	it("keeps a selected-record form on the accepted host module", () => {
		const base = makeContract();
		const contract = appDesignContractSchema.parse({
			...base,
			records: base.records.map((record) => ({
				...record,
				name:
					record.id === ids.recPatient
						? "Beneficiary"
						: record.id === ids.recVisit
							? "Referral"
							: record.name,
			})),
		});
		const plan = deriveBuildPlan({
			contract,
			revision: { id: ids.revisionId, digest: "b".repeat(64) },
		});
		const slice = fixtureValue(
			plan.slices.find((entry) => entry.workflowId === ids.taskVisit),
			"referral workflow slice",
		);
		const visitBrief = deriveSliceExecutionBrief({
			contract,
			revision: { id: ids.revisionId, digest: "b".repeat(64) },
			plan,
			sliceId: slice.id,
		});
		const doc = buildDoc({
			appName: "Referral tracker",
			caseTypes: [
				{ name: "beneficiary", properties: [] },
				{ name: "referral", properties: [] },
			],
			modules: [
				{
					name: "Beneficiaries",
					caseType: "beneficiary",
					caseListConfig: caseListConfig("beneficiary-name"),
					caseListOnly: true,
					forms: [],
				},
				{
					name: "Referrals",
					caseType: "referral",
					caseListConfig: caseListConfig("referral-name"),
					caseListOnly: true,
					forms: [],
				},
			],
		});
		const beneficiaryModuleUuid = fixtureValue(
			doc.moduleOrder[0],
			"beneficiary module",
		);
		const referralModuleUuid = fixtureValue(
			doc.moduleOrder[1],
			"referral module",
		);
		const acceptedModuleHandle = fixtureValue(
			visitBrief.moduleRealizations.find(
				(realization) => realization.compositionId === ids.modulePatients,
			),
			"accepted beneficiary module realization",
		).blueprintModuleHandle;
		const workspace = readonlyWorkspace({ doc });
		workspace.currentExecutionCheckpoint = () => ({
			handles: [
				{
					handle: acceptedModuleHandle,
					uuid: beneficiaryModuleUuid,
					entityKind: "module",
				},
				{
					handle: "@referrals",
					uuid: referralModuleUuid,
					entityKind: "module",
				},
			],
		});
		expect(
			compositionAdmissionIssue(
				"createForm",
				{
					moduleUuid: referralModuleUuid,
					formUuid: visitBrief.formRealizations[0].compositionId,
					name: "Record visit",
					type: "followup",
				},
				visitBrief,
				workspace,
			),
		).toContain("child/outcome record");
		expect(
			compositionAdmissionIssue(
				"createForm",
				{
					moduleUuid: beneficiaryModuleUuid,
					formUuid: visitBrief.formRealizations[0].compositionId,
					name: "Record visit",
					type: "followup",
				},
				visitBrief,
				workspace,
			),
		).toBeNull();
	});
});
