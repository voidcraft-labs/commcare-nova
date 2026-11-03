/** Real UUID-addressed commands, planners, gate and reducer with a controlled
 * writer receipt. No claim about SQL concurrency or device navigation. */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { expectAdmittedDoc } from "@/lib/agent/__tests__/admittedFixture";
import { projectAuthoringRead } from "@/lib/agent/authoring/output";
import type { BlueprintDoc, FormLink, FormOtherwise } from "@/lib/domain";
import { eq, formField, literal, term } from "@/lib/domain/expression";
import { proseText } from "@/lib/domain/prose";
import { makeToolWorkspaceHarness } from "../../../__tests__/fixtures";
import { getFormTool } from "../../getForm";
import { updateFormTool } from "../../updateForm";
import { addFormLinksInputSchema, addFormLinksTool } from "../addFormLinks";
import { moveFormLinkInputSchema, moveFormLinkTool } from "../moveFormLink";
import {
	removeFormLinkInputSchema,
	removeFormLinkTool,
} from "../removeFormLink";
import {
	setFormOtherwiseInputSchema,
	setFormOtherwiseTool,
} from "../setFormOtherwise";
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
const ALWAYS = testUuid("lnk-always");
const OTHER = testUuid("lnk-other");

const toNote = { type: "form", moduleUuid: CARE, formUuid: NOTE } as const;
const toVisit = { type: "form", moduleUuid: CARE, formUuid: VISIT } as const;
const toCare = { type: "module", moduleUuid: CARE } as const;
const toSelf = { type: "form", moduleUuid: INTAKE, formUuid: SOURCE } as const;
const thisForm = { type: "this-form" } as const;

interface Spec {
	uuid: string;
	condition?: string;
	target: FormLink["target"];
}

/**
 * Intake (patient) → [Source (registration)]; Care (patient) → [Visit
 * (followup), Note (survey)]. Destinations live on Source; `postSubmit` and
 * `otherwise` are stored only when a test says so. `careUnderIntake` makes
 * Care a submenu of Intake, which HQ does not offer as a target from a root.
 */
function fixture(
	links: Spec[] = [],
	opts: {
		postSubmit?: "app_home" | "module" | "previous";
		otherwise?: FormOtherwise;
		careUnderIntake?: true;
	} = {},
): BlueprintDoc {
	const doc = buildDoc({
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
						...(opts.postSubmit !== undefined && {
							postSubmit: opts.postSubmit,
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
	});
	const source = doc.forms[SOURCE];
	const care = doc.modules[CARE];
	return expectAdmittedDoc({
		...doc,
		forms: {
			...doc.forms,
			[SOURCE]: {
				...source,
				...(opts.otherwise !== undefined && { otherwise: opts.otherwise }),
			},
		},
		modules: {
			...doc.modules,
			[CARE]: {
				...care,
				...(opts.careUnderIntake && { parentModuleUuid: INTAKE }),
			},
		},
	});
}

const cond = (
	uuid: string,
	text: string,
	target: FormLink["target"] = toNote,
): Spec => ({ uuid, condition: text, target });
const always = (
	uuid = "lnk-always",
	target: FormLink["target"] = toCare,
): Spec => ({ uuid, target });

const address = { moduleUuid: INTAKE, formUuid: SOURCE };
const conditional = (value: number, target: FormLink["target"] = toNote) => ({
	condition: eq(literal(value), literal(value)),
	target,
});
const moduleOtherwise: FormOtherwise = {
	kind: "destination",
	destination: "module",
};

const order = (doc: BlueprintDoc) =>
	doc.forms[SOURCE]?.formLinks?.map((link) => link.uuid) ?? [];

const errorOf = (result: { result: unknown }): string =>
	z.object({ error: z.string() }).parse(result.result).error;
const messageOf = (result: { result: unknown }): string | undefined =>
	z.object({ message: z.string().optional() }).parse(result.result).message;

describe("form-link author boundary", () => {
	it("admits the complete link shape and refuses what has no meaning", () => {
		expect(formLinkInputSchema.safeParse(conditional(1)).success).toBe(true);
		expect(
			formLinkInputSchema.safeParse({ condition: null, target: toCare })
				.success,
		).toBe(true);
		expect(formLinkInputSchema.safeParse({ target: thisForm }).success).toBe(
			true,
		);
		expect(
			formLinkInputSchema.safeParse({
				target: { type: "this-form", formUuid: SOURCE },
			}).success,
		).toBe(false);
		expect(
			formLinkInputSchema.safeParse({
				target: toVisit,
				datums: [
					{
						name: { kind: "selected-case" as const, module: CARE },
						xpath: term({
							kind: "form-case",
							caseType: "patient",
							property: "case_id",
						}),
					},
				],
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
					{
						name: { kind: "selected-case" as const, module: CARE },
						xpath: term(literal(1)),
					},
					{
						name: { kind: "selected-case" as const, module: CARE },
						xpath: term(literal(2)),
					},
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

	it("admits each otherwise arm and null, and refuses what has no meaning", () => {
		for (const otherwise of [
			{ kind: "destination", destination: "module" },
			{ kind: "link", target: toCare },
			{ kind: "link", target: thisForm, linkUuid: null },
			{ kind: "link", target: toNote, linkUuid: OTHER },
			null,
		])
			expect(
				setFormOtherwiseInputSchema.safeParse({ ...address, otherwise })
					.success,
			).toBe(true);
		for (const otherwise of [
			// The app home is an absent otherwise, never a value.
			{ kind: "destination", destination: "app_home" },
			{ kind: "link", target: toCare, condition: eq(literal(1), literal(1)) },
			{ kind: "link", target: toVisit, datums: [] },
			{ kind: "destination", destination: "module", target: toCare },
		])
			expect(
				setFormOtherwiseInputSchema.safeParse({ ...address, otherwise })
					.success,
			).toBe(false);
		// Omission is no instruction: the slot is required.
		expect(setFormOtherwiseInputSchema.safeParse(address).success).toBe(false);
	});

	it("admits UUID commands and rejects positional aliases in canonical schemas", () => {
		const surfaces: ReadonlyArray<readonly [z.ZodType, object, object]> = [
			[
				addFormLinksInputSchema,
				{
					...address,
					links: [{ linkUuid: L1, link: conditional(1) }],
					afterLinkUuid: null,
				},
				{
					...address,
					links: [{ link: conditional(1) }],
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
			expect(schema.safeParse(valid).success).toBe(true);
			expect(schema.safeParse(invalid).success).toBe(false);
		}
	});
});

describe("addFormLinks", () => {
	it("adds a predeclared batch at the anchor and reports the committed order", async () => {
		const h = makeToolWorkspaceHarness(
			fixture([cond("lnk-1", "1 = 1")], { otherwise: moduleOtherwise }),
		);
		const result = await h.runTool(addFormLinksTool, {
			...address,
			links: [
				{ linkUuid: L2, link: conditional(2) },
				{ linkUuid: L3, link: conditional(3, toVisit) },
			],
			afterLinkUuid: null,
		});

		expect(result.result).toMatchObject({
			linkUuids: [L2, L3],
			linkOrder: [L2, L3, L1],
			summary: { location: "Source", count: 2 },
		});
		// Adding to a form with destinations changes nothing else.
		expect(messageOf(result)).toBeUndefined();
		expect(h.recordMutations).toHaveBeenCalledTimes(1);
		expect(order(h.currentDoc())).toEqual([L2, L3, L1]);
		expect(h.currentDoc().forms[SOURCE]?.otherwise).toEqual(moduleOtherwise);
	});

	it("admits a destination that runs every time before one with a condition", async () => {
		const h = makeToolWorkspaceHarness(fixture());
		const result = await h.runTool(addFormLinksTool, {
			...address,
			links: [
				{ linkUuid: ALWAYS, link: { target: toCare } },
				{ linkUuid: L1, link: conditional(1) },
				{ linkUuid: L2, link: { target: thisForm } },
			],
		});
		expect(result.result).toMatchObject({ linkOrder: [ALWAYS, L1, L2] });
		expect(h.currentDoc().forms[SOURCE]?.formLinks?.[2]).toEqual({
			uuid: L2,
			target: thisForm,
		});
		expectAdmittedDoc(h.currentDoc());
	});

	it("refuses the entire batch when its second destination names this form, and points at this-form", async () => {
		const doc = fixture();
		const h = makeToolWorkspaceHarness(doc);
		const refused = await h.runTool(addFormLinksTool, {
			...address,
			links: [
				{ linkUuid: L1, link: conditional(1) },
				{ linkUuid: L2, link: { target: toSelf } },
			],
		});
		const error = errorOf(refused);
		expect(error).toContain("Destination 2 of 2");
		expect(error).toContain(
			'To open form "Source" again after it is submitted, use the target {"type":"this-form"} rather than naming the form.',
		);
		expect(refused.mutations).toEqual([]);
		expect(h.recordMutations).not.toHaveBeenCalled();
		expect(h.currentDoc()).toEqual(doc);
	});

	it("turns the form's after-submit into its otherwise when the first destination has a condition, and says so", async () => {
		const h = makeToolWorkspaceHarness(fixture([], { postSubmit: "module" }));
		const result = await h.runTool(addFormLinksTool, {
			...address,
			links: [{ linkUuid: L1, link: conditional(1) }],
		});
		expect(messageOf(result)).toBe(
			'Where the form went after submit, "module", is now its otherwise.',
		);
		const form = h.currentDoc().forms[SOURCE];
		expect(form?.postSubmit).toBeUndefined();
		expect(form?.otherwise).toEqual(moduleOtherwise);
	});

	it("removes a stored after-submit a destination that runs every time leaves unreachable, and says so", async () => {
		const h = makeToolWorkspaceHarness(fixture([], { postSubmit: "module" }));
		const result = await h.runTool(addFormLinksTool, {
			...address,
			links: [{ linkUuid: ALWAYS, link: { target: toCare } }],
		});
		expect(messageOf(result)).toBe(
			'Its after-submit setting, "module", was removed, because a destination now always runs.',
		);
		const form = h.currentDoc().forms[SOURCE];
		expect(form?.postSubmit).toBeUndefined();
		expect(form?.otherwise).toBeUndefined();
	});

	it("judges a batch as one shape: a later destination with a condition keeps the after-submit as the otherwise", async () => {
		const h = makeToolWorkspaceHarness(fixture([], { postSubmit: "module" }));
		const result = await h.runTool(addFormLinksTool, {
			...address,
			links: [
				{ linkUuid: ALWAYS, link: { target: toCare } },
				{ linkUuid: L1, link: conditional(1) },
			],
		});
		expect(messageOf(result)).toBe(
			'Where the form went after submit, "module", is now its otherwise.',
		);
		expect(h.recordMutations).toHaveBeenCalledTimes(1);
		const form = h.currentDoc().forms[SOURCE];
		expect(form?.postSubmit).toBeUndefined();
		expect(form?.otherwise).toEqual(moduleOtherwise);
		expectAdmittedDoc(h.currentDoc());
	});

	it("refuses carried values on a module and a submenu HQ doesn't offer from here", async () => {
		const values = await makeToolWorkspaceHarness(fixture()).runTool(
			addFormLinksTool,
			{
				...address,
				links: [
					{
						link: {
							target: toCare,
							datums: [
								{
									name: { kind: "selected-case", module: CARE },
									xpath: term(literal("patient-1")),
								},
							],
						},
					},
				],
			},
		);
		expect(errorOf(values)).toContain(
			"A destination that opens a module carries no values, because a module's form list asks for none.",
		);

		const submenu = await makeToolWorkspaceHarness(
			fixture([], { careUnderIntake: true }),
		).runTool(addFormLinksTool, {
			...address,
			links: [{ link: conditional(1, toCare) }],
		});
		expect(errorOf(submenu)).toContain(
			'CommCare HQ doesn\'t offer "Care" as a link target from form "Source": a submenu is a target only from a submenu whose parent has the same case type as its own parent. Target "Intake", which holds it, or a form inside "Care".',
		);
	});

	it("refuses an unknown anchor", async () => {
		const h = makeToolWorkspaceHarness(fixture());
		const anchored = await h.runTool(addFormLinksTool, {
			...address,
			links: [{ link: conditional(1) }],
			afterLinkUuid: L2,
		});
		expect(errorOf(anchored)).toContain(
			`afterLinkUuid "${L2}" is not a destination on form "Source"`,
		);
		expect(h.recordMutations).not.toHaveBeenCalled();
	});

	it("lets the gate refuse a condition that reads a form answer", async () => {
		const doc = fixture();
		const caseName = Object.values(doc.fields).find(
			(field) => field.id === "case_name",
		);
		if (caseName === undefined) throw new Error("Missing source form answer");
		const h = makeToolWorkspaceHarness(doc);
		const result = await h.runTool(addFormLinksTool, {
			...address,
			links: [
				{
					link: {
						condition: eq(formField(caseName.uuid), literal("x")),
						target: toNote,
					},
				},
			],
		});
		expect(errorOf(result)).toContain("after the form has closed");
		expect(order(h.currentDoc())).toEqual([]);
	});

	it("lets the gate refuse a selected record the target does not request", async () => {
		const h = makeToolWorkspaceHarness(fixture());
		const result = await h.runTool(addFormLinksTool, {
			...address,
			links: [
				{
					link: {
						target: toVisit,
						datums: [
							{
								name: { kind: "selected-case", module: INTAKE },
								xpath: term(literal("patient-1")),
							},
						],
					},
				},
			],
		});
		const error = errorOf(result);
		expect(error).toContain(
			"The destination no longer asks for this selected record.",
		);
		expect(order(h.currentDoc())).toEqual([]);
	});
});

describe("updateFormLink", () => {
	it("writes only the slots that changed", async () => {
		const h = makeToolWorkspaceHarness(
			fixture([cond("lnk-1", "1 = 1"), always()]),
		);
		const retarget = await h.runTool(updateFormLinkTool, {
			...address,
			linkUuid: L1,
			link: conditional(1, toVisit),
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
	});

	it("drops carried values the new destination no longer reads", async () => {
		const h = makeToolWorkspaceHarness(fixture());
		const datums = [
			{
				name: { kind: "selected-case" as const, module: CARE },
				xpath: term({
					kind: "form-case",
					caseType: "patient",
					property: "case_id",
				}),
			},
		];
		const added = await h.runTool(addFormLinksTool, {
			...address,
			links: [{ linkUuid: L1, link: { target: toVisit, datums } }],
		});
		expect(added.result).not.toHaveProperty("error");
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
		expectAdmittedDoc(h.currentDoc());
	});

	it("removes the otherwise when the last destination with a condition runs every time, and says so", async () => {
		const h = makeToolWorkspaceHarness(
			fixture([cond("lnk-1", "1 = 1")], { otherwise: moduleOtherwise }),
		);
		const result = await h.runTool(updateFormLinkTool, {
			...address,
			linkUuid: L1,
			link: { target: toNote },
		});
		expect(messageOf(result)).toBe(
			"Its otherwise was removed, because every destination now runs each time.",
		);
		expect(h.currentDoc().forms[SOURCE]?.otherwise).toBeUndefined();
		expectAdmittedDoc(h.currentDoc());
	});

	it("names an unknown destination and points at get_form", async () => {
		const h = makeToolWorkspaceHarness(fixture([cond("lnk-1", "1 = 1")]));
		const result = await h.runTool(updateFormLinkTool, {
			...address,
			linkUuid: L2,
			link: conditional(1),
		});
		const error = errorOf(result);
		expect(error).toContain(`No destination with UUID "${L2}"`);
		expect(error).toContain("get_form");
	});
});

describe("removeFormLink", () => {
	it("makes a built-in otherwise the form's after-submit when the last destination goes", async () => {
		const h = makeToolWorkspaceHarness(
			fixture([cond("lnk-1", "1 = 1")], { otherwise: moduleOtherwise }),
		);
		const result = await h.runTool(removeFormLinkTool, {
			...address,
			linkUuid: L1,
		});
		expect(messageOf(result)).toBe(
			'Its otherwise, "module", is now where it goes after submit.',
		);
		const form = h.currentDoc().forms[SOURCE];
		expect(form?.formLinks).toBeUndefined();
		expect(form?.otherwise).toBeUndefined();
		expect(form?.postSubmit).toBe("module");
	});

	it("makes an otherwise link the only destination when the last destination goes", async () => {
		const h = makeToolWorkspaceHarness(
			fixture([cond("lnk-1", "1 = 1")], {
				otherwise: { kind: "link", uuid: OTHER, target: toCare },
			}),
		);
		const result = await h.runTool(removeFormLinkTool, {
			...address,
			linkUuid: L1,
		});
		expect(messageOf(result)).toBe(
			"Its otherwise link is now its only destination.",
		);
		const form = h.currentDoc().forms[SOURCE];
		expect(form?.formLinks).toEqual([{ uuid: OTHER, target: toCare }]);
		expect(form?.otherwise).toBeUndefined();
		expectAdmittedDoc(h.currentDoc());
	});

	it("removes the otherwise with the last destination that has a condition", async () => {
		const h = makeToolWorkspaceHarness(
			fixture([cond("lnk-1", "1 = 1"), always()], {
				otherwise: moduleOtherwise,
			}),
		);
		const result = await h.runTool(removeFormLinkTool, {
			...address,
			linkUuid: L1,
		});
		expect(messageOf(result)).toBe(
			"Its otherwise was removed, because every destination now runs each time.",
		);
		expect(order(h.currentDoc())).toEqual([ALWAYS]);
		expect(h.currentDoc().forms[SOURCE]?.otherwise).toBeUndefined();
	});
});

describe("moveFormLink", () => {
	const threeLinks = () =>
		fixture([cond("lnk-1", "1 = 1"), cond("lnk-2", "2 = 2"), always()]);

	it("moves anywhere, a destination that runs every time first among them", async () => {
		const h = makeToolWorkspaceHarness(threeLinks());
		const after = await h.runTool(moveFormLinkTool, {
			...address,
			linkUuid: L1,
			afterLinkUuid: ALWAYS,
		});
		expect(after.result).toMatchObject({
			afterLinkUuid: ALWAYS,
			linkOrder: [L2, ALWAYS, L1],
		});
		const front = await h.runTool(moveFormLinkTool, {
			...address,
			linkUuid: ALWAYS,
			afterLinkUuid: null,
		});
		expect(front.result).toMatchObject({
			afterLinkUuid: null,
			linkOrder: [ALWAYS, L2, L1],
		});
		expectAdmittedDoc(h.currentDoc());
	});

	it("treats a same-position move as already in place and refuses self and unknown anchors", async () => {
		const h = makeToolWorkspaceHarness(threeLinks());
		const same = await h.runTool(moveFormLinkTool, {
			...address,
			linkUuid: L2,
			afterLinkUuid: L1,
		});
		expect(same.mutations).toEqual([]);

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
			`afterLinkUuid "${L3}" is not a destination on form "Source"`,
		);
		expect(h.recordMutations).not.toHaveBeenCalled();
	});
});

describe("setFormOtherwise", () => {
	const guarded = () => fixture([cond("lnk-1", "1 = 1")]);

	it("sets a built-in otherwise, replaces it with a link and clears it", async () => {
		const h = makeToolWorkspaceHarness(guarded());
		const builtIn = await h.runTool(setFormOtherwiseTool, {
			...address,
			otherwise: { kind: "destination", destination: "module" },
		});
		expect(builtIn.result).toMatchObject({
			ok: true,
			otherwise: { kind: "destination", destination: "module" },
		});
		expect(h.currentDoc().forms[SOURCE]?.otherwise).toEqual(moduleOtherwise);

		const link = await h.runTool(setFormOtherwiseTool, {
			...address,
			otherwise: { kind: "link", target: toCare, linkUuid: OTHER },
		});
		expect(link.result).toMatchObject({
			otherwise: { kind: "link", linkUuid: OTHER },
		});
		expect(h.currentDoc().forms[SOURCE]?.otherwise).toEqual({
			kind: "link",
			uuid: OTHER,
			target: toCare,
		});

		const cleared = await h.runTool(setFormOtherwiseTool, {
			...address,
			otherwise: null,
		});
		expect(cleared.result).not.toHaveProperty("otherwise");
		expect(h.currentDoc().forms[SOURCE]?.otherwise).toBeUndefined();
		expectAdmittedDoc(h.currentDoc());
	});

	it("mints the otherwise link's UUID when it is omitted or null", async () => {
		for (const linkUuid of [undefined, null]) {
			const h = makeToolWorkspaceHarness(guarded());
			const result = await h.runTool(setFormOtherwiseTool, {
				...address,
				otherwise: {
					kind: "link",
					target: thisForm,
					...(linkUuid === null && { linkUuid }),
				},
			});
			const stored = h.currentDoc().forms[SOURCE]?.otherwise;
			if (stored?.kind !== "link") throw new Error("No otherwise link");
			expect(stored.target).toEqual(thisForm);
			expect(z.uuid().safeParse(stored.uuid).success).toBe(true);
			expect(result.result).toMatchObject({
				otherwise: { kind: "link", linkUuid: stored.uuid },
			});
		}
	});

	it("refuses an otherwise beside destinations that all run every time", async () => {
		const h = makeToolWorkspaceHarness(fixture([always()]));
		const result = await h.runTool(setFormOtherwiseTool, {
			...address,
			otherwise: { kind: "destination", destination: "module" },
		});
		expect(errorOf(result)).toContain(
			'Form "Source" has no destination with a condition or a carried case, so an otherwise would never run. Give a destination a condition before setting an otherwise.',
		);
		expect(h.recordMutations).not.toHaveBeenCalled();
	});

	it("refuses a built-in the form's module doesn't offer, and lists what it does", async () => {
		const h = makeToolWorkspaceHarness(guarded());
		const result = await h.runTool(setFormOtherwiseTool, {
			...address,
			otherwise: { kind: "destination", destination: "parentMenu" },
		});
		const error = errorOf(result);
		expect(error).toContain(
			'Form "Source"\'s module doesn\'t offer "parentMenu" when no destination runs: "Intake" has no parent module. Choose one of: ',
		);
		expect(error).toContain(
			"or set the otherwise to null so the app home follows.",
		);
		expect(error).toContain('"module"');
		expect(error).not.toContain('"parentMenu",');
	});

	it("refuses a link the target rules refuse, in the planner's words", async () => {
		const cases: ReadonlyArray<readonly [object, string]> = [
			[
				{ kind: "link", target: toSelf },
				'use the target {"type":"this-form"} rather than naming the form.',
			],
			[
				{
					kind: "link",
					target: { type: "module", moduleUuid: testUuid("mod-gone") },
				},
				"The link's target is not in this app.",
			],
			[
				{
					kind: "link",
					target: toCare,
					datums: [
						{
							name: { kind: "selected-case", module: CARE },
							xpath: term(literal("patient-1")),
						},
					],
				},
				"A destination that opens a module carries no values",
			],
		];
		for (const [otherwise, sentence] of cases) {
			const h = makeToolWorkspaceHarness(guarded());
			const result = await h.runTool(setFormOtherwiseTool, {
				...address,
				otherwise,
			});
			expect(errorOf(result)).toContain(sentence);
			expect(h.recordMutations).not.toHaveBeenCalled();
		}
		const submenu = await makeToolWorkspaceHarness(
			fixture([cond("lnk-1", "1 = 1")], { careUnderIntake: true }),
		).runTool(setFormOtherwiseTool, {
			...address,
			otherwise: { kind: "link", target: toCare },
		});
		expect(errorOf(submenu)).toContain(
			'CommCare HQ doesn\'t offer "Care" as a link target from form "Source"',
		);
	});

	it("refuses a link UUID already in use", async () => {
		const h = makeToolWorkspaceHarness(guarded());
		const result = await h.runTool(setFormOtherwiseTool, {
			...address,
			otherwise: { kind: "link", target: toCare, linkUuid: L1 },
		});
		expect(errorOf(result)).toContain(
			`Link UUID "${L1}" is already in use in this app.`,
		);
	});
});

describe("the after-submit beside other form tools", () => {
	it("refuses post_submit on a form with destinations, in the gate's words", async () => {
		const h = makeToolWorkspaceHarness(fixture([cond("lnk-1", "1 = 1")]));
		const result = await h.runTool(updateFormTool, {
			...address,
			post_submit: "module",
		});
		expect(errorOf(result)).toBe(
			'"Source" has after-submit destinations and also sets post_submit, which only a form without destinations uses. Remove post_submit, and set where it goes when no destination runs with set_form_otherwise.',
		);
		expect(h.recordMutations).not.toHaveBeenCalled();
		expect(h.currentDoc().forms[SOURCE]?.postSubmit).toBeUndefined();
	});

	it("reads the destinations in the order they run, and the otherwise by linkUuid", async () => {
		const doc = fixture([always(), cond("lnk-1", "1 = 1", thisForm)], {
			otherwise: { kind: "link", uuid: OTHER, target: toNote },
		});
		const h = makeToolWorkspaceHarness(doc);
		const read = await h.runTool(getFormTool, address);
		const form = z
			.object({ form: z.record(z.string(), z.unknown()) })
			.parse(
				projectAuthoringRead({ toolName: "getForm", data: read.data, doc }),
			).form;
		expect(form).not.toHaveProperty("formLinks");
		expect(
			z
				.array(z.object({ uuid: z.string(), target: z.unknown() }))
				.parse(form.destinations)
				.map(({ uuid, target }) => ({ uuid, target })),
		).toEqual([
			{ uuid: ALWAYS, target: toCare },
			{ uuid: L1, target: thisForm },
		]);
		expect(form.otherwise).toEqual({
			kind: "link",
			linkUuid: OTHER,
			target: toNote,
		});
	});
});
