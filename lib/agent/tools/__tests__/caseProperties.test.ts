import { describe, expect, it } from "vitest";
import {
	makeCanonicalGenesisDoc,
	makeToolWorkspaceHarness,
} from "@/lib/agent/__tests__/fixtures";
import { prepareAuthoringInput } from "@/lib/agent/authoring/input";
import { projectAuthoringRead } from "@/lib/agent/authoring/output";
import { authoringToolSchema } from "@/lib/agent/authoring/toolSchema";
import {
	SHARED_TOOL_REGISTRY,
	type SharedToolRegistryEntry,
} from "@/lib/agent/sharedToolRegistry";

function authoring() {
	const h = makeToolWorkspaceHarness(makeCanonicalGenesisDoc());
	async function call(name: string, input: unknown) {
		const entry: SharedToolRegistryEntry | undefined =
			SHARED_TOOL_REGISTRY.find((item) => item.saName === name);
		if (!entry) throw new Error(`Missing tool ${name}`);
		const authored = authoringToolSchema(
			name,
			entry.tool.inputSchema,
		).authored.parse(input);
		return h.workspace.invoke({
			toolName: name,
			async execute(ctx) {
				const canonical = await prepareAuthoringInput({
					toolName: name,
					schema: entry.tool.inputSchema,
					input: authored,
					ctx,
				});
				const result = await entry.tool.execute(canonical, ctx);
				return result.kind === "read"
					? projectAuthoringRead({
							toolName: name,
							data: result.data,
							doc: ctx.snapshot.doc,
						})
					: result.result;
			},
		});
	}
	return { ...h, call };
}

async function fixture() {
	const h = authoring();
	expect(
		await h.call("generateSchema", {
			caseTypes: ["plot", "garden"].map((name) => ({
				name,
				properties: [
					{
						name: "beds",
						label: "Beds",
						data_type: "int",
						hint: "Original hint",
						validation: ". >= 1",
						validation_msg: "Enter at least one bed.",
					},
				],
			})),
		}),
	).toMatchObject({ ok: true });
	expect(
		await h.call("createModule", {
			name: "Plots",
			case_type: "plot",
			case_list_columns: [
				{ kind: "plain", field: "case_name", header: "Plot" },
			],
			forms: [
				{
					name: "Register plot",
					type: "registration",
					fields: [
						{
							kind: "text",
							id: "plot_name",
							label: "Plot name",
							caseWrite: { caseType: "plot", property: "case_name" },
						},
						{
							kind: "int",
							id: "bed_count",
							label: "Beds in this plot",
							hint: "Question-specific help",
							validate: { expr: ". >= 1 and . <= 50", msg: "Enter 1 to 50." },
							caseWrite: { caseType: "plot", property: "beds" },
						},
					],
				},
			],
		}),
	).toMatchObject({ ok: true });
	return h;
}

describe("record property authoring", () => {
	it("reads and patches one exact definition while preserving other records and form content", async () => {
		const h = await fixture();
		const before = structuredClone(h.currentDoc());
		expect(
			await h.call("getCaseProperty", { caseType: "plot", property: "beds" }),
		).toMatchObject({
			caseType: "plot",
			property: {
				name: "beds",
				label: "Beds",
				data_type: "int",
				validation: ". >= 1",
				validation_msg: "Enter at least one bed.",
			},
		});
		expect(
			await h.call("updateCaseProperty", {
				caseType: "plot",
				property: "beds",
				updates: {
					label: "Number of beds",
					hint: null,
					validation: ". >= 1 and . <= 50",
					validation_msg: "Enter 1 to 50.",
				},
			}),
		).toMatchObject({ ok: true });
		expect(
			await h.call("getCaseProperty", { caseType: "plot", property: "beds" }),
		).toEqual({
			caseType: "plot",
			property: {
				name: "beds",
				label: "Number of beds",
				data_type: "int",
				validation: ". >= 1 and . <= 50",
				validation_msg: "Enter 1 to 50.",
			},
		});
		expect(
			h.currentDoc().caseTypes?.find((record) => record.name === "garden"),
		).toEqual(before.caseTypes?.find((record) => record.name === "garden"));
		expect(h.currentDoc().forms).toEqual(before.forms);
		expect(h.currentDoc().fields).toEqual(before.fields);
		expect(
			await h.call("updateCaseProperty", {
				caseType: "plot",
				property: "beds",
				updates: { required: "#case/beds > 0" },
			}),
		).toMatchObject({ ok: true });
		expect(
			h.currentDoc().caseTypes?.find((record) => record.name === "plot")
				?.properties[0].required?.parts,
		).toContainEqual({ kind: "case-ref", caseType: "plot", property: "beds" });
		expect(
			await h.call("updateCaseProperty", {
				caseType: "plot",
				property: "beds",
				updates: { validation: null, validation_msg: null },
			}),
		).toMatchObject({ ok: true });
		const read = await h.call("getCaseProperty", {
			caseType: "plot",
			property: "beds",
		});
		expect(read).not.toHaveProperty("property.validation");
		expect(read).not.toHaveProperty("property.validation_msg");
		const writes = h.recordMutations.mock.calls.length;
		expect(
			await h.call("updateCaseProperty", {
				caseType: "plot",
				property: "beds",
				updates: { validation: null, validation_msg: null },
			}),
		).toMatchObject({ ok: true });
		expect(h.recordMutations).toHaveBeenCalledTimes(writes);
	});

	it("refuses missing targets, inconsistent partial edits, and invalid expressions without changing the app", async () => {
		const h = await fixture();
		const before = structuredClone(h.currentDoc());
		for (const updates of [
			{ validation: null },
			{ options: [{ value: "one", label: "One" }] },
			{ validation: "between(., 1, 50)" },
		]) {
			expect(
				await h.call("updateCaseProperty", {
					caseType: "plot",
					property: "beds",
					updates,
				}),
			).toHaveProperty("error");
			expect(h.currentDoc()).toEqual(before);
		}
		for (const name of ["getCaseProperty", "updateCaseProperty"]) {
			expect(
				await h.call(name, {
					caseType: "plot",
					property: "absent",
					...(name === "updateCaseProperty"
						? { updates: { label: "Absent" } }
						: {}),
				}),
			).toHaveProperty("error");
		}
		expect(h.currentDoc()).toEqual(before);
		for (const updates of [
			{},
			{ name: "renamed" },
			{ data_type: "decimal" },
			{ label: null },
		])
			await expect(
				h.call("updateCaseProperty", {
					caseType: "plot",
					property: "beds",
					updates,
				}),
			).rejects.toThrow();
	});
});
