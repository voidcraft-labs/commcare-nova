import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	type BlueprintDoc,
	type CaseSelection,
	emptyCaseListConfig,
	type Form,
	type Module,
	type Uuid,
} from "@/lib/domain";
import {
	planCaseSelectionChange,
	planCaseSelectionTransition,
} from "../caseSelectionMutations";

const MODULE_UUID = testUuid("case-selection-planner-module");
const TARGET_MODULE_UUID = testUuid("case-selection-planner-target-module");
const OTHER_TARGET_MODULE_UUID = testUuid(
	"case-selection-planner-other-target-module",
);
const SOURCE_FORM_UUID = testUuid("case-selection-planner-source-form");
const TARGET_FORM_UUID = testUuid("case-selection-planner-target-form");
const OTHER_TARGET_FORM_UUID = testUuid(
	"case-selection-planner-other-target-form",
);
const LINK_UUID = testUuid("case-selection-planner-link");
const OTHER_LINK_UUID = testUuid("case-selection-planner-other-link");

function moduleWith(config: Module["caseListConfig"]): Module {
	return {
		uuid: MODULE_UUID,
		id: "visits",
		name: "Visits",
		caseType: "visit",
		...(config !== undefined && { caseListConfig: config }),
	};
}

function linkedDoc(args?: {
	readonly sourceSelection?: CaseSelection;
	readonly targetSelection?: CaseSelection;
	readonly targetTile?: NonNullable<Module["caseListConfig"]>["tile"];
	readonly secondTarget?: boolean;
	readonly targetCaseType?: string;
	readonly targetFormType?: Form["type"];
	readonly targetKind?: "form" | "module";
	readonly authoredDatums?: boolean;
}): BlueprintDoc {
	const source: Module = {
		...moduleWith({
			...emptyCaseListConfig(),
			...(args?.sourceSelection !== undefined && {
				selection: args.sourceSelection,
			}),
		}),
		name: "Visits",
	};
	const target: Module = {
		...moduleWith({
			...emptyCaseListConfig(),
			...(args?.targetSelection !== undefined && {
				selection: args.targetSelection,
			}),
			...(args?.targetTile !== undefined && { tile: args.targetTile }),
		}),
		uuid: TARGET_MODULE_UUID,
		id: "review_visits",
		name: "Review visits",
		caseType: args?.targetCaseType ?? "visit",
	};
	const otherTarget: Module = {
		...moduleWith(emptyCaseListConfig()),
		uuid: OTHER_TARGET_MODULE_UUID,
		id: "close_visits",
		name: "Close visits",
	};
	const targetKind = args?.targetKind ?? "form";
	const sourceForm: Form = {
		uuid: SOURCE_FORM_UUID,
		id: "visit",
		name: "Visit",
		type: "followup",
		formLinks: [
			{
				uuid: LINK_UUID,
				target:
					targetKind === "form"
						? {
								type: "form",
								moduleUuid: TARGET_MODULE_UUID,
								formUuid: TARGET_FORM_UUID,
							}
						: { type: "module", moduleUuid: TARGET_MODULE_UUID },
				...(args?.authoredDatums === true && {
					datums: [
						{
							name: "case_id",
							xpath: { parts: [{ kind: "text", text: "case-id" }] },
						},
					],
				}),
			},
			...(args?.secondTarget === true
				? [
						{
							uuid: OTHER_LINK_UUID,
							target: {
								type: "form" as const,
								moduleUuid: OTHER_TARGET_MODULE_UUID,
								formUuid: OTHER_TARGET_FORM_UUID,
							},
						},
					]
				: []),
		],
	};
	const targetForm: Form = {
		uuid: TARGET_FORM_UUID,
		id: "review",
		name: "Review",
		type: args?.targetFormType ?? "followup",
	};
	const otherTargetForm: Form = {
		uuid: OTHER_TARGET_FORM_UUID,
		id: "close",
		name: "Close",
		type: "close",
	};
	const modules: Record<Uuid, Module> = {
		[MODULE_UUID]: source,
		[TARGET_MODULE_UUID]: target,
		...(args?.secondTarget === true && {
			[OTHER_TARGET_MODULE_UUID]: otherTarget,
		}),
	};
	const forms: Record<Uuid, Form> = {
		[SOURCE_FORM_UUID]: sourceForm,
		[TARGET_FORM_UUID]: targetForm,
		...(args?.secondTarget === true && {
			[OTHER_TARGET_FORM_UUID]: otherTargetForm,
		}),
	};
	return {
		appId: "case-selection-planner",
		appName: "Planner",
		connectType: null,
		caseTypes: null,
		modules,
		forms,
		fields: {},
		moduleOrder: [
			MODULE_UUID,
			TARGET_MODULE_UUID,
			...(args?.secondTarget === true ? [OTHER_TARGET_MODULE_UUID] : []),
		],
		formOrder: {
			[MODULE_UUID]: [SOURCE_FORM_UUID],
			[TARGET_MODULE_UUID]: [TARGET_FORM_UUID],
			...(args?.secondTarget === true && {
				[OTHER_TARGET_MODULE_UUID]: [OTHER_TARGET_FORM_UUID],
			}),
		},
		fieldOrder: {
			[SOURCE_FORM_UUID]: [],
			[TARGET_FORM_UUID]: [],
			...(args?.secondTarget === true && {
				[OTHER_TARGET_FORM_UUID]: [],
			}),
		},
		fieldParent: {},
	};
}

function structuralDoc(args?: {
	readonly parentSelection?: CaseSelection;
	readonly childSelection?: CaseSelection;
	readonly childLoadsCase?: boolean;
}): BlueprintDoc {
	const parent: Module = {
		...moduleWith({
			...emptyCaseListConfig(),
			...(args?.parentSelection !== undefined && {
				selection: args.parentSelection,
			}),
		}),
		name: "Households",
		caseType: "household",
		caseListOnly: true,
	};
	const child: Module = {
		...moduleWith({
			...emptyCaseListConfig(),
			...(args?.childSelection !== undefined && {
				selection: args.childSelection,
			}),
		}),
		uuid: TARGET_MODULE_UUID,
		id: "household_visits",
		name: "Household visits",
		caseType: "household",
		parentModuleUuid: MODULE_UUID,
	};
	const childForm: Form = {
		uuid: TARGET_FORM_UUID,
		id: "visit",
		name: "Visit",
		type: args?.childLoadsCase === false ? "survey" : "followup",
	};
	return {
		appId: "case-selection-structural-planner",
		appName: "Structural planner",
		connectType: null,
		caseTypes: null,
		modules: { [MODULE_UUID]: parent, [TARGET_MODULE_UUID]: child },
		forms: { [TARGET_FORM_UUID]: childForm },
		fields: {},
		moduleOrder: [MODULE_UUID, TARGET_MODULE_UUID],
		formOrder: {
			[MODULE_UUID]: [],
			[TARGET_MODULE_UUID]: [TARGET_FORM_UUID],
		},
		fieldOrder: { [TARGET_FORM_UUID]: [] },
		fieldParent: {},
	};
}

describe("planCaseSelectionChange", () => {
	it("refuses a module without a case list", () => {
		expect(
			planCaseSelectionChange(moduleWith(undefined), {
				kind: "multiple",
				maximum: 10,
			}),
		).toEqual({ ok: false, reason: "missing-case-list" });
	});

	it("sets bounded multiple selection with one granular mutation", () => {
		expect(
			planCaseSelectionChange(moduleWith(emptyCaseListConfig()), {
				kind: "multiple",
				maximum: 10,
			}),
		).toEqual({
			ok: true,
			clearsPersistentTile: false,
			mutations: [
				{
					kind: "setCaseListMeta",
					uuid: MODULE_UUID,
					patch: { selection: { kind: "multiple", maximum: 10 } },
				},
			],
		});
	});

	it("clears to the canonical single-case state with JSON-stable null", () => {
		const plan = planCaseSelectionChange(
			moduleWith({
				...emptyCaseListConfig(),
				selection: { kind: "multiple", maximum: 5 },
			}),
			undefined,
		);
		expect(plan).toEqual({
			ok: true,
			clearsPersistentTile: false,
			mutations: [
				{
					kind: "setCaseListMeta",
					uuid: MODULE_UUID,
					patch: { selection: null },
				},
			],
		});
		expect(JSON.parse(JSON.stringify(plan))).toEqual(plan);
	});

	it("removes only persistent form tiles when multiple selection is enabled", () => {
		expect(
			planCaseSelectionChange(
				moduleWith({
					...emptyCaseListConfig(),
					tile: {
						persistOnForms: true,
						grouping: { identifier: "parent", headerRows: 1 },
					},
				}),
				{ kind: "multiple", maximum: 25 },
			),
		).toEqual({
			ok: true,
			clearsPersistentTile: true,
			mutations: [
				{
					kind: "setCaseListMeta",
					uuid: MODULE_UUID,
					patch: {
						selection: { kind: "multiple", maximum: 25 },
						tile: { grouping: { identifier: "parent", headerRows: 1 } },
					},
				},
			],
		});
	});

	it("returns a no-op when the requested state is already current", () => {
		expect(
			planCaseSelectionChange(
				moduleWith({
					...emptyCaseListConfig(),
					selection: { kind: "multiple", maximum: 3 },
				}),
				{ kind: "multiple", maximum: 3 },
			),
		).toEqual({ ok: true, mutations: [], clearsPersistentTile: false });
	});
});

describe("planCaseSelectionTransition", () => {
	it("returns every direct destination repair with its exact link location", () => {
		const plan = planCaseSelectionTransition(
			linkedDoc({ secondTarget: true }),
			{
				sourceModuleUuid: MODULE_UUID,
				selection: { kind: "multiple", maximum: 12 },
			},
		);

		expect(plan).toMatchObject({
			kind: "needs-coordination",
			transitions: [
				{
					moduleUuid: TARGET_MODULE_UUID,
					moduleName: "Review visits",
					selection: { kind: "multiple", maximum: 12 },
					reasons: [
						{
							kind: "form-link",
							linkUuid: LINK_UUID,
							sourceFormUuid: SOURCE_FORM_UUID,
							targetFormUuid: TARGET_FORM_UUID,
						},
					],
				},
				{
					moduleUuid: OTHER_TARGET_MODULE_UUID,
					moduleName: "Close visits",
					selection: { kind: "multiple", maximum: 12 },
				},
			],
		});
	});

	it("emits the source and confirmed destinations as one ordered batch", () => {
		const plan = planCaseSelectionTransition(
			linkedDoc({ targetTile: { persistOnForms: true } }),
			{
				sourceModuleUuid: MODULE_UUID,
				selection: { kind: "multiple", maximum: 12 },
				confirmedModuleUuids: [TARGET_MODULE_UUID],
			},
		);

		expect(plan.kind).toBe("ready");
		if (plan.kind !== "ready") return;
		expect(plan.mutations).toEqual([
			{
				kind: "setCaseListMeta",
				uuid: MODULE_UUID,
				patch: { selection: { kind: "multiple", maximum: 12 } },
			},
			{
				kind: "setCaseListMeta",
				uuid: TARGET_MODULE_UUID,
				patch: {
					selection: { kind: "multiple", maximum: 12 },
					tile: {},
				},
			},
		]);
		expect(plan.transitions[1]).toMatchObject({
			moduleUuid: TARGET_MODULE_UUID,
			clearsPersistentTile: true,
		});
	});

	it("retains a destination limit that already accepts the source", () => {
		const plan = planCaseSelectionTransition(
			linkedDoc({
				targetSelection: { kind: "multiple", maximum: 30 },
			}),
			{
				sourceModuleUuid: MODULE_UUID,
				selection: { kind: "multiple", maximum: 12 },
			},
		);

		expect(plan).toMatchObject({ kind: "ready" });
		if (plan.kind !== "ready") return;
		expect(plan.transitions).toHaveLength(1);
		expect(plan.mutations).toHaveLength(1);
	});

	it("coordinates a return to one-case selection", () => {
		const doc = linkedDoc({
			sourceSelection: { kind: "multiple", maximum: 10 },
			targetSelection: { kind: "multiple", maximum: 20 },
		});
		const initial = planCaseSelectionTransition(doc, {
			sourceModuleUuid: MODULE_UUID,
			selection: undefined,
		});
		expect(initial).toMatchObject({
			kind: "needs-coordination",
			transitions: [{ selection: undefined }],
		});

		const plan = planCaseSelectionTransition(doc, {
			sourceModuleUuid: MODULE_UUID,
			selection: undefined,
			confirmedModuleUuids: [TARGET_MODULE_UUID],
		});
		expect(plan).toMatchObject({
			kind: "ready",
			mutations: [
				{ uuid: MODULE_UUID, patch: { selection: null } },
				{ uuid: TARGET_MODULE_UUID, patch: { selection: null } },
			],
		});
	});

	it.each([
		["a module target", { targetKind: "module" as const }],
		["a non-case form", { targetFormType: "survey" as const }],
	])("does not carry selection through %s", (_label, setup) => {
		const plan = planCaseSelectionTransition(linkedDoc(setup), {
			sourceModuleUuid: MODULE_UUID,
			selection: { kind: "multiple", maximum: 5 },
		});
		expect(plan).toMatchObject({ kind: "ready" });
		if (plan.kind === "ready") expect(plan.transitions).toHaveLength(1);
	});

	it.each([
		["different-case-type" as const, { targetCaseType: "assessment" }],
		["authored-datums" as const, { authoredDatums: true }],
	])("locates a non-repairable %s form link", (reason, setup) => {
		const plan = planCaseSelectionTransition(linkedDoc(setup), {
			sourceModuleUuid: MODULE_UUID,
			selection: { kind: "multiple", maximum: 5 },
		});
		expect(plan).toMatchObject({
			kind: "blocked",
			blockers: [
				{
					kind: "form-link",
					reason,
					sourceModuleUuid: MODULE_UUID,
					sourceFormUuid: SOURCE_FORM_UUID,
					linkUuid: LINK_UUID,
					targetModuleUuid: TARGET_MODULE_UUID,
					targetFormUuid: TARGET_FORM_UUID,
				},
			],
		});
	});

	it("follows a transitive form-link closure and propagates its maximum", () => {
		const base = linkedDoc({
			secondTarget: true,
			targetSelection: { kind: "multiple", maximum: 30 },
		});
		const sourceForm = base.forms[SOURCE_FORM_UUID] as Form;
		const targetForm = base.forms[TARGET_FORM_UUID] as Form;
		const doc: BlueprintDoc = {
			...base,
			forms: {
				...base.forms,
				[SOURCE_FORM_UUID]: {
					...sourceForm,
					formLinks: (sourceForm.formLinks ?? []).slice(0, 1),
				},
				[TARGET_FORM_UUID]: {
					...targetForm,
					formLinks: [
						{
							uuid: OTHER_LINK_UUID,
							target: {
								type: "form",
								moduleUuid: OTHER_TARGET_MODULE_UUID,
								formUuid: OTHER_TARGET_FORM_UUID,
							},
						},
					],
				},
			},
		};

		const plan = planCaseSelectionTransition(doc, {
			sourceModuleUuid: MODULE_UUID,
			selection: { kind: "multiple", maximum: 12 },
		});
		expect(plan).toMatchObject({
			kind: "needs-coordination",
			transitions: [
				{
					moduleUuid: OTHER_TARGET_MODULE_UUID,
					selection: { kind: "multiple", maximum: 30 },
				},
			],
		});
	});

	it("preserves the exact source maximum across an incoming link", () => {
		const base = linkedDoc({
			targetSelection: { kind: "multiple", maximum: 20 },
		});
		const sourceForm = base.forms[SOURCE_FORM_UUID] as Form;
		const targetForm = base.forms[TARGET_FORM_UUID] as Form;
		const doc: BlueprintDoc = {
			...base,
			forms: {
				...base.forms,
				[SOURCE_FORM_UUID]: { ...sourceForm, formLinks: [] },
				[TARGET_FORM_UUID]: {
					...targetForm,
					formLinks: [
						{
							uuid: OTHER_LINK_UUID,
							target: {
								type: "form",
								moduleUuid: MODULE_UUID,
								formUuid: SOURCE_FORM_UUID,
							},
						},
					],
				},
			},
		};
		const plan = planCaseSelectionTransition(doc, {
			sourceModuleUuid: MODULE_UUID,
			selection: { kind: "multiple", maximum: 5 },
		});
		expect(plan).toMatchObject({
			kind: "needs-coordination",
			transitions: [
				{
					moduleUuid: TARGET_MODULE_UUID,
					selection: { kind: "multiple", maximum: 5 },
				},
			],
		});
	});

	it("coordinates a case-list-only parent with its batch-consuming child", () => {
		const plan = planCaseSelectionTransition(structuralDoc(), {
			sourceModuleUuid: MODULE_UUID,
			selection: { kind: "multiple", maximum: 8 },
		});
		expect(plan).toMatchObject({
			kind: "needs-coordination",
			transitions: [
				{
					moduleUuid: TARGET_MODULE_UUID,
					selection: { kind: "multiple", maximum: 8 },
					reasons: [{ kind: "structural-case-flow" }],
				},
			],
		});
	});

	it("coordinates an affected case-list-only parent without changing the source", () => {
		const plan = planCaseSelectionTransition(
			structuralDoc({
				parentSelection: { kind: "multiple", maximum: 20 },
				childSelection: { kind: "multiple", maximum: 20 },
			}),
			{
				sourceModuleUuid: TARGET_MODULE_UUID,
				selection: { kind: "multiple", maximum: 5 },
			},
		);
		expect(plan).toMatchObject({
			kind: "needs-coordination",
			transitions: [
				{
					moduleUuid: MODULE_UUID,
					selection: { kind: "multiple", maximum: 5 },
				},
			],
		});
	});

	it("locates a case-list-only parent with no repairable batch consumer", () => {
		const plan = planCaseSelectionTransition(
			structuralDoc({ childLoadsCase: false }),
			{
				sourceModuleUuid: MODULE_UUID,
				selection: { kind: "multiple", maximum: 8 },
			},
		);
		expect(plan).toEqual({
			kind: "blocked",
			blockers: [
				{
					kind: "structural-case-flow",
					reason: "batch-consumer-not-found",
					parentModuleUuid: MODULE_UUID,
					parentModuleName: "Households",
				},
			],
		});
	});

	it("keeps partial or stale confirmations mutation-free", () => {
		const partial = planCaseSelectionTransition(
			linkedDoc({ secondTarget: true }),
			{
				sourceModuleUuid: MODULE_UUID,
				selection: { kind: "multiple", maximum: 5 },
				confirmedModuleUuids: [TARGET_MODULE_UUID],
			},
		);
		expect(partial).toMatchObject({ kind: "needs-coordination" });

		const stale = planCaseSelectionTransition(linkedDoc(), {
			sourceModuleUuid: MODULE_UUID,
			selection: { kind: "multiple", maximum: 5 },
			confirmedModuleUuids: [OTHER_TARGET_MODULE_UUID],
		});
		expect(stale).toEqual({
			kind: "unavailable",
			reason: "not-coordinated-module",
			moduleUuid: OTHER_TARGET_MODULE_UUID,
		});
	});
});
