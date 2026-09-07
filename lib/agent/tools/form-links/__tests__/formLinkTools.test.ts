/** Real UUID-addressed commands, planners, gate and reducer with a controlled
 * writer receipt. No claim about SQL concurrency or device navigation. */
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	buildDoc,
	caseListConfig,
	f,
	xp,
	xpIn,
} from "@/lib/__tests__/docHelpers";
import { expectAdmittedDoc } from "@/lib/agent/__tests__/admittedFixture";
import { wireToolSchema } from "@/lib/agent/wireSchemas";
import type { BlueprintDoc, FormLink } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { makeToolWorkspaceHarness } from "../../../__tests__/fixtures";
import { getFormTool } from "../../getForm";
import { addFormLinksInputSchema, addFormLinksTool } from "../addFormLinks";
import { moveFormLinkInputSchema, moveFormLinkTool } from "../moveFormLink";
import {
	removeFormLinkInputSchema,
	removeFormLinkTool,
} from "../removeFormLink";
import { formLinkInputSchema } from "../shared";
import {
	updateFormLinkInputSchema,
	updateFormLinkTool,
} from "../updateFormLink";

const INTAKE = testUuid("mod-intake");
const CARE = testUuid("mod-care");
const SOURCE = testUuid("frm-source");
const VISIT = testUuid("frm-visit");
const NOTE = testUuid("frm-note");
const L1 = testUuid("lnk-1");
const L2 = testUuid("lnk-2");
const L3 = testUuid("lnk-3");
const ELSE = testUuid("lnk-else");

const toNote = { type: "form", moduleUuid: CARE, formUuid: NOTE } as const;
const toVisit = { type: "form", moduleUuid: CARE, formUuid: VISIT } as const;
const toCare = { type: "module", moduleUuid: CARE } as const;

interface Spec {
	uuid: string;
	condition?: string;
	target: FormLink["target"];
}

/**
 * Intake (patient) → [Source (registration)]; Care (patient) → [Visit
 * (followup), Note (survey)]. Links live on Source; `postSubmit` is stored
 * only when a test says so.
 */
function fixture(
	links: Spec[] = [],
	opts: { postSubmit?: "app_home" | "module" | "previous" } = {},
): BlueprintDoc {
	return expectAdmittedDoc(
		buildDoc({
			appName: "Links",
			caseTypes: [
				{
					name: "patient",
					properties: [{ name: "mood", label: proseText("Mood") }],
				},
			],
			modules: [
				{
					uuid: "mod-intake",
					name: "Intake",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							uuid: "frm-source",
							name: "Source",
							type: "registration",
							...((opts.postSubmit !== undefined ||
								(links.length > 0 &&
									links.every((link) => link.condition !== undefined))) && {
								postSubmit: opts.postSubmit ?? "app_home",
							}),
							...(links.length > 0 && { formLinks: links }),
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: proseText("Name"),
									caseWrite: { caseType: "patient", property: "case_name" },
								}),
							],
						},
					],
				},
				{
					uuid: "mod-care",
					name: "Care",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							uuid: "frm-visit",
							name: "Visit",
							type: "followup",
							fields: [
								f({
									kind: "text",
									id: "mood",
									label: proseText("Mood"),
									caseWrite: { caseType: "patient", property: "mood" },
								}),
							],
						},
						{
							uuid: "frm-note",
							name: "Note",
							type: "survey",
							fields: [f({ kind: "text", id: "n", label: proseText("N") })],
						},
					],
				},
			],
		}),
	);
}

const cond = (
	uuid: string,
	text: string,
	target: FormLink["target"] = toNote,
): Spec => ({ uuid, condition: text, target });
const otherwise = (
	uuid = "lnk-else",
	target: FormLink["target"] = toCare,
): Spec => ({
	uuid,
	target,
});

const address = { moduleUuid: INTAKE, formUuid: SOURCE };
const conditional = (text: string, target: FormLink["target"] = toNote) => ({
	condition: xp(text),
	target,
});

const order = (doc: BlueprintDoc) =>
	doc.forms[SOURCE]?.formLinks?.map((link) => link.uuid) ?? [];

const errorOf = (result: { result: unknown }): string =>
	z.object({ error: z.string() }).parse(result.result).error;
const messageOf = (result: { result: unknown }): string =>
	z.object({ message: z.string() }).parse(result.result).message;

describe("form-link author boundary", () => {
	it("admits the complete link shape and refuses what has no meaning", () => {
		expect(formLinkInputSchema.safeParse(conditional("1 = 1")).success).toBe(
			true,
		);
		expect(
			formLinkInputSchema.safeParse({ condition: null, target: toCare })
				.success,
		).toBe(true);
		expect(
			formLinkInputSchema.safeParse({
				target: toVisit,
				datums: [{ name: "case_id", xpath: xp("#patient/case_id") }],
			}).success,
		).toBe(true);
		// An empty datum list is not a state: it would be a second spelling of
		// "match automatically".
		expect(
			formLinkInputSchema.safeParse({ target: toVisit, datums: [] }).success,
		).toBe(false);
		// Each datum name once.
		expect(
			formLinkInputSchema.safeParse({
				target: toVisit,
				datums: [
					{ name: "case_id", xpath: xp("1") },
					{ name: "case_id", xpath: xp("2") },
				],
			}).success,
		).toBe(false);
		// Conditions are canonical ASTs, never text.
		expect(
			formLinkInputSchema.safeParse({ condition: "1 = 1", target: toNote })
				.success,
		).toBe(false);
		expect(
			formLinkInputSchema.safeParse({ target: toNote, extra: true }).success,
		).toBe(false);
	});

	it("admits UUID commands and rejects positional aliases in emitted and canonical schemas", async () => {
		const ajv = new Ajv({ strict: false });
		addFormats(ajv);
		const surfaces: ReadonlyArray<readonly [z.ZodType, object, object]> = [
			[
				addFormLinksInputSchema,
				{
					...address,
					links: [{ linkUuid: L1, link: conditional("1 = 1") }],
					afterLinkUuid: null,
				},
				{
					...address,
					links: [{ link: conditional("1 = 1") }],
					afterLinkUuid: 0,
				},
			],
			[
				updateFormLinkInputSchema,
				{ ...address, linkUuid: L1, link: { condition: null, target: toCare } },
				{ ...address, linkIndex: 0, link: { target: toCare } },
			],
			[
				removeFormLinkInputSchema,
				{ ...address, linkUuid: L1 },
				{ ...address, linkIndex: 0 },
			],
			[
				moveFormLinkInputSchema,
				{ ...address, linkUuid: L1, afterLinkUuid: L2 },
				{ ...address, linkUuid: L1, afterLinkUuid: 1 },
			],
		];
		for (const [schema, valid, invalid] of surfaces) {
			const wire = wireToolSchema(schema);
			const admits = ajv.compile(await wire.jsonSchema);
			expect(admits(valid), JSON.stringify(admits.errors)).toBe(true);
			expect((await wire.validate?.(valid))?.success).toBe(true);
			expect(admits(invalid)).toBe(false);
			expect((await wire.validate?.(invalid))?.success).toBe(false);
		}
	});
});

describe("addFormLinks", () => {
	it("adds a predeclared batch at the anchor and reports the committed order", async () => {
		const h = makeToolWorkspaceHarness(
			fixture([cond("lnk-1", "1 = 1")], { postSubmit: "module" }),
		);
		const result = await h.runTool(addFormLinksTool, {
			...address,
			links: [
				{ linkUuid: L2, link: conditional("2 = 2") },
				{ linkUuid: L3, link: conditional("3 = 3", toVisit) },
			],
			afterLinkUuid: null,
		});

		expect(result.result).toMatchObject({
			linkUuids: [L2, L3],
			linkOrder: [L2, L3, L1],
			summary: { location: "Source", count: 2 },
		});
		expect(result.result).not.toHaveProperty("pinnedPostSubmit");
		expect(h.recordMutations).toHaveBeenCalledTimes(1);
		expect(order(h.currentDoc())).toEqual([L2, L3, L1]);
		expect(h.currentDoc().forms[SOURCE]?.formLinks?.[1]).toMatchObject({
			uuid: L3,
			target: toVisit,
		});

		const read = await h.runTool(getFormTool, address);
		const links = "form" in read.data ? read.data.form.formLinks : undefined;
		expect(links?.map((link) => link.uuid)).toEqual([L2, L3, L1]);
	});

	it("refuses the entire batch when its second link fails after a valid conditional link", async () => {
		const doc = fixture();
		const h = makeToolWorkspaceHarness(doc);
		const refused = await h.runTool(addFormLinksTool, {
			...address,
			links: [
				{ linkUuid: L1, link: conditional("1 = 1") },
				{
					linkUuid: L2,
					link: {
						target: { type: "form", moduleUuid: INTAKE, formUuid: SOURCE },
					},
				},
			],
		});
		expect(errorOf(refused)).toContain("Link 2 of 2");
		expect(refused.mutations).toEqual([]);
		expect(h.recordMutations).not.toHaveBeenCalled();
		expect(h.currentDoc()).toEqual(doc);
		const accepted = await h.runTool(addFormLinksTool, {
			...address,
			links: [
				{ linkUuid: L1, link: conditional("1 = 1") },
				{ linkUuid: L2, link: { target: toCare } },
			],
		});
		expect(accepted.result).toMatchObject({ linkOrder: [L1, L2] });
		expect(h.recordMutations).toHaveBeenCalledTimes(1);
		expectAdmittedDoc(h.currentDoc());
	});

	it("pins the fallback when the first conditional link lands on a form with no post_submit, and says so", async () => {
		const h = makeToolWorkspaceHarness(fixture());
		const result = await h.runTool(addFormLinksTool, {
			...address,
			links: [{ linkUuid: L1, link: conditional("1 = 1") }],
		});

		expect(result.result).toMatchObject({
			linkUuids: [L1],
			pinnedPostSubmit: "app_home",
		});
		const message = messageOf(result);
		expect(message).toContain('post_submit explicitly to "app_home"');
		expect(message).toContain("update_form");
		expect(h.currentDoc().forms[SOURCE]?.postSubmit).toBe("app_home");
	});

	it("withdraws the pin when a later link of the same batch is the otherwise link", async () => {
		const h = makeToolWorkspaceHarness(fixture());
		const result = await h.runTool(addFormLinksTool, {
			...address,
			links: [
				{ linkUuid: L1, link: conditional("1 = 1") },
				{ linkUuid: ELSE, link: { target: toCare } },
			],
		});

		expect(result.result).toMatchObject({ linkOrder: [L1, ELSE] });
		expect(result.result).not.toHaveProperty("pinnedPostSubmit");
		expect(result.mutations.map((mutation) => mutation.kind)).toEqual([
			"addFormLink",
			"addFormLink",
		]);
		expect(h.currentDoc().forms[SOURCE]?.postSubmit).toBeUndefined();
	});

	it("places an unanchored conditional link above the otherwise link", async () => {
		const h = makeToolWorkspaceHarness(
			fixture([cond("lnk-1", "1 = 1"), otherwise()]),
		);
		await h.runTool(addFormLinksTool, {
			...address,
			links: [{ linkUuid: L2, link: conditional("2 = 2") }],
		});
		expect(order(h.currentDoc())).toEqual([L1, L2, ELSE]);
	});

	it("refuses a second otherwise link and names the one that exists", async () => {
		const h = makeToolWorkspaceHarness(
			fixture([cond("lnk-1", "1 = 1"), otherwise()]),
		);
		const result = await h.runTool(addFormLinksTool, {
			...address,
			links: [{ link: { target: toNote } }],
		});

		const error = errorOf(result);
		expect(error).toContain("Link 1 of 1 was not added");
		expect(error).toContain("already has an otherwise link");
		expect(error).toContain(`link 2 (${ELSE}, to module "Care")`);
		expect(error).toContain("update_form_link");
		expect(h.recordMutations).not.toHaveBeenCalled();
		expect(order(h.currentDoc())).toEqual([L1, ELSE]);
	});

	it("refuses a conditional link anchored after the otherwise link", async () => {
		const h = makeToolWorkspaceHarness(
			fixture([cond("lnk-1", "1 = 1"), otherwise()]),
		);
		const result = await h.runTool(addFormLinksTool, {
			...address,
			links: [{ link: conditional("2 = 2") }],
			afterLinkUuid: ELSE,
		});
		const error = errorOf(result);
		expect(error).toContain("cannot come after the otherwise link");
		expect(error).toContain(ELSE);
	});

	it("refuses a link back to its own form and an unknown anchor", async () => {
		const h = makeToolWorkspaceHarness(fixture());
		const self = await h.runTool(addFormLinksTool, {
			...address,
			links: [
				{
					link: conditional("1 = 1", {
						type: "form",
						moduleUuid: INTAKE,
						formUuid: SOURCE,
					}),
				},
			],
		});
		expect(errorOf(self)).toContain("cannot point back at the form it leaves");

		const anchored = await h.runTool(addFormLinksTool, {
			...address,
			links: [{ link: conditional("1 = 1") }],
			afterLinkUuid: L2,
		});
		expect(errorOf(anchored)).toContain(
			`afterLinkUuid "${L2}" is not a link on form "Source"`,
		);
		expect(h.recordMutations).not.toHaveBeenCalled();
	});

	it("lets the gate refuse a condition that reads a form answer", async () => {
		const doc = fixture();
		const h = makeToolWorkspaceHarness(doc);
		const result = await h.runTool(addFormLinksTool, {
			...address,
			links: [
				{
					link: {
						condition: xpIn(doc, SOURCE, "#form/case_name = 'x'"),
						target: toNote,
					},
				},
			],
		});
		expect(errorOf(result)).toContain("after the form has closed");
		expect(order(h.currentDoc())).toEqual([]);
		expect(h.currentDoc().forms[SOURCE]?.postSubmit).toBeUndefined();
	});

	it("lets the gate refuse datums that leave out what the target needs", async () => {
		const h = makeToolWorkspaceHarness(fixture());
		const result = await h.runTool(addFormLinksTool, {
			...address,
			links: [
				{
					link: {
						target: toVisit,
						datums: [{ name: "foo", xpath: xp("1") }],
					},
				},
			],
		});
		const error = errorOf(result);
		expect(error).toContain("foo");
		expect(order(h.currentDoc())).toEqual([]);
	});
});

describe("updateFormLink", () => {
	it("writes only the slots that changed", async () => {
		const h = makeToolWorkspaceHarness(
			fixture([cond("lnk-1", "1 = 1"), otherwise()]),
		);
		const retarget = await h.runTool(updateFormLinkTool, {
			...address,
			linkUuid: L1,
			link: conditional("1 = 1", toVisit),
		});
		expect(retarget.result).toMatchObject({
			linkUuid: L1,
			summary: { location: "Source" },
		});
		expect(retarget.mutations).toEqual([
			{
				kind: "updateFormLink",
				formUuid: SOURCE,
				uuid: L1,
				patch: { target: toVisit },
			},
		]);
		expect(h.currentDoc().forms[SOURCE]?.formLinks?.[0]?.target).toEqual(
			toVisit,
		);
	});

	it("drops carried values the new destination no longer reads", async () => {
		const h = makeToolWorkspaceHarness(fixture());
		const datums = [{ name: "case_id", xpath: xp("#patient/case_id") }];
		const added = await h.runTool(addFormLinksTool, {
			...address,
			links: [{ linkUuid: L1, link: { target: toVisit, datums } }],
		});
		expect(added.result).not.toHaveProperty("error");
		expect(h.currentDoc().forms[SOURCE].formLinks?.[0].datums).toEqual(datums);
		h.recordMutations.mockClear();
		const changed = await h.runTool(updateFormLinkTool, {
			...address,
			linkUuid: L1,
			link: { target: toNote, datums },
		});
		expect(changed.result).toMatchObject({ droppedDatums: ["case_id"] });
		expect(h.currentDoc().forms[SOURCE].formLinks).toEqual([
			{ uuid: L1, target: toNote },
		]);
		expect(h.recordMutations).toHaveBeenCalledTimes(1);
		expectAdmittedDoc(h.currentDoc());
	});

	it("refuses making a link unconditional while links follow it", async () => {
		const h = makeToolWorkspaceHarness(
			fixture([cond("lnk-1", "1 = 1"), cond("lnk-2", "2 = 2")], {
				postSubmit: "module",
			}),
		);
		const result = await h.runTool(updateFormLinkTool, {
			...address,
			linkUuid: L1,
			link: { target: toNote },
		});
		const error = errorOf(result);
		expect(error).toContain(`Link 1 (${L1}, to form "Note")`);
		expect(error).toContain("must be last");
		expect(error).toContain(`link 2 (${L2}, to form "Note")`);
		expect(h.recordMutations).not.toHaveBeenCalled();
	});

	it("pins the fallback when the otherwise link gains a condition", async () => {
		const h = makeToolWorkspaceHarness(
			fixture([cond("lnk-1", "1 = 1"), otherwise()]),
		);
		const result = await h.runTool(updateFormLinkTool, {
			...address,
			linkUuid: ELSE,
			link: conditional("2 = 2", toCare),
		});
		expect(result.result).toMatchObject({ pinnedPostSubmit: "app_home" });
		expect(h.currentDoc().forms[SOURCE]?.postSubmit).toBe("app_home");
	});

	it("names an unknown link and points at get_form", async () => {
		const h = makeToolWorkspaceHarness(fixture([cond("lnk-1", "1 = 1")]));
		const result = await h.runTool(updateFormLinkTool, {
			...address,
			linkUuid: L2,
			link: conditional("1 = 1"),
		});
		const error = errorOf(result);
		expect(error).toContain(`No link with UUID "${L2}"`);
		expect(error).toContain("get_form");
	});
});

describe("removeFormLink", () => {
	it("pins the fallback when the otherwise link goes and conditional links remain", async () => {
		const h = makeToolWorkspaceHarness(
			fixture([cond("lnk-1", "1 = 1"), otherwise()]),
		);
		const result = await h.runTool(removeFormLinkTool, {
			...address,
			linkUuid: ELSE,
		});
		expect(result.result).toMatchObject({
			pinnedPostSubmit: "app_home",
			summary: { location: "Source" },
		});
		expect(messageOf(result)).toContain(
			`Removed link 2 (${ELSE}, to module "Care")`,
		);
		expect(order(h.currentDoc())).toEqual([L1]);
		expect(h.currentDoc().forms[SOURCE]?.postSubmit).toBe("app_home");
	});

	it("removes the last link without touching post_submit", async () => {
		const h = makeToolWorkspaceHarness(
			fixture([cond("lnk-1", "1 = 1")], {
				postSubmit: "module",
			}),
		);
		const result = await h.runTool(removeFormLinkTool, {
			...address,
			linkUuid: L1,
		});
		expect(result.result).not.toHaveProperty("pinnedPostSubmit");
		expect(h.currentDoc().forms[SOURCE]?.formLinks).toBeUndefined();
		expect(h.currentDoc().forms[SOURCE]?.postSubmit).toBe("module");
	});
});

describe("moveFormLink", () => {
	const threeLinks = () =>
		fixture([cond("lnk-1", "1 = 1"), cond("lnk-2", "2 = 2"), otherwise()]);

	it("moves after a named link and to the front, reporting the committed order", async () => {
		const h = makeToolWorkspaceHarness(threeLinks());
		const after = await h.runTool(moveFormLinkTool, {
			...address,
			linkUuid: L1,
			afterLinkUuid: L2,
		});
		expect(after.result).toMatchObject({
			afterLinkUuid: L2,
			linkOrder: [L2, L1, ELSE],
		});
		expect(messageOf(after)).toContain(
			`Moved link 2 (${L1}, to form "Note") after link 1 (${L2}`,
		);
		expect(order(h.currentDoc())).toEqual([L2, L1, ELSE]);

		const front = await h.runTool(moveFormLinkTool, {
			...address,
			linkUuid: L1,
			afterLinkUuid: null,
		});
		expect(front.result).toMatchObject({
			afterLinkUuid: null,
			linkOrder: [L1, L2, ELSE],
		});
		expect(messageOf(front)).toContain("checked first");
	});

	it("refuses moving a conditional link after the otherwise link and names both", async () => {
		const h = makeToolWorkspaceHarness(threeLinks());
		const result = await h.runTool(moveFormLinkTool, {
			...address,
			linkUuid: L1,
			afterLinkUuid: ELSE,
		});
		const error = errorOf(result);
		expect(error).toContain(`Link 1 (${L1}, to form "Note")`);
		expect(error).toContain("was not moved");
		expect(error).toContain(`link 3 (${ELSE}, to module "Care")`);
		expect(h.recordMutations).not.toHaveBeenCalled();
		expect(order(h.currentDoc())).toEqual([L1, L2, ELSE]);
	});

	it("refuses moving the otherwise link above the links it must follow", async () => {
		const h = makeToolWorkspaceHarness(threeLinks());
		const result = await h.runTool(moveFormLinkTool, {
			...address,
			linkUuid: ELSE,
			afterLinkUuid: null,
		});
		const error = errorOf(result);
		expect(error).toContain("must be last");
		expect(error).toContain(`link 1 (${L1}`);
		expect(error).toContain(`link 2 (${L2}`);
	});

	it("treats a same-position move as already in place and refuses self and unknown anchors", async () => {
		const h = makeToolWorkspaceHarness(threeLinks());
		const same = await h.runTool(moveFormLinkTool, {
			...address,
			linkUuid: L2,
			afterLinkUuid: L1,
		});
		expect(same.mutations).toEqual([]);
		expect(messageOf(same)).toContain("already in that position");

		const self = await h.runTool(moveFormLinkTool, {
			...address,
			linkUuid: L1,
			afterLinkUuid: L1,
		});
		expect(errorOf(self)).toContain("cannot follow itself");

		const unknown = await h.runTool(moveFormLinkTool, {
			...address,
			linkUuid: L1,
			afterLinkUuid: L3,
		});
		expect(errorOf(unknown)).toContain(
			`afterLinkUuid "${L3}" is not a link on form "Source"`,
		);
		expect(h.recordMutations).not.toHaveBeenCalled();
	});
});
