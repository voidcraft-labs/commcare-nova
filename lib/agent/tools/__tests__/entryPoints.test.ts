import { describe, expect, it } from "vitest";
import { z } from "zod";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { proseText } from "@/lib/domain/prose";
import { expectAdmittedDoc } from "../../__tests__/admittedFixture";
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
		const h = makeToolWorkspaceHarness(expectAdmittedDoc(fixture()));
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
		const h = makeToolWorkspaceHarness(expectAdmittedDoc(fixture()));
		const initial = structuredClone(h.currentDoc());
		const invalid = await h.runTool(addEntryPointTool, {
			target: { kind: "module", moduleUuid },
			ignoreDisplayConditions: true,
		});
		expect(invalid.result).toHaveProperty("error");
		expect(h.recordMutations).not.toHaveBeenCalled();
		expect(h.currentDoc()).toEqual(initial);
		await h.runTool(addEntryPointTool, { target, entryPointUuid, id: "visit" });
		const beforeRefusals = structuredClone(h.currentDoc());
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
		expect(h.currentDoc()).toEqual(beforeRefusals);
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

	it("refuses at the schema an ID CommCare HQ won't save as written, offering one without claiming it is free", () => {
		const refusal = (id: string) => {
			const result = addEntryPointInputSchema.safeParse({ target, id });
			return result.success ? undefined : result.error.issues[0]?.message;
		};
		expect(refusal("intake_")).toBe(
			"A deep link ID starts and ends with a lowercase letter or a digit, because CommCare HQ won't save one that doesn't. You could call it \"intake\" instead.",
		);
		expect(refusal("home--visit")).toBe(
			"A deep link ID can't hold two hyphens in a row, because CommCare HQ won't save it. You could call it \"home-visit\" instead.",
		);
		expect(refusal("home-visit")).toBeUndefined();
		const update = updateEntryPointInputSchema.safeParse({
			entryPointUuid,
			patch: { id: "-visit" },
		});
		expect(update.success).toBe(false);
		expect(update.error?.issues[0]?.message).toContain(
			'You could call it "visit" instead.',
		);
	});

	it("keeps the pattern in the schema the provider is sent and adds no lookahead", () => {
		const schema = JSON.stringify(
			z.toJSONSchema(addEntryPointInputSchema, {
				target: "draft-7",
				io: "input",
			}),
		);
		expect(schema).toContain("^[a-z0-9_-]+$");
		expect(schema).not.toContain("(?!");
		expect(schema).toContain(
			"lowercase letters, digits, underscores and single hyphens, starting and ending with a letter or digit",
		);
	});
});
