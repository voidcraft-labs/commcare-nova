import { expect, it } from "vitest";
import { z } from "zod";
import { caseChoiceDoc, choiceUuid } from "@/lib/__tests__/caseChoiceFixture";
import { makeAuthoringHarness } from "@/lib/agent/__tests__/authoringHarness";
import { echoLookupDefinitions } from "@/lib/agent/__tests__/fixtures";
import { wireTable } from "@/lib/commcare/lookup/__tests__/lookupWireCorpus";
import { parseLookupRevision } from "@/lib/lookup/schema";

it("prepares default labels and keeps candidate and selected records distinct through shared-tool reads and edits", async () => {
	const h = makeAuthoringHarness({}, caseChoiceDoc());
	const result = await h.call("addFields", {
		formUuid: choiceUuid("attendance"),
		fields: [
			{
				kind: "single_select",
				id: "nearby",
				parentUuid: "entry",
				label: "Nearby clinic",
				optionsSource: {
					kind: "cases",
					caseType: "clinic",
					filter: "#row/region = #case/region",
				},
			},
		],
	});
	expect(result).not.toHaveProperty("error");
	const field = Object.values(h.currentDoc().fields).find(
		(f) => f.id === "nearby",
	);
	expect(field).toMatchObject({
		optionsSource: {
			kind: "cases",
			caseType: "clinic",
			labelProperty: "case_name",
			filter: {
				kind: "eq",
				left: {
					kind: "term",
					term: { kind: "prop", caseType: "clinic", property: "region" },
				},
				right: {
					kind: "term",
					term: { kind: "form-case", caseType: "clinic", property: "region" },
				},
			},
		},
	});
	const read = z
		.object({
			field: z.object({
				optionsSource: z.object({
					kind: z.literal("cases"),
					caseType: z.string(),
					labelProperty: z.string(),
					filter: z.string(),
				}),
			}),
		})
		.parse(await h.call("getField", { fieldUuid: "nearby" }));
	expect(read.field.optionsSource.filter).toBe("(#row/region = #case/region)");
	expect(
		await h.call("setFieldOptionsSource", {
			fieldUuid: "nearby",
			source: read.field.optionsSource,
		}),
	).not.toHaveProperty("error");
	expect(
		Object.values(h.currentDoc().fields).find((f) => f.id === "nearby"),
	).toEqual(field);
});

it("binds a newly added earlier answer in the same call and refuses a selected-record read in a survey", async () => {
	const h = makeAuthoringHarness({}, caseChoiceDoc());
	expect(
		await h.call("addFields", {
			formUuid: choiceUuid("directory"),
			fields: [
				{ kind: "text", id: "region", label: "Region" },
				{
					kind: "single_select",
					id: "regional_clinic",
					label: "Regional clinic",
					optionsSource: {
						kind: "cases",
						caseType: "clinic",
						filter: "#row/region = #form/region",
					},
				},
			],
		}),
	).not.toHaveProperty("error");
	const before = structuredClone(h.currentDoc());
	await expect(
		h.call("setFieldOptionsSource", {
			fieldUuid: "regional_clinic",
			source: {
				kind: "cases",
				caseType: "clinic",
				filter: "#row/region = #case/region",
			},
		}),
	).rejects.toThrow("no selected record");
	expect(h.currentDoc()).toEqual(before);
});

it("round-trips nested table row scopes inside a case choice filter", async () => {
	const table = wireTable("regions", [{ name: "code", type: "text" }]);
	const h = makeAuthoringHarness(
		{
			lookupCatalog: async () => ({
				projectId: "project-test",
				projectRevision: parseLookupRevision("1"),
				definitions: [table],
			}),
			lookupDefinitions: echoLookupDefinitions([table]),
		},
		caseChoiceDoc(),
	);
	const filter = "#row/region = lookup('regions', 'code', #row/code = 'east')";
	expect(
		await h.call("setFieldOptionsSource", {
			fieldUuid: choiceUuid("clinic"),
			source: { kind: "cases", caseType: "clinic", filter },
		}),
	).not.toHaveProperty("error");
	const before = structuredClone(h.currentDoc());
	const read = z
		.object({ field: z.object({ optionsSource: z.unknown() }) })
		.parse(await h.call("getField", { fieldUuid: choiceUuid("clinic") }));
	expect(read.field.optionsSource).toMatchObject({
		filter: "(#row/region = lookup('regions', 'code', (#row/code = 'east')))",
	});
	expect(
		await h.call("setFieldOptionsSource", {
			fieldUuid: choiceUuid("clinic"),
			source: read.field.optionsSource,
		}),
	).not.toHaveProperty("error");
	expect(h.currentDoc()).toEqual(before);
});
