/**
 * An advanced form in the shapes CommCare HQ's case configuration page stores
 * that Nova's emitter does not write.
 *
 * Contract: each shape below reads into the finding its manifest entry names,
 * once, at its place, or reads as the same state; the chain test's step 5
 * (`judgeLoads`) tells a tag Nova would not derive on a load that changes no
 * case from a chain that differs. The plausible failures: Nova re-tagging a
 * load, which renames a session value HQ's forms read; a hyphenated tag (HQ's
 * page writes one for every hyphenated case type) read as unrecognized
 * instead of its entry; an index name Nova cannot spell held; a saved-if-
 * changed write read as saved every time in a project space that applies it.
 */
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import type { BlueprintDoc, CaseOperation } from "@/lib/domain";
import { unowned } from "@/lib/domain/expression/builders";
import {
	advancedFixture,
	chosen,
	HOUSEHOLDS,
	MEMBERS,
	OP,
	read,
	U,
} from "../../../__tests__/advancedPlacementFixture";
import { planFormCaseWire } from "../../../casePlacementPlan";
import { namingFromHqPages } from "../../__tests__/hqPageNames";
import { readMenusOf as readMenusOfDoc } from "../../menus/__tests__/menuReading";
import {
	judgeLoads,
	type StoredLoad,
	settleAdvancedMenu,
} from "../advancedActions";
import {
	type AppJson,
	findingCodes,
	readCases as readCasesOf,
} from "./caseReading";

const F = "forms-and-case-writes";

const readCases = namingFromHqPages(readCasesOf);
const readMenusOf = namingFromHqPages(readMenusOfDoc);

/** The stored actions of the form under test, the first advanced form. */
function actionsOf(app: AppJson): Record<string, unknown> & {
	load_update_cases: Record<string, unknown>[];
	open_cases: Record<string, unknown>[];
} {
	for (const module of app.modules)
		for (const form of module.forms)
			if (
				form.doc_type === "AdvancedForm" &&
				form.name !== undefined &&
				JSON.stringify(form.name).includes("Under test")
			)
				return form.actions as never;
	throw new Error("The app holds the advanced form under test.");
}

const memberFollowup = (extra: CaseOperation[] = []) =>
	advancedFixture({
		formType: "followup",
		menu: "members",
		operations: () => [
			{
				uuid: OP("own"),
				id: "member",
				action: "own",
				writes: [{ property: "age", value: read("age") }],
			},
			...extra,
		],
	});

const registration = (extra: CaseOperation[] = []) =>
	advancedFixture({
		formType: "registration",
		operations: () => [
			{ uuid: OP("own"), id: "household", action: "own", name: read("name") },
			...extra,
		],
	});

const kid: CaseOperation = {
	uuid: OP("kid"),
	id: "member",
	action: "create",
	caseType: "member",
	target: { kind: "new" },
	name: read("kid_name"),
	forEach: { repeat: U("kids") },
	links: [
		{
			identifier: "parent",
			targetType: "household",
			target: { kind: "op", opUuid: OP("own") },
			relationship: "child",
		},
	],
};

describe("an advanced form's tags", () => {
	it("refuses a tag holding a hyphen under its entry, and reads the same tag spelled with an underscore", async () => {
		const { doc } = memberFollowup();
		const hyphen = await readCases(doc, {
			edit: (app) => {
				const loads = actionsOf(app).load_update_cases;
				(loads[loads.length - 1] as Record<string, unknown>).case_tag =
					"load_follow-up0";
			},
		});
		expect(findingCodes(hyphen)).toContain(`${F}/case-tag-holding-a-hyphen`);
		const underscore = await readCases(doc, {
			edit: (app) => {
				const loads = actionsOf(app).load_update_cases;
				(loads[loads.length - 1] as Record<string, unknown>).case_tag =
					"load_follow_up0";
			},
		});
		expect(
			findingCodes(underscore).filter((code) => code.startsWith(F)),
		).toEqual([]);
		const own = underscore.forms
			.filter((form) => form.docType === "AdvancedForm")
			.flatMap((form) => form.form.caseOperations ?? [])
			.find((operation) => operation.action === "own");
		expect(own?.placement).toEqual({
			kind: "advanced",
			tag: "load_follow_up0",
		});
	});

	it("tells a write-less load tagged after the menu's case type from a chain that differs", () => {
		const { doc, formUuid } = memberFollowup();
		const plan = planFormCaseWire(doc, formUuid);
		if (plan.kind !== "advanced")
			throw new Error("The members menu is held advanced.");
		const menuId = (uuid: string) =>
			uuid === HOUSEHOLDS ? "households" : uuid === MEMBERS ? "members" : uuid;
		const stored: StoredLoad[] = plan.loads.map((load, i) => ({
			tag: load.tag,
			caseType: load.caseType,
			detailsModule: menuId(load.listModule as string),
			...(load.index !== undefined && { index: load.index }),
			changes: i === plan.loads.length - 1,
		}));
		expect(judgeLoads(plan.loads, stored, undefined, menuId)).toEqual({
			kind: "same",
		});
		// HQ's page names a new load after the menu's case type, whatever the load's.
		const parent = { ...(stored[0] as StoredLoad), tag: "load_member0" };
		const child = {
			...(stored[1] as StoredLoad),
			index: { tag: "load_member0", identifier: "parent" },
		};
		expect(judgeLoads(plan.loads, [parent, child], undefined, menuId)).toEqual({
			kind: "tag",
			tag: "load_member0",
		});
		// The same tag on a load that writes its case is no tag Nova can leave alone.
		expect(
			judgeLoads(
				plan.loads,
				[{ ...parent, changes: true }, child],
				undefined,
				menuId,
			),
		).toEqual({
			kind: "chain",
			tag: "load_member0",
		});
		// A chain one load short is the chain finding.
		expect(
			judgeLoads(plan.loads, [stored[1] as StoredLoad], undefined, menuId).kind,
		).toBe("chain");
	});
});

describe("an advanced form's loads and open actions", () => {
	it("refuses an open action's index named outside an XML element name", async () => {
		const { doc } = registration([kid]);
		const reading = await readCases(doc, {
			edit: (app) => {
				const opens = actionsOf(app).open_cases;
				const indices = (
					opens[1] as { case_indices: Record<string, unknown>[] }
				).case_indices;
				(indices[0] as Record<string, unknown>).reference_id = "my-parent";
			},
		});
		expect(findingCodes(reading)).toContain(
			`${F}/index-identifier-outside-an-xml-element-name`,
		);
	});

	it("refuses an index whose relationship a question chooses under the entry its shape is, each once", async () => {
		const { doc } = registration([kid]);
		for (const [question, entry] of [
			["", `${F}/relationship-question-without-relationship-question`],
			[
				"/data/kids/kid_age",
				`${F}/caseindex-relationship-question-inside-a-repeat`,
			],
			[
				"/data/age",
				`${F}/caseindex-relationship-question-relationship-question-the-index-naming-an`,
			],
		] as const) {
			const reading = await readCases(doc, {
				edit: (app) => {
					const opens = actionsOf(app).open_cases;
					const index = (
						opens[1] as { case_indices: Record<string, unknown>[] }
					).case_indices[0] as Record<string, unknown>;
					index.relationship = "question";
					index.relationship_question = question;
				},
			});
			expect(
				findingCodes(reading).filter((code) => code === entry),
				question,
			).toHaveLength(1);
		}
	});

	it("reads an open action with no name, which HQ's build refuses, as unrecognized and never drops it", async () => {
		const { doc } = registration([kid]);
		const reading = await readCases(doc, {
			edit: (app) => {
				const opens = actionsOf(app).open_cases;
				(opens[1] as { name_update: Record<string, unknown> }).name_update = {
					question_path: "",
				};
			},
		});
		expect(
			reading.findings.filter(
				(one) =>
					one.code === "unrecognized" &&
					one.detail?.name === "schema:AdvancedOpenCaseAction.name_update",
			),
		).toHaveLength(1);
		expect(
			reading.forms
				.flatMap((form) => form.form.caseOperations ?? [])
				.filter((one) => one.action === "create"),
		).toEqual([]);
	});

	it("refuses a load's saved-if-changed write where the project space applies it, and reads it as saved every time where it does not", async () => {
		const { doc } = memberFollowup();
		const edit = (app: AppJson) => {
			const loads = actionsOf(app).load_update_cases;
			const properties = (
				loads[loads.length - 1] as {
					case_properties: Record<string, Record<string, unknown>>;
				}
			).case_properties;
			(properties.age as Record<string, unknown>).update_mode = "edit";
		};
		const applied = await readCases(doc, { edit, saveOnlyEditedApplied: true });
		expect(findingCodes(applied)).toContain(
			`${F}/update-mode-edit-off-a-follow-up-form-s-own-update`,
		);
		const unapplied = await readCases(doc, {
			edit,
			saveOnlyEditedApplied: false,
		});
		expect(
			findingCodes(unapplied).filter((code) => code.startsWith(F)),
		).toEqual([]);
	});

	it("reads an open action that names Nova's owner node of no owner as unowned", async () => {
		const { doc } = registration([
			{
				uuid: OP("pet"),
				id: "pet",
				action: "create",
				caseType: "pet",
				target: { kind: "new" },
				name: read("name"),
				owner: unowned(),
			},
		]);
		const reading = await readCases(doc);
		const pet = reading.forms
			.flatMap((form) => form.form.caseOperations ?? [])
			.find((operation) => operation.action === "create");
		expect(pet?.owner).toEqual(unowned());
	});

	it("refuses an auto-selected load in a mode Nova does not hold", async () => {
		const { doc } = memberFollowup([
			{
				uuid: OP("worker"),
				id: "commcare_user",
				action: "update",
				caseType: "commcare-user",
				target: { kind: "worker-record" },
				writes: [{ property: "last_household", value: read("name") }],
			},
		]);
		const reading = await readCases(doc, {
			edit: (app) => {
				const worker = actionsOf(app).load_update_cases.find(
					(load) => load.auto_select !== null,
				);
				if (worker === undefined)
					throw new Error("The form loads the worker's record.");
				worker.auto_select = {
					doc_type: "AutoSelectCase",
					mode: "user",
					value_source: "",
					value_key: "district",
				};
			},
		});
		expect(findingCodes(reading)).toContain(`${F}/auto-select-mode-user`);
	});

	it("raises one finding at an advanced menu Nova would write basic", async () => {
		// Two index names between members and households: no one chain index.
		const { doc } = memberFollowup([
			{
				uuid: OP("parent"),
				id: "household",
				action: "update",
				caseType: "household",
				target: { kind: "expression", expr: chosen(HOUSEHOLDS) },
				writes: [{ property: "remark", value: read("name") }],
			},
		]);
		const reading = await readCases(doc);
		const members = reading.ctx.draft.modules.find(
			(module) => module.module.name === doc.modules[MEMBERS]?.name,
		);
		if (members === undefined)
			throw new Error("The app holds the members menu.");
		const blocked = {
			...doc,
			forms: {
				...doc.forms,
				...Object.fromEntries(
					Object.entries(doc.forms).map(([uuid, form]) => [
						uuid,
						form.type === "registration" || form.type === "survey"
							? form
							: {
									...form,
									caseOperations: [
										...(form.caseOperations ?? []),
										...(["parent", "household"] as const).map(
											(identifier): CaseOperation => ({
												uuid: OP(`link-${uuid}-${identifier}`),
												id: `link_${identifier}`,
												action: "create",
												caseType: "member",
												target: { kind: "new" },
												name: read("name"),
												links: [
													{
														identifier,
														targetType: "household",
														target: { kind: "session" },
														relationship: "child",
													},
												],
											}),
										),
									],
								},
					]),
				),
			},
		};
		const before = reading.ctx.accounting.findings().length;
		settleAdvancedMenu(reading.ctx, blocked, { ...members, uuid: MEMBERS });
		const raised = reading.ctx.accounting.findings().slice(before);
		expect(raised.map((one) => one.code)).toEqual([
			"menus-and-case-lists/advanced-module-nova-would-write-as-a-basic-one",
		]);
	});

	for (const [why, change] of [
		[
			"whose forms read the search",
			{ caseSearchConfig: { formsReadSearch: true } },
		],
		[
			"whose case list menu item is narrowed (its cases are chosen after a parent's)",
			{ caseListMenuItem: {} },
		],
	] as const)
		it(`raises one finding at an advanced menu ${why}`, async () => {
			const { doc } = memberFollowup();
			const reading = await readCases(doc);
			const members = reading.ctx.draft.modules.find(
				(module) => module.module.name === doc.modules[MEMBERS]?.name,
			);
			if (members === undefined)
				throw new Error("The app holds the members menu.");
			const blocked = {
				...doc,
				modules: {
					...doc.modules,
					[MEMBERS]: { ...doc.modules[MEMBERS], ...change },
				},
			} as typeof doc;
			const before = reading.ctx.accounting.findings().length;
			settleAdvancedMenu(reading.ctx, blocked, { ...members, uuid: MEMBERS });
			const raised = reading.ctx.accounting.findings().slice(before);
			expect(raised.map((one) => [one.code, one.place.kind])).toEqual([
				[
					"menus-and-case-lists/advanced-module-nova-would-write-as-a-basic-one",
					"menu",
				],
			]);
		});

	it("reads an open action with a close back with the close sharing its place", async () => {
		const { doc } = registration([kid]);
		const reading = await readCases(doc, {
			edit: (app) => {
				const open = actionsOf(app).open_cases.find(
					(one) => one.case_type === "member",
				);
				if (open === undefined) throw new Error("The form opens a member.");
				open.close_condition = {
					type: "always",
					doc_type: "FormActionCondition",
				};
			},
		});
		const operations = reading.forms.flatMap(
			(form) => form.form.caseOperations ?? [],
		);
		const create = operations.find(
			(one) => one.action === "create" && one.caseType === "member",
		);
		const close = operations.find((one) => one.action === "close");
		expect(close?.target).toEqual({ kind: "op", opUuid: create?.uuid });
		expect(close?.placement).toBeUndefined();
		expect(findingCodes(reading).filter((code) => code.startsWith(F))).toEqual(
			[],
		);
	});

	it("raises the tag entry for a load that changes no case tagged after the menu's case type", async () => {
		const { doc } = memberFollowup();
		const reading = await readMenusOf(doc, (app) => {
			const loads = actionsOf(app as unknown as AppJson).load_update_cases;
			const [parent, own] = loads;
			if (parent === undefined || own === undefined)
				throw new Error("The form loads a parent and its own case.");
			const old = parent.case_tag as string;
			// HQ's page names a new load after the menu's case type, whatever the load's.
			parent.case_tag = "load_member0";
			const index = own.case_index as Record<string, unknown>;
			if (index.tag !== old)
				throw new Error("The own load names the parent's tag.");
			index.tag = "load_member0";
		});
		expect(menuCodes(reading)).toContain(
			`${F}/load-changing-no-case-with-a-tag-nova-does-not-derive`,
		);
		expect(menuCodes(reading)).not.toContain(
			`${F}/advanced-form-loads-other-than-its-menu-s-one-chain`,
		);
	});

	it("raises the chain entry where two forms of one menu load different chains", async () => {
		const { doc } = memberFollowup();
		const reading = await readMenusOf(doc, (app) => {
			const module = app.modules.find((one) =>
				one.forms.some((form) =>
					JSON.stringify(form.name).includes("Under test"),
				),
			);
			const form = module?.forms.find((one) =>
				JSON.stringify(one.name).includes("Under test"),
			);
			if (module === undefined || form === undefined)
				throw new Error("The app holds the form under test.");
			// A second form of the menu, as HQ's page copies one, whose own load chooses its case
			// with no parent first.
			const copy = JSON.parse(JSON.stringify(form)) as Record<string, unknown>;
			const attachments = app._attachments as Record<string, string>;
			const source = attachments[`${form.unique_id as string}.xml`] as string;
			copy.unique_id = "0123456789abcdef0123456789abcde0";
			copy.xmlns =
				"http://openrosa.org/formdesigner/0123456789ABCDEF0123456789ABCDE0";
			copy.name = { en: "Second" };
			attachments[`${copy.unique_id as string}.xml`] = source.replace(
				form.xmlns as string,
				copy.xmlns as string,
			);
			const loads = (
				copy.actions as { load_update_cases: Record<string, unknown>[] }
			).load_update_cases;
			const own = loads[loads.length - 1] as Record<string, unknown>;
			own.case_index = {
				doc_type: "CaseIndex",
				tag: "",
				reference_id: "parent",
				relationship: "child",
			};
			(
				copy.actions as { load_update_cases: Record<string, unknown>[] }
			).load_update_cases = [own];
			module.forms.push(copy);
		});
		expect(menuCodes(reading)).toContain(
			`${F}/advanced-form-loads-other-than-its-menu-s-one-chain`,
		);
	});
});

describe("a chain through a basic menu", () => {
	it("reads the chain of an advanced menu chosen under a basic menu with its own parent selection, where the selections are the only evidence of the parent types", async () => {
		// No form links a member to a household or a visit to a member: the two parent types are
		// the catalog's, and the menus' parent selections are all a reading has of them.
		const followup = (name: string, caseType: string) => ({
			name,
			type: "followup" as const,
			fields: [
				f({
					kind: "text",
					id: "note",
					caseWrite: { caseType, property: "note" },
				}),
			],
		});
		const doc = produce(
			buildDoc({
				caseTypes: [
					{ name: "household", properties: [] },
					{ name: "member", parent_type: "household", properties: [] },
					{ name: "visit", parent_type: "member", properties: [] },
				],
				modules: [
					{
						uuid: "chain-households",
						name: "Households",
						caseType: "household",
						forms: [
							{
								name: "Add household",
								type: "registration",
								fields: [
									f({
										kind: "text",
										id: "name",
										caseWrite: { caseType: "household", property: "case_name" },
									}),
								],
							},
						],
					},
					{
						uuid: "chain-members",
						name: "Members",
						caseType: "member",
						parentCaseModuleUuid: "chain-households",
						forms: [followup("Check member", "member")],
					},
					{
						uuid: "chain-visits",
						name: "Visits",
						caseType: "visit",
						parentCaseModuleUuid: "chain-members",
						forms: [followup("Review visit", "visit")],
					},
				],
			}),
			(draft) => {
				const visits = draft.modules[testUuid("chain-visits")];
				if (visits !== undefined) visits.heldKind = "advanced";
			},
		);
		const reading = await readMenusOf(doc);
		expect(menuCodes(reading)).toEqual([]);
		const read = reading.doc as BlueprintDoc;
		const named = (name: string) =>
			Object.values(read.modules).find((one) => one.name === name);
		expect(named("Visits")?.heldKind).toBe("advanced");
		expect(named("Visits")?.parentCaseModuleUuid).toBe(named("Members")?.uuid);
		expect(named("Members")?.parentCaseModuleUuid).toBe(
			named("Households")?.uuid,
		);
		const parentOf = (name: string) =>
			read.caseTypes?.find((type) => type.name === name)?.parent_type;
		expect([parentOf("member"), parentOf("visit")]).toEqual([
			"household",
			"member",
		]);
		// The loads the reading's chain gives are the ones the source stores, tag by tag.
		const visitsUuid = named("Visits")?.uuid as string;
		const form = read.formOrder[visitsUuid]?.[0];
		const planned = planFormCaseWire(read, form as never);
		const visitsForm = reading.app.modules[2]?.forms[0];
		if (visitsForm === undefined) throw new Error("The source holds the form.");
		const stored = (
			visitsForm.actions as {
				load_update_cases: { case_tag: string; case_type: string }[];
			}
		).load_update_cases;
		expect(
			planned.kind === "advanced" &&
				planned.actions.load_update_cases.map((load) => [
					load.case_tag,
					load.case_type,
				]),
		).toEqual(stored.map((load) => [load.case_tag, load.case_type]));
		expect(stored.map((load) => load.case_type)).toEqual([
			"household",
			"member",
			"visit",
		]);
	});
});

function menuCodes(reading: Awaited<ReturnType<typeof readMenusOf>>): string[] {
	return reading.findings.map((one) => one.code);
}
