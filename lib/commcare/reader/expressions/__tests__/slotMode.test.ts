/**
 * The reader prints a slot as the production emitter does: the text
 * `expandDoc` writes into an HQ JSON slot is the reader's own print of the
 * stored tree in `slotReadMode`'s mode, so a slot printed under another
 * interpolation, or through another build context, differs here. The
 * literals hold the text HQ's build replaces, which the printer splits.
 * Over the emitter's own corpora, every interpolating slot's `HqXPath`, as
 * `expandDoc` builds it before printing the application, carries the
 * interpolation `slotReadMode` gives, and its text is the reader's print.
 */
import { describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	advancedFixture,
	UNDER_TEST,
} from "@/lib/commcare/__tests__/advancedPlacementFixture";
import { expandDoc } from "@/lib/commcare/expander";
import type { BlueprintDoc } from "@/lib/domain/blueprint";
import type { Expression, SlotContextRef } from "@/lib/domain/expression/types";
import { calculatedColumn, simpleSearchInputDef } from "@/lib/domain/modules";
import type { Uuid } from "@/lib/domain/uuid";
import {
	type HqApplicationTree,
	type HqXPath,
	hqXPathText as hqXPathTextOf,
} from "../../../hqJson/xpath";
import { derivedFormXmlns, derivedUniqueId } from "../../../wireIdentity";
import {
	hqCaseByIdXPath,
	hqInterpolationSlot,
	interpolateHqXPath,
} from "../../hqInterpolation";
import { printSlot, slotReadMode } from "../readExpression";
import { readEnv } from "./expressionReadFixture";
import { corpusDocs, READ_BACK_CORPORA } from "./readBackCorpus";

/** Each application tree `expandDoc` prints, as it built it. */
const built = vi.hoisted(() => ({ trees: [] as unknown[] }));
vi.mock("../../../hqJson/xpath", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../hqJson/xpath")>();
	return {
		...actual,
		serializeHqApplication: (tree: HqApplicationTree) => {
			built.trees.push(tree);
			return actual.serializeHqApplication(tree);
		},
	};
});

const lit = (value: string): Expression => ({
	kind: "term",
	term: { kind: "literal", value },
});

describe("the reader's print of a slot is the emitter's", () => {
	it("prints menu, form and case list conditions as expandDoc writes them", () => {
		const prop: Expression = {
			kind: "term",
			term: { kind: "prop", caseType: "patient", property: "p" },
		};
		const session: Expression = {
			kind: "term",
			term: { kind: "session-context", field: "username" },
		};
		const doc = buildDoc({
			caseTypes: [{ name: "patient", properties: [{ name: "p", label: "P" }] }],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					displayCondition: { kind: "neq", left: session, right: lit("#user") },
					caseListConfig: {
						columns: [],
						searchInputs: [],
						filter: { kind: "eq", left: prop, right: lit("#case/x") },
					},
					forms: [
						{
							name: "Visit",
							type: "followup",
							displayCondition: {
								kind: "eq",
								left: prop,
								right: lit("#session/x"),
							},
							fields: [f({ kind: "text", id: "q1", label: "Q1" })],
						},
						{
							name: "Survey",
							type: "survey",
							displayCondition: {
								kind: "neq",
								left: session,
								right: lit("#parent"),
							},
							fields: [f({ kind: "text", id: "name", label: "Name" })],
						},
					],
				},
			],
		});
		const app = expandDoc(doc);
		const moduleUuid = doc.moduleOrder[0] as (typeof doc.moduleOrder)[number];
		const mod = doc.modules[moduleUuid];
		const hq = app.modules[0];
		if (mod === undefined || hq === undefined) throw new Error("No menu.");
		const env = readEnv();
		const moduleRef: SlotContextRef = {
			entity: "module",
			uuid: moduleUuid,
			slot: "module_display_condition",
		};
		expect(slotReadMode(doc, moduleRef)).toEqual({
			target: "hq-json",
			interpolation: "no-case",
		});
		expect(
			printSlot(doc, moduleRef, mod.displayCondition as Expression, env),
		).toBe(hq.module_filter);
		const filterRef: SlotContextRef = {
			entity: "module",
			uuid: moduleUuid,
			slot: "case_list_filter",
		};
		expect(
			printSlot(doc, filterRef, mod.caseListConfig?.filter as Expression, env),
		).toBe(hq.case_details.short.filter);
		(doc.formOrder[moduleUuid] ?? []).forEach((formUuid, index) => {
			const form = doc.forms[formUuid];
			const ref: SlotContextRef = {
				entity: "form",
				uuid: formUuid,
				slot: "form_display_condition",
			};
			expect(
				printSlot(doc, ref, form?.displayCondition as Expression, env),
			).toBe(hq.forms[index]?.form_filter);
			expect(slotReadMode(doc, ref)).toEqual({
				target: "hq-json",
				interpolation: form?.type === "followup" ? "case" : "no-case",
			});
		});
	});
});

describe("the reader's print of a menu's search and list slots is the emitter's", () => {
	const REGION = testUuid("slot-mode-region");
	const DISTRICT = testUuid("slot-mode-district");
	const COLUMN = testUuid("slot-mode-column");
	const prop = (property: string): Expression => ({
		kind: "term",
		term: { kind: "prop", caseType: "patient", property },
	});
	const answer = (searchInputUuid: Uuid): Expression => ({
		kind: "term",
		term: { kind: "input", searchInputUuid },
	});
	const session: Expression = {
		kind: "term",
		term: { kind: "session-context", field: "username" },
	};
	it("prints each Search field's slots, the button's condition and a calculated column", () => {
		const doc = buildDoc({
			caseTypes: [{ name: "patient", properties: [{ name: "p", label: "P" }] }],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListConfig: {
						columns: [
							calculatedColumn(COLUMN, "Group", {
								kind: "concat",
								parts: [prop("p"), lit("#case/x")],
							}),
						],
						searchInputs: [
							simpleSearchInputDef(REGION, "region", "Region", "text", "p", {
								default: session,
								required: {
									when: { kind: "is-blank", left: answer(DISTRICT) },
								},
								validation: {
									rule: { kind: "neq", left: answer(REGION), right: lit("#x") },
									message: "Choose a region",
								},
							}),
							{
								kind: "hidden",
								uuid: DISTRICT,
								name: "district",
								label: "District",
								value: session,
							},
						],
					},
					caseSearchConfig: {
						searchButtonDisplayCondition: {
							kind: "neq",
							left: session,
							right: lit("#user"),
						},
					},
					forms: [
						{
							name: "Visit",
							type: "followup",
							fields: [f({ kind: "text", id: "q1", label: "Q1" })],
						},
					],
				},
			],
		});
		const tree = treeOf(doc);
		const moduleUuid = doc.moduleOrder[0] as Uuid;
		const mod = doc.modules[moduleUuid];
		const hq = tree.modules[0];
		if (mod === undefined || hq === undefined) throw new Error("No menu.");
		const env = readEnv();
		const at = (slot: string, member?: object): SlotContextRef =>
			({
				entity: "module",
				uuid: moduleUuid,
				slot,
				...(member === undefined ? {} : { member }),
			}) as SlotContextRef;
		const search = hq.search_config;
		const [region, district] = search.properties;
		const inputs = mod.caseListConfig?.searchInputs ?? [];
		const regionInput = inputs[0] as unknown as Record<string, unknown>;
		const districtInput = inputs[1] as unknown as Record<string, unknown>;
		const slots: readonly (readonly [
			SlotContextRef,
			HqXPath | undefined,
			Expression | undefined,
		])[] = [
			[
				at("search_input_default", { searchInputUuid: REGION }),
				region?.default_value,
				regionInput.default as Expression,
			],
			[
				at("search_input_required_when", { searchInputUuid: REGION }),
				region?.required?.test,
				(regionInput.required as { when: Expression }).when,
			],
			// The emitter conjoins the guard of the search's own values, which
			// the search reader takes off before it registers the test, so the
			// mode alone is compared.
			[
				at("search_input_validation_rule", { searchInputUuid: REGION }),
				region?.validations?.[0]?.test,
				undefined,
			],
			[
				at("search_input_hidden_value", { searchInputUuid: DISTRICT }),
				district?.default_value,
				districtInput.value as Expression,
			],
			[
				at("search_button_display_condition"),
				search.search_button_display_condition,
				(
					mod.caseSearchConfig as
						| { searchButtonDisplayCondition?: Expression }
						| undefined
				)?.searchButtonDisplayCondition,
			],
		];
		const modes = slots.map(([ref, value, stored]) => {
			if (value === undefined) throw new Error(`No ${ref.slot} was written.`);
			const mode = slotReadMode(doc, ref);
			if (mode.target !== "hq-json") throw new Error("No HQ JSON slot.");
			expect(value.interpolation, ref.slot).toBe(mode.interpolation);
			if (stored !== undefined)
				expect(printSlot(doc, ref, stored, env), ref.slot).toBe(
					hqXPathTextOf(value),
				);
			return [ref.slot, mode.interpolation];
		});
		expect(Object.fromEntries(modes)).toEqual({
			search_input_default: "none",
			search_input_required_when: "no-case",
			search_input_validation_rule: "no-dots",
			search_input_hidden_value: "none",
			search_button_display_condition: "none",
		});
		const column = at("case_list_column_expression", { columnUuid: COLUMN });
		const calculated = mod.caseListConfig?.columns[0];
		if (calculated?.kind !== "calculated")
			throw new Error("The menu has no calculated column.");
		const printed = printSlot(doc, column, calculated.expression, env);
		const fields = [
			...hq.case_details.short.columns,
			...hq.case_details.long.columns,
		].flatMap((one) => (one.useXpathExpression ? [one.field] : []));
		const written = fields.find((one) => hqXPathTextOf(one) === printed);
		const mode = slotReadMode(doc, column);
		expect(written?.interpolation).toBe(
			mode.target === "hq-json" ? mode.interpolation : undefined,
		);
		expect(written?.interpolation).toBe("none");
	});

	it("prints an advanced form's display condition over the case its last load chose", () => {
		// The form loads the household and then the member, each under a
		// datum named for its load, where HQ's build reads `#case`.
		const { doc, formUuid } = advancedFixture({
			formType: "followup",
			menu: "members",
			configure: (draft) => {
				const form = draft.forms[UNDER_TEST];
				if (form === undefined) return;
				draft.forms[UNDER_TEST] = {
					...form,
					displayCondition: {
						kind: "eq",
						left: {
							kind: "term",
							term: { kind: "prop", caseType: "member", property: "age" },
						},
						right: lit("5"),
					},
				};
			},
		});
		const tree = treeOf(doc);
		const hqForm = tree.modules
			.flatMap(
				(
					candidate,
				): readonly { xmlns: string | null; form_filter: HqXPath | null }[] =>
					candidate.forms,
			)
			.find((candidate) => candidate.xmlns === derivedFormXmlns(formUuid));
		const ref: SlotContextRef = {
			entity: "form",
			uuid: formUuid,
			slot: "form_display_condition",
		};
		const filter = hqForm?.form_filter;
		if (filter === undefined || filter === null)
			throw new Error("The form has no display condition.");
		expect(filter.interpolation).toBe("case");
		const text = printSlot(
			doc,
			ref,
			doc.forms[formUuid]?.displayCondition as Expression,
			readEnv(),
		);
		expect(text).toBe(hqXPathTextOf(filter));
		// HQ's build reads `#case` as the case the form's last load chose,
		// which the reading interpolates the same text over.
		const slot = hqInterpolationSlot(doc, ref, "case");
		if (slot === undefined) throw new Error("The form chooses no case.");
		const interpolated = interpolateHqXPath(text, slot);
		expect(interpolated.ok && interpolated.text).toContain(
			hqCaseByIdXPath(
				"instance('commcaresession')/session/data/case_id_load_member1",
			),
		);
	});
});

/** The tree `expandDoc` built for `doc`. */
function treeOf(doc: BlueprintDoc): HqApplicationTree {
	built.trees.length = 0;
	expandDoc(doc);
	const [tree] = built.trees;
	if (tree === undefined) throw new Error("expandDoc printed no application.");
	return tree as HqApplicationTree;
}

describe("the interpolation of every slot of the corpora is the emitter's", () => {
	// Slots held across the corpora; a corpus of field trees holds none.
	let checked = 0;
	for (const corpus of READ_BACK_CORPORA)
		it(`over the ${corpus.name} corpus`, { timeout: 60_000 }, () => {
			for (const doc of corpusDocs(corpus, 8)) {
				const tree = treeOf(doc);
				const env = readEnv();
				const hold = (
					ref: SlotContextRef,
					value: HqXPath | null | undefined,
					stored: Expression | undefined,
				) => {
					if (value === null || value === undefined) return;
					const mode = slotReadMode(doc, ref);
					expect(mode.target, ref.slot).toBe("hq-json");
					if (mode.target !== "hq-json") return;
					expect(value.interpolation, ref.slot).toBe(mode.interpolation);
					checked++;
					if (stored === undefined) return;
					expect(
						printSlot(doc, ref, stored, env),
						`${ref.slot} of ${ref.uuid}`,
					).toBe(
						// The emitter's own text, printed as the application is.
						hqXPathTextOf(value),
					);
				};
				for (const moduleUuid of doc.moduleOrder) {
					const mod = doc.modules[moduleUuid];
					const hq = tree.modules.find(
						(candidate) => candidate.unique_id === derivedUniqueId(moduleUuid),
					);
					if (mod === undefined || hq === undefined) continue;
					hold(
						{
							entity: "module",
							uuid: moduleUuid,
							slot: "module_display_condition",
						},
						hq.module_filter,
						mod.hiddenFromMenu === true ? undefined : mod.displayCondition,
					);
					hold(
						{ entity: "module", uuid: moduleUuid, slot: "case_list_filter" },
						hq.case_details.short.filter,
						undefined,
					);
					const search = hq.search_config;
					// Every Search field is a property, in the fields' order.
					(mod.caseListConfig?.searchInputs ?? []).forEach((input, index) => {
						const property = search.properties[index];
						if (property === undefined) return;
						const slots = input as unknown as Record<string, unknown>;
						const at = (slot: string): SlotContextRef =>
							({
								entity: "module",
								uuid: moduleUuid,
								slot,
								member: { searchInputUuid: input.uuid },
							}) as SlotContextRef;
						hold(
							at(
								input.kind === "hidden"
									? "search_input_hidden_value"
									: "search_input_default",
							),
							property.default_value,
							(input.kind === "hidden" ? slots.value : slots.default) as
								| Expression
								| undefined,
						);
						hold(
							at("search_input_required_when"),
							property.required?.test,
							(slots.required as { when?: Expression } | undefined)?.when,
						);
						// The emitter conjoins the guard of the search's own values,
						// which the search reader takes off before it registers the
						// test, so the mode alone is compared here.
						hold(
							at("search_input_validation_rule"),
							property.validations?.[0]?.test,
							undefined,
						);
					});
					const button = mod.caseSearchConfig as
						| { searchButtonDisplayCondition?: Expression }
						| undefined;
					hold(
						{
							entity: "module",
							uuid: moduleUuid,
							slot: "search_button_display_condition",
						},
						search.search_button_display_condition,
						button?.searchButtonDisplayCondition,
					);
					for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
						const form = doc.forms[formUuid as Uuid];
						const hqForm = tree.modules
							.flatMap(
								(
									candidate,
								): readonly {
									xmlns: string | null;
									form_filter: HqXPath | null;
								}[] => candidate.forms,
							)
							.find(
								(candidate) =>
									candidate.xmlns === derivedFormXmlns(formUuid as Uuid),
							);
						if (form === undefined || hqForm === undefined) continue;
						hold(
							{
								entity: "form",
								uuid: formUuid as Uuid,
								slot: "form_display_condition",
							},
							hqForm.form_filter,
							form.hiddenFromMenu === true ? undefined : form.displayCondition,
						);
					}
				}
			}
		});
	it("held slots of every interpolation the corpora print", () => {
		expect(checked).toBeGreaterThan(0);
	});
});
