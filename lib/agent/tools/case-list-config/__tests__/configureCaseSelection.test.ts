import { beforeEach, describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { type BlueprintDoc, plainColumn, tileCell } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import {
	type ConfigureCaseSelectionResult,
	type ConfigureCaseSelectionSuccess,
	configureCaseSelectionTool,
} from "../configureCaseSelection";
import {
	BASE_COLUMN,
	FIELD_A,
	FORM_A,
	MOD_A,
	makeCaseListDoc,
	makeCaseListFixture,
	makeCaseListMcpFixture,
} from "./fixtures";

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

beforeEach(() => {
	vi.clearAllMocks();
});

function completedResult(
	result: ConfigureCaseSelectionResult,
): ConfigureCaseSelectionSuccess {
	if (result.outcome === "unavailable") throw new Error(result.error);
	if (result.outcome === "needs_changes") throw new Error(result.message);
	return result;
}

function followupDoc() {
	const doc = makeCaseListDoc();
	const registrationField = doc.fields[FIELD_A];
	if (registrationField.kind !== "text") throw new Error("fixture field");
	const { caseWrite: _registrationWrite, ...field } = registrationField;
	return {
		...doc,
		forms: {
			...doc.forms,
			[FORM_A]: {
				...doc.forms[FORM_A],
				name: "Review Patient",
				type: "followup" as const,
			},
		},
		fields: { ...doc.fields, [FIELD_A]: field },
	};
}

const TARGET_MODULE = testUuid("case-selection-tool-target-module");
const TARGET_FORM = testUuid("case-selection-tool-target-form");
const TARGET_FIELD = testUuid("case-selection-tool-target-field");
const TARGET_COLUMN = testUuid("case-selection-tool-target-column");
const FORM_LINK = testUuid("case-selection-tool-form-link");

function linkedFollowupDoc(args?: {
	readonly authoredDatums?: boolean;
}): BlueprintDoc {
	const doc = followupDoc();
	return {
		...doc,
		modules: {
			...doc.modules,
			[TARGET_MODULE]: {
				uuid: TARGET_MODULE,
				id: "patient_review",
				name: "Patient review",
				caseType: "patient",
				caseListConfig: {
					columns: [
						plainColumn(TARGET_COLUMN, "case_name", "Patient", {
							visibleInDetail: true,
							visibleInList: true,
						}),
					],
					listColumnOrder: [TARGET_COLUMN],
					detailColumnOrder: [TARGET_COLUMN],
					searchInputs: [],
				},
			},
		},
		forms: {
			...doc.forms,
			[FORM_A]: {
				...doc.forms[FORM_A],
				formLinks: [
					{
						uuid: FORM_LINK,
						target: {
							type: "form",
							moduleUuid: TARGET_MODULE,
							formUuid: TARGET_FORM,
						},
						...(args?.authoredDatums === true && {
							datums: [
								{
									name: "case_id",
									xpath: {
										parts: [{ kind: "text", text: "case-id" }],
									},
								},
							],
						}),
					},
				],
			},
			[TARGET_FORM]: {
				uuid: TARGET_FORM,
				id: "review_patient",
				name: "Review patient",
				type: "followup",
			},
		},
		fields: {
			...doc.fields,
			[TARGET_FIELD]: {
				uuid: TARGET_FIELD,
				id: "review_note",
				kind: "text",
				label: proseText("Review note"),
			},
		},
		moduleOrder: [...doc.moduleOrder, TARGET_MODULE],
		formOrder: { ...doc.formOrder, [TARGET_MODULE]: [TARGET_FORM] },
		fieldOrder: { ...doc.fieldOrder, [TARGET_FORM]: [TARGET_FIELD] },
		fieldParent: { ...doc.fieldParent, [TARGET_FIELD]: TARGET_FORM },
	};
}

describe("configureCaseSelection", () => {
	it("sets a bounded multiple-case workflow through one canonical mutation", async () => {
		const h = makeCaseListFixture(followupDoc());
		const result = await h.runTool(configureCaseSelectionTool, {
			moduleUuid: MOD_A,
			selection: { kind: "multiple", maximum: 20 },
		});

		const completed = completedResult(result.result);
		expect(completed.outcome).toBe("applied");
		expect(result.mutations).toEqual([
			{
				kind: "setCaseListMeta",
				uuid: MOD_A,
				patch: { selection: { kind: "multiple", maximum: 20 } },
			},
		]);
		expect(h.currentDoc().modules[MOD_A].caseListConfig?.selection).toEqual({
			kind: "multiple",
			maximum: 20,
		});
		expect(completed.message).toContain(
			"select up to 20 cases before continuing",
		);
		expect(completed.summary).toEqual({ location: "Patient" });
	});

	it("returns to one-case selection through an explicit null clear", async () => {
		const doc = followupDoc();
		const config = doc.modules[MOD_A].caseListConfig;
		if (config === undefined) throw new Error("fixture config missing");
		const h = makeCaseListFixture({
			...doc,
			modules: {
				...doc.modules,
				[MOD_A]: {
					...doc.modules[MOD_A],
					caseListConfig: {
						...config,
						selection: { kind: "multiple", maximum: 5 },
					},
				},
			},
		});

		const result = await h.runTool(configureCaseSelectionTool, {
			moduleUuid: MOD_A,
			selection: null,
		});

		const completed = completedResult(result.result);
		expect(completed.outcome).toBe("applied");
		expect(result.mutations[0]).toMatchObject({
			kind: "setCaseListMeta",
			patch: { selection: null },
		});
		expect(
			h.currentDoc().modules[MOD_A].caseListConfig?.selection,
		).toBeUndefined();
		expect(JSON.parse(JSON.stringify(result.mutations))).toEqual(
			result.mutations,
		);
	});

	it("removes only the incompatible persistent form tile setting", async () => {
		const doc = followupDoc();
		const config = doc.modules[MOD_A].caseListConfig;
		if (config === undefined) throw new Error("fixture config missing");
		const h = makeCaseListFixture({
			...doc,
			modules: {
				...doc.modules,
				[MOD_A]: {
					...doc.modules[MOD_A],
					caseListConfig: {
						...config,
						columns: config.columns.map((column) =>
							column.uuid === BASE_COLUMN
								? { ...column, tile: tileCell(0, 0, 12, 1) }
								: column,
						),
						tile: { persistOnForms: true },
					},
				},
			},
		});

		const result = await h.runTool(configureCaseSelectionTool, {
			moduleUuid: MOD_A,
			selection: { kind: "multiple", maximum: 10 },
		});

		const completed = completedResult(result.result);
		expect(completed.outcome).toBe("applied");
		expect(completed.clearedPersistentTile).toBe(true);
		expect(h.currentDoc().modules[MOD_A].caseListConfig?.tile).toEqual({});
		expect(completed.message).toContain(
			"Results layout and grouping are unchanged",
		);
	});

	it("refuses a module with no case list without mutating it", async () => {
		const doc = followupDoc();
		const h = makeCaseListFixture({
			...doc,
			modules: {
				...doc.modules,
				[MOD_A]: { ...doc.modules[MOD_A], caseListConfig: undefined },
			},
		});
		const before = h.currentDoc();

		const result = await h.runTool(configureCaseSelectionTool, {
			moduleUuid: MOD_A,
			selection: { kind: "multiple", maximum: 5 },
		});

		expect(result.mutations).toEqual([]);
		expect(h.currentDoc()).toEqual(before);
		if (!("error" in result.result)) throw new Error("expected error");
		expect(result.result.outcome).toBe("unavailable");
		expect(result.result.error).toContain("has no case list");
	});

	it("returns exact coordinated approvals without mutating, then applies one atomic retry", async () => {
		const h = makeCaseListFixture(linkedFollowupDoc());
		const before = h.currentDoc();
		const first = await h.runTool(configureCaseSelectionTool, {
			moduleUuid: MOD_A,
			selection: { kind: "multiple", maximum: 8 },
		});

		expect(first.mutations).toEqual([]);
		expect(h.currentDoc()).toEqual(before);
		expect(h.recordMutations).not.toHaveBeenCalled();
		if (
			first.result.outcome !== "needs_changes" ||
			first.result.needs !== "confirmation"
		) {
			throw new Error("expected confirmation");
		}
		expect(first.result).toMatchObject({
			outcome: "needs_changes",
			needs: "confirmation",
			selection: { kind: "multiple", maximum: 8 },
			requiredConfirmedModuleUuids: [TARGET_MODULE],
			coordinatedChanges: [
				{
					moduleUuid: TARGET_MODULE,
					moduleName: "Patient review",
					selection: { kind: "multiple", maximum: 8 },
					reasons: [{ kind: "form-link", linkUuid: FORM_LINK }],
				},
			],
			blockers: [],
		});
		expect(first.result.confirmationToken).toMatch(/^[a-f0-9]{64}$/);

		const retry = await h.runTool(configureCaseSelectionTool, {
			moduleUuid: MOD_A,
			selection: { kind: "multiple", maximum: 8 },
			confirmedModuleUuids: first.result.requiredConfirmedModuleUuids,
			confirmationToken: first.result.confirmationToken,
		});

		const completed = completedResult(retry.result);
		expect(completed.outcome).toBe("applied");
		expect(retry.mutations).toHaveLength(2);
		expect(completed.transitions).toMatchObject([
			{
				moduleUuid: MOD_A,
				moduleName: "Patient",
				selection: { kind: "multiple", maximum: 8 },
				clearedPersistentTile: false,
				reasons: [{ kind: "form-link", linkUuid: FORM_LINK }],
			},
			{
				moduleUuid: TARGET_MODULE,
				moduleName: "Patient review",
				selection: { kind: "multiple", maximum: 8 },
				clearedPersistentTile: false,
				reasons: [{ kind: "form-link", linkUuid: FORM_LINK }],
			},
		]);
		expect(
			h.currentDoc().modules[TARGET_MODULE]?.caseListConfig?.selection,
		).toEqual({ kind: "multiple", maximum: 8 });
		expect(h.recordMutations).toHaveBeenCalledTimes(1);
	});

	it("refuses a stale confirmation when its reviewed effects changed", async () => {
		const firstHarness = makeCaseListFixture(linkedFollowupDoc());
		const first = await firstHarness.runTool(configureCaseSelectionTool, {
			moduleUuid: MOD_A,
			selection: { kind: "multiple", maximum: 8 },
		});
		if (
			first.result.outcome !== "needs_changes" ||
			first.result.needs !== "confirmation"
		) {
			throw new Error("expected confirmation");
		}

		const peerDoc = linkedFollowupDoc();
		const sourceConfig = peerDoc.modules[MOD_A].caseListConfig;
		if (sourceConfig === undefined) throw new Error("fixture config missing");
		peerDoc.modules[MOD_A].caseListConfig = {
			...sourceConfig,
			columns: sourceConfig.columns.map((column) =>
				column.uuid === BASE_COLUMN
					? { ...column, tile: tileCell(0, 0, 12, 1) }
					: column,
			),
			tile: { persistOnForms: true },
		};
		const retryHarness = makeCaseListFixture(peerDoc);
		const retry = await retryHarness.runTool(configureCaseSelectionTool, {
			moduleUuid: MOD_A,
			selection: { kind: "multiple", maximum: 8 },
			confirmedModuleUuids: first.result.requiredConfirmedModuleUuids,
			confirmationToken: first.result.confirmationToken,
		});

		expect(retry.mutations).toEqual([]);
		expect(retryHarness.recordMutations).not.toHaveBeenCalled();
		if (
			retry.result.outcome !== "needs_changes" ||
			retry.result.needs !== "confirmation"
		) {
			throw new Error("expected refreshed confirmation");
		}
		expect(retry.result.confirmationToken).not.toBe(
			first.result.confirmationToken,
		);
		expect(retry.result.clearedPersistentTile).toBe(true);
	});

	it("returns UUID-located blockers without mutating", async () => {
		const h = makeCaseListFixture(linkedFollowupDoc({ authoredDatums: true }));
		const before = h.currentDoc();
		const result = await h.runTool(configureCaseSelectionTool, {
			moduleUuid: MOD_A,
			selection: { kind: "multiple", maximum: 8 },
		});

		expect(result.mutations).toEqual([]);
		expect(h.currentDoc()).toEqual(before);
		expect(h.recordMutations).not.toHaveBeenCalled();
		if (result.result.outcome !== "needs_changes") {
			throw new Error("expected blockers");
		}
		expect(result.result).toMatchObject({
			outcome: "needs_changes",
			needs: "repair",
			requiredConfirmedModuleUuids: [],
			confirmationToken: null,
			coordinatedChanges: [],
			blockers: [
				{
					kind: "form-link",
					reason: "authored-datums",
					sourceModuleUuid: MOD_A,
					sourceFormUuid: FORM_A,
					linkUuid: FORM_LINK,
					targetModuleUuid: TARGET_MODULE,
					targetFormUuid: TARGET_FORM,
				},
			],
		});
	});

	it("reports unchanged without committing", async () => {
		const doc = followupDoc();
		const config = doc.modules[MOD_A].caseListConfig;
		if (config === undefined) throw new Error("fixture config missing");
		const h = makeCaseListFixture({
			...doc,
			modules: {
				...doc.modules,
				[MOD_A]: {
					...doc.modules[MOD_A],
					caseListConfig: {
						...config,
						selection: { kind: "multiple", maximum: 5 },
					},
				},
			},
		});

		const result = await h.runTool(configureCaseSelectionTool, {
			moduleUuid: MOD_A,
			selection: { kind: "multiple", maximum: 5 },
		});

		expect(result.mutations).toEqual([]);
		const completed = completedResult(result.result);
		expect(completed.outcome).toBe("unchanged");
	});

	it("emits the same mutation batch through chat and MCP contexts", async () => {
		const doc = followupDoc();
		const chat = makeCaseListFixture(doc);
		const mcp = makeCaseListMcpFixture(doc);
		const input = {
			moduleUuid: MOD_A,
			selection: { kind: "multiple" as const, maximum: 12 },
		};

		const [chatResult, mcpResult] = await Promise.all([
			chat.runTool(configureCaseSelectionTool, input),
			mcp.runTool(configureCaseSelectionTool, input),
		]);

		expect(chatResult.mutations).toEqual(mcpResult.mutations);
		expect(chat.currentDoc()).toEqual(mcp.currentDoc());
	});
});
