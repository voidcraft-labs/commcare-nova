import { beforeEach, describe, expect, it, vi } from "vitest";
import { tileCell } from "@/lib/domain";
import { configureCaseSelectionTool } from "../configureCaseSelection";
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

describe("configureCaseSelection", () => {
	it("sets a bounded multiple-case workflow through one canonical mutation", async () => {
		const h = makeCaseListFixture(followupDoc());
		const result = await h.runTool(configureCaseSelectionTool, {
			moduleUuid: MOD_A,
			selection: { kind: "multiple", maximum: 20 },
		});

		if ("error" in result.result) throw new Error(result.result.error);
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
		expect(result.result.message).toContain(
			"select up to 20 cases before continuing",
		);
		expect(result.result.summary).toEqual({ location: "Patient" });
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

		if ("error" in result.result) throw new Error(result.result.error);
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

		if ("error" in result.result) throw new Error(result.result.error);
		expect(result.result.clearedPersistentTile).toBe(true);
		expect(h.currentDoc().modules[MOD_A].caseListConfig?.tile).toEqual({});
		expect(result.result.message).toContain(
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
		expect(result.result.error).toContain("has no case list");
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
