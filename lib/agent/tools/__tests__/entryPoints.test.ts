import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { proseText } from "@/lib/domain/prose";
import { makeToolWorkspaceHarness } from "../../__tests__/fixtures";
import {
	addEntryPointInputSchema,
	addEntryPointTool,
	getEntryPointsTool,
	removeEntryPointTool,
	updateEntryPointInputSchema,
	updateEntryPointTool,
} from "../entry-points";

const moduleUuid = testUuid("entry-module");
const formUuid = testUuid("entry-form");
const entryPointUuid = testUuid("entry-point");
const target = { kind: "form", moduleUuid, formUuid } as const;
function fixture() {
	return buildDoc({
		appName: "Visits",
		caseTypes: [{ name: "patient", properties: [] }],
		modules: [
			{
				uuid: "entry-module",
				name: "Visits",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: "entry-form",
						name: "Visit",
						type: "followup",
						fields: [
							f({ kind: "text", id: "notes", label: proseText("Notes") }),
						],
					},
				],
			},
		],
	});
}

describe("shared entry-point authoring tools", () => {
	it("creates, reads, edits, clears, and removes one UUID-owned point through the workspace", async () => {
		const h = makeToolWorkspaceHarness(fixture());
		const added = await h.runTool(addEntryPointTool, {
			target,
			entryPointUuid,
			ignoreDisplayConditions: true,
		});
		expect(added.result).toHaveProperty("entryPointUuid", entryPointUuid);
		expect(h.currentDoc().forms[formUuid].entryPoint).toMatchObject({
			uuid: entryPointUuid,
			ignoreDisplayConditions: true,
		});
		const id = h.currentDoc().forms[formUuid].entryPoint?.id;
		expect(id).toMatch(/^[a-z0-9_-]+$/);
		const read = await h.runTool(getEntryPointsTool, {});
		expect(read.data).toMatchObject({
			entryPoints: [
				{
					uuid: entryPointUuid,
					id,
					target,
					available: true,
					requiredSelections: [
						{ moduleUuid, caseType: "patient", cardinality: "one", maximum: 1 },
					],
				},
			],
		});
		expect(JSON.stringify(read.data)).not.toContain("argumentId");
		await h.runTool(updateEntryPointTool, {
			entryPointUuid,
			patch: { id: "visit_by_link" },
		});
		expect(
			h.currentDoc().forms[formUuid].entryPoint?.ignoreDisplayConditions,
		).toBe(true);
		await h.runTool(updateEntryPointTool, {
			entryPointUuid,
			patch: { ignoreDisplayConditions: null },
		});
		expect(h.currentDoc().forms[formUuid].entryPoint).toEqual({
			uuid: entryPointUuid,
			id: "visit_by_link",
		});
		await h.runTool(removeEntryPointTool, { entryPointUuid });
		expect(h.currentDoc().forms[formUuid]).not.toHaveProperty("entryPoint");
	});

	it("refuses unsupported targets, collisions, and stale identities without persisting", async () => {
		const h = makeToolWorkspaceHarness(fixture());
		const invalid = await h.runTool(addEntryPointTool, {
			target: { kind: "module", moduleUuid },
			ignoreDisplayConditions: true,
		});
		expect(invalid.result).toHaveProperty("error");
		expect(h.recordMutations).not.toHaveBeenCalled();
		await h.runTool(addEntryPointTool, { target, entryPointUuid, id: "visit" });
		const collision = await h.runTool(addEntryPointTool, {
			target: { kind: "module", moduleUuid },
			id: "visit",
		});
		expect(collision.result).toHaveProperty("error");
		const stale = await h.runTool(updateEntryPointTool, {
			entryPointUuid: testUuid("gone-entry-point"),
			patch: { id: "renamed" },
		});
		expect(stale.result).toHaveProperty("error");
		expect(h.recordMutations).toHaveBeenCalledTimes(1);
	});

	it("rejects aliases, private runtime arguments and empty edit patches at the schema", () => {
		expect(
			addEntryPointInputSchema.safeParse({
				target: { kind: "form", module: "Visits", form: "Visit" },
			}).success,
		).toBe(false);
		expect(
			addEntryPointInputSchema.safeParse({
				target,
				functionDatums: ["case_id"],
			}).success,
		).toBe(false);
		expect(
			addEntryPointInputSchema.safeParse({ target, id: "not a link" }).success,
		).toBe(false);
		expect(
			updateEntryPointInputSchema.safeParse({ entryPointUuid, patch: {} })
				.success,
		).toBe(false);
	});
});
