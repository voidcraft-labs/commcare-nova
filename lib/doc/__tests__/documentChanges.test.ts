/**
 * The grain of what changed between two documents: each menu and form that
 * changed and in which part, each question of a form once and by its id,
 * the app's parts, translations and media slots, and a count that is the
 * number of lines `documentChangeLines` gives. Over the diff fuzz corpora,
 * the count is zero exactly where the differences given are none, so no
 * difference is ever filed under no line.
 */
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { testMediaAssetId, testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	CASE_LIST_KEY_PARTS,
	type DocumentChanges,
	documentChanges,
	FORM_KEY_PARTS,
	MENU_KEY_PARTS,
	ROOT_KEY_PLACES,
} from "@/lib/doc/documentChanges";
import { documentDifferences } from "@/lib/doc/documentDifferences";
import {
	type BlueprintDoc,
	blueprintDocSchema,
	caseListConfigSchema,
	formSchema,
	imageMapColumn,
	moduleSchema,
	plainColumn,
	type TranslationEntry,
} from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { documentChangeLines } from "@/lib/publish/documentChangeCopy";
import { endpoint, endpointArb } from "./diffEndpoints";

const MOTHERS = testUuid("changes-mothers");
const CHILDREN = testUuid("changes-children");
const VISIT = testUuid("changes-visit");
const REGISTER = testUuid("changes-register");
const GROWTH = testUuid("changes-growth");
const EDD = testUuid("changes-edd");
const HOUSEHOLD = testUuid("changes-household");
const HEAD = testUuid("changes-head");
const SIZE = testUuid("changes-size");
const NOTES = testUuid("changes-notes");
const PHONE = testUuid("changes-phone");
const NAME_COLUMN = testUuid("changes-name-column");

function build(): BlueprintDoc {
	return buildDoc({
		appName: "Clinic",
		caseTypes: [{ name: "mother", properties: [] }],
		modules: [
			{
				uuid: MOTHERS,
				name: "Mothers",
				caseType: "mother",
				caseListConfig: {
					columns: [plainColumn(NAME_COLUMN, "case_name", "Name")],
					searchInputs: [],
				},
				forms: [
					{
						uuid: VISIT,
						name: "Visit",
						type: "followup",
						fields: [
							f({
								uuid: EDD,
								kind: "date",
								id: "edd",
								label: proseText("EDD"),
							}),
							f({
								uuid: HOUSEHOLD,
								kind: "group",
								id: "household",
								label: proseText("Household"),
								children: [
									f({
										uuid: HEAD,
										kind: "text",
										id: "head_name",
										label: proseText("Head"),
									}),
									f({
										uuid: SIZE,
										kind: "int",
										id: "size",
										label: proseText("Size"),
									}),
								],
							}),
							f({
								uuid: NOTES,
								kind: "text",
								id: "notes",
								label: proseText("Notes"),
								label_media: { image: testMediaAssetId("changes-notes-a") },
							}),
						],
					},
					{
						uuid: REGISTER,
						name: "Register",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "case_name",
								label: proseText("Name"),
								caseWrite: { caseType: "mother", property: "case_name" },
							}),
						],
					},
				],
			},
			{
				uuid: CHILDREN,
				name: "Children",
				forms: [
					{
						uuid: GROWTH,
						name: "Growth",
						type: "survey",
						fields: [
							f({ kind: "decimal", id: "weight", label: proseText("Weight") }),
						],
					},
				],
			},
		],
	});
}

/**
 * One build, so every copy holds the same minted identities (a question with
 * no fixed uuid, a form's own case operation).
 */
const BASE = build();

function base(): BlueprintDoc {
	return structuredClone(BASE);
}

/** `base()` with an edit made straight to the stored shape. */
function edited(edit: (doc: BlueprintDoc) => void): BlueprintDoc {
	const doc = base();
	edit(doc);
	return doc;
}

function relabel(doc: BlueprintDoc, field: string, label: string): void {
	const held = doc.fields[field as typeof EDD];
	if (!("label" in held)) throw new Error("the fixture's field has a label");
	held.label = proseText(label);
}

function linesOf(changes: DocumentChanges) {
	return {
		hq: documentChangeLines(changes, "hq"),
		nova: documentChangeLines(changes, "nova"),
	};
}

describe("documentChanges", () => {
	it("is empty for one document and for no differences given", () => {
		const doc = base();
		const none = documentChanges(doc, structuredClone(doc));
		expect(none.count).toBe(0);
		expect(linesOf(none)).toEqual({ hq: [], nova: [] });
		const other = edited((d) => {
			d.appName = "Clinic two";
		});
		expect(documentChanges(doc, other, []).count).toBe(0);
	});

	it("lists each changed question once, by its id with its groups' ids before it, in the form's order", () => {
		const after = edited((doc) => {
			relabel(doc, HEAD, "Head of household");
			relabel(doc, EDD, "Expected delivery");
			doc.fieldOrder[VISIT] = [NOTES, EDD, HOUSEHOLD];
		});
		const changes = documentChanges(base(), after);
		expect(changes.forms).toEqual([
			{
				uuid: VISIT,
				name: "Visit",
				menuName: "Mothers",
				state: "changed",
				parts: [],
				questions: {
					added: [],
					removed: [],
					changed: [
						{ uuid: EDD, name: "edd" },
						{ uuid: HEAD, name: "household/head_name" },
					],
					moved: [{ uuid: NOTES, name: "notes" }],
				},
			},
		]);
		expect(changes.menus).toEqual([]);
		expect(changes.count).toBe(1);
		expect(linesOf(changes)).toEqual({
			hq: [
				"The form “Visit” in the menu “Mothers”: 2 questions changed, 1 moved",
			],
			nova: [
				"The form “Visit” in the menu “Mothers”: questions changed: “edd” and “household/head_name”, moved: “notes”",
			],
		});
	});

	it("lists a question changed and moved once, as changed", () => {
		const after = edited((doc) => {
			relabel(doc, NOTES, "Visit notes");
			doc.fieldOrder[VISIT] = [NOTES, EDD, HOUSEHOLD];
		});
		const [form] = documentChanges(base(), after).forms;
		expect(form.questions).toEqual({
			added: [],
			removed: [],
			changed: [{ uuid: NOTES, name: "notes" }],
			moved: [],
		});
	});

	it("names an added question from the document after and a removed one from the document before", () => {
		const after = edited((doc) => {
			doc.fields[PHONE] = {
				uuid: PHONE,
				kind: "text",
				id: "phone",
				label: proseText("Phone"),
			};
			doc.fieldOrder[HOUSEHOLD] = [HEAD, PHONE];
			delete doc.fields[SIZE];
		});
		const changes = documentChanges(base(), after);
		expect(changes.forms.map((form) => form.questions)).toEqual([
			{
				added: [{ uuid: PHONE, name: "household/phone" }],
				removed: [{ uuid: SIZE, name: "household/size" }],
				changed: [],
				moved: [],
			},
		]);
		expect(linesOf(changes)).toEqual({
			hq: [
				"The form “Visit” in the menu “Mothers”: 1 question added, 1 removed",
			],
			nova: [
				"The form “Visit” in the menu “Mothers”: question added: “household/phone”, removed: “household/size”",
			],
		});
	});

	it("names a menu and a form from the document after, and a removed one from the document before", () => {
		const after = edited((doc) => {
			doc.modules[MOTHERS].name = "Mothers and babies";
			doc.forms[VISIT].name = "Home visit";
			for (const field of doc.fieldOrder[GROWTH]) delete doc.fields[field];
			delete doc.fieldOrder[GROWTH];
			delete doc.forms[GROWTH];
			doc.formOrder[CHILDREN] = [];
		});
		const changes = documentChanges(base(), after);
		expect(changes.menus).toEqual([
			{
				uuid: MOTHERS,
				name: "Mothers and babies",
				state: "changed",
				parts: ["name"],
				formsReordered: false,
			},
		]);
		expect(
			changes.forms.map(({ name, menuName, state, parts }) => ({
				name,
				menuName,
				state,
				parts,
			})),
		).toEqual([
			{
				name: "Home visit",
				menuName: "Mothers and babies",
				state: "changed",
				parts: ["name"],
			},
			{ name: "Growth", menuName: "Children", state: "removed", parts: [] },
		]);
		expect(linesOf(changes).hq).toEqual([
			"The menu “Mothers and babies”: its name changed",
			"The form “Home visit” in the menu “Mothers and babies”: its name",
			"The form “Growth” in the menu “Children” was removed",
		]);
	});

	it("files each key of a menu and a form under its part", () => {
		const after = edited((doc) => {
			doc.modules[MOTHERS].purpose = "Pregnant women in the catchment";
			const config = doc.modules[MOTHERS].caseListConfig;
			if (config === undefined) throw new Error("the fixture has a case list");
			config.columns = [plainColumn(NAME_COLUMN, "case_name", "Mother's name")];
			doc.forms[VISIT].postSubmit = "app_home";
			doc.forms[VISIT].purpose = "Monthly";
		});
		const changes = documentChanges(base(), after);
		expect(changes.menus.map((menu) => menu.parts)).toEqual([
			["case-list", "case-details", "note"],
		]);
		expect(changes.forms.map((form) => form.parts)).toEqual([
			["after-submit", "note"],
		]);
		expect(linesOf(changes).hq).toEqual([
			"The menu “Mothers”: its case list, its case details and its note changed",
			"The form “Visit” in the menu “Mothers”: where it goes after submit, its note",
		]);
	});

	it("says a menu's forms and the menus are in a new order, apart from what was added", () => {
		const after = edited((doc) => {
			doc.formOrder[MOTHERS] = [REGISTER, VISIT];
			doc.moduleOrder = [CHILDREN, MOTHERS];
		});
		const changes = documentChanges(base(), after);
		expect(changes.menusReordered).toBe(true);
		expect(changes.menus).toEqual([
			{
				uuid: MOTHERS,
				name: "Mothers",
				state: "changed",
				parts: [],
				formsReordered: true,
			},
		]);
		expect(linesOf(changes).hq).toEqual([
			"The menus are in a new order",
			"The menu “Mothers”: its forms are in a new order",
		]);
	});

	it("lists only what was added or removed, never the siblings it shifted", () => {
		const added = edited((doc) => {
			doc.fields[PHONE] = {
				uuid: PHONE,
				kind: "text",
				id: "phone",
				label: proseText("Phone"),
			};
			doc.fieldOrder[VISIT] = [PHONE, EDD, HOUSEHOLD, NOTES];
		});
		expect(linesOf(documentChanges(base(), added))).toEqual({
			hq: ["The form “Visit” in the menu “Mothers”: 1 question added"],
			nova: ["The form “Visit” in the menu “Mothers”: question added: “phone”"],
		});
		const removed = edited((doc) => {
			delete doc.fields[EDD];
			doc.fieldOrder[VISIT] = [HOUSEHOLD, NOTES];
		});
		expect(linesOf(documentChanges(base(), removed)).hq).toEqual([
			"The form “Visit” in the menu “Mothers”: 1 question removed",
		]);
		const formRemoved = edited((doc) => {
			for (const field of doc.fieldOrder[VISIT]) delete doc.fields[field];
			delete doc.fieldOrder[VISIT];
			delete doc.forms[VISIT];
			doc.formOrder[MOTHERS] = [REGISTER];
		});
		expect(linesOf(documentChanges(base(), formRemoved)).hq).toEqual([
			"The form “Visit” in the menu “Mothers” was removed",
		]);
		const menuRemoved = edited((doc) => {
			for (const form of doc.formOrder[MOTHERS]) {
				const visit = (parent: string): void => {
					for (const field of doc.fieldOrder[parent as typeof EDD] ?? []) {
						visit(field);
						delete doc.fields[field];
					}
					delete doc.fieldOrder[parent as typeof EDD];
				};
				visit(form);
				delete doc.forms[form];
			}
			delete doc.formOrder[MOTHERS];
			delete doc.modules[MOTHERS];
			doc.moduleOrder = [CHILDREN];
		});
		expect(linesOf(documentChanges(base(), menuRemoved)).hq).toEqual([
			"The menu “Mothers” was removed",
			"The form “Visit” in the menu “Mothers” was removed",
			"The form “Register” in the menu “Mothers” was removed",
		]);
	});

	it("names a question moved to another form on the form it joined, and nothing else", () => {
		const after = edited((doc) => {
			doc.fieldOrder[VISIT] = [HOUSEHOLD, NOTES];
			doc.fieldOrder[GROWTH] = [...doc.fieldOrder[GROWTH], EDD];
		});
		expect(linesOf(documentChanges(base(), after))).toEqual({
			hq: ["The form “Growth” in the menu “Children”: 1 question moved"],
			nova: ["The form “Growth” in the menu “Children”: question moved: “edd”"],
		});
	});

	it("says a form moved to another menu changed its menu, and no menu's forms are in a new order", () => {
		const after = edited((doc) => {
			doc.formOrder[MOTHERS] = [REGISTER];
			doc.formOrder[CHILDREN] = [VISIT, GROWTH];
		});
		const changes = documentChanges(base(), after);
		expect(changes.menus).toEqual([]);
		expect(linesOf(changes).hq).toEqual([
			"The form “Visit” in the menu “Children”: its menu",
		]);
	});

	it("compares a long list's order once, however many of its positions shifted", () => {
		const wide = (withNew: boolean): BlueprintDoc =>
			edited((doc) => {
				const ids = Array.from({ length: 2_000 }, (_, i) =>
					testUuid(`changes-wide-${i}`),
				);
				for (const [i, uuid] of ids.entries())
					doc.fields[uuid] = {
						uuid,
						kind: "text",
						id: `q${i}`,
						label: proseText(`Q${i}`),
					};
				if (withNew)
					doc.fields[PHONE] = {
						uuid: PHONE,
						kind: "text",
						id: "phone",
						label: proseText("Phone"),
					};
				doc.fieldOrder[GROWTH] = withNew ? [PHONE, ...ids] : ids;
			});
		const before = wide(false);
		const after = wide(true);
		const started = performance.now();
		const changes = documentChanges(before, after);
		const took = performance.now() - started;
		expect(linesOf(changes).hq).toEqual([
			"The form “Growth” in the menu “Children”: 1 question added",
		]);
		// One comparison of the list is a few milliseconds; one per shifted
		// position, as a table each, is minutes.
		expect(took).toBeLessThan(2_000);
	});

	it("counts a media slot in mediaFiles and files it under the place that shows it", () => {
		const after = edited((doc) => {
			const notes = doc.fields[NOTES];
			if (notes.kind !== "text") throw new Error("notes is a text question");
			notes.label_media = { image: testMediaAssetId("changes-notes-b") };
			doc.logo = testMediaAssetId("changes-logo");
		});
		const changes = documentChanges(base(), after);
		expect(changes.mediaFiles).toBe(2);
		expect(changes.app).toEqual(["logo"]);
		expect(changes.forms.map((form) => form.questions.changed)).toEqual([
			[{ uuid: NOTES, name: "notes" }],
		]);
		expect(linesOf(changes).hq).toEqual([
			"The app's logo",
			"The form “Visit” in the menu “Mothers”: 1 question changed",
			"2 pictures or sounds changed",
		]);
	});

	it("counts a picture its choice or image map row only moved as no change, and one added, replaced or removed as one", () => {
		const SELECT = testUuid("changes-pictured");
		const MAP = testUuid("changes-picture-column");
		const choice = (value: string, picture?: string) => ({
			uuid: testUuid(`changes-choice-${value}`),
			value,
			label: proseText(value),
			...(picture === undefined
				? {}
				: { media: { image: testMediaAssetId(picture) } }),
		});
		const row = (value: string, picture: string) => ({
			value,
			assetId: testMediaAssetId(picture),
		});
		const pictured = (
			choices: ReturnType<typeof choice>[],
			rows: ReturnType<typeof row>[],
		) =>
			edited((doc) => {
				doc.fields[SELECT] = {
					uuid: SELECT,
					kind: "single_select",
					id: "pictured",
					label: proseText("Pictured"),
					optionsSource: { kind: "inline", options: choices },
				};
				doc.fieldOrder[VISIT] = [...(doc.fieldOrder[VISIT] ?? []), SELECT];
				const config = doc.modules[MOTHERS].caseListConfig;
				if (config === undefined) throw new Error("Mothers has a case list");
				config.columns.push(imageMapColumn(MAP, "case_name", "Picture", rows));
				config.listColumnOrder.push(MAP);
				config.detailColumnOrder.push(MAP);
			});
		const before = pictured(
			[choice("one", "picture-one"), choice("two", "picture-two")],
			[row("a", "picture-a"), row("b", "picture-b")],
		);
		const mediaFilesTo = (
			choices: ReturnType<typeof choice>[],
			rows: ReturnType<typeof row>[],
		) => documentChanges(before, pictured(choices, rows)).mediaFiles;
		// A choice and a row added above, the rows' values reworded, and the
		// choices in the other order: every picture is where it was.
		expect(
			mediaFilesTo(
				[
					choice("two", "picture-two"),
					choice("zero"),
					choice("one", "picture-one"),
				],
				[row("z", "picture-a"), row("y", "picture-b")],
			),
		).toBe(0);
		const shifted = documentChanges(
			before,
			pictured(
				[
					choice("zero"),
					choice("one", "picture-one"),
					choice("two", "picture-two"),
				],
				[row("a", "picture-a"), row("b", "picture-b")],
			),
		);
		expect(linesOf(shifted).hq).toEqual([
			"The form “Visit” in the menu “Mothers”: 1 question changed",
		]);
		// A row added with its own picture, one choice's picture replaced and
		// another's removed: three.
		expect(
			mediaFilesTo(
				[choice("one", "picture-new"), choice("two")],
				[row("c", "picture-c"), row("a", "picture-a"), row("b", "picture-b")],
			),
		).toBe(3);
	});

	it("counts a translation's text and its review apart, once each", () => {
		const entry = (value: string): TranslationEntry => ({
			value,
			sourceFingerprint: "source-v1:one",
			origin: "ai",
			review: "needs-review",
			translatedFrom: "eng",
		});
		const localized = (
			first: TranslationEntry,
			second: TranslationEntry,
		): BlueprintDoc =>
			edited((doc) => {
				doc.localization = {
					sourceLanguage: "eng",
					defaultLanguage: "eng",
					languageOrder: ["eng", "fra"],
					translations: { fra: { "tu1:one": first, "tu1:two": second } },
					wireCodes: { eng: "en", fra: "fr" },
				};
			});
		const before = localized(entry("Visite"), entry("Notes"));
		const after = localized(entry("Visite à domicile"), {
			...entry("Notes"),
			review: "reviewed",
			origin: "human",
		});
		const changes = documentChanges(before, after);
		expect(changes.translations).toEqual({ text: 1, review: 1 });
		expect(linesOf(changes)).toEqual({
			hq: [
				"1 translation changed",
				"1 translation to review, because its source text changed in CommCare HQ",
			],
			nova: ["1 translation changed", "The review mark on 1 translation"],
		});
		const added = documentChanges(base(), after);
		expect(added.app).toEqual(["languages"]);
		expect(added.translations).toEqual({ text: 2, review: 0 });
	});

	it("files each key of the app under its part", () => {
		const after = edited((doc) => {
			doc.appName = "Clinic two";
			doc.appSettings = { ...doc.appSettings, showSavedForms: true };
			doc.caseTypes = [];
		});
		expect(documentChanges(base(), after).app).toEqual([
			"name",
			"settings",
			"case-types",
		]);
	});
});

describe("every schema key is placed", () => {
	const keys = (record: object) => Object.keys(record).sort();

	it("places each key of a menu, its case list, a form and the document", () => {
		expect(keys(MENU_KEY_PARTS)).toEqual(keys(moduleSchema.shape));
		expect(keys(CASE_LIST_KEY_PARTS)).toEqual(keys(caseListConfigSchema.shape));
		expect(keys(FORM_KEY_PARTS)).toEqual(keys(formSchema.shape));
		expect(keys(ROOT_KEY_PLACES)).toEqual(keys(blueprintDocSchema.shape));
	});

	it("leaves an entity's own uuid alone unplaced", () => {
		const unplaced = (table: Record<string, unknown>) =>
			Object.entries(table)
				.filter(([, part]) => part === null)
				.map(([key]) => key);
		expect(unplaced(MENU_KEY_PARTS)).toEqual(["uuid"]);
		expect(unplaced(FORM_KEY_PARTS)).toEqual(["uuid"]);
	});
});

describe("over the diff fuzz corpora", () => {
	it("counts a line exactly where a difference is given, and the count is the number of lines", async () => {
		await fc.assert(
			fc.property(
				endpointArb,
				endpointArb,
				fc.array(fc.boolean(), { minLength: 1, maxLength: 32 }),
				(a, b, mask) => {
					const before = endpoint(a);
					const after = endpoint(b);
					const all = documentDifferences(before, after);
					const some = all.filter((_, i) => mask[i % mask.length]);
					for (const given of [all, some]) {
						const changes = documentChanges(before, after, given);
						expect(changes.count === 0).toBe(given.length === 0);
						expect(documentChangeLines(changes, "hq")).toHaveLength(
							changes.count,
						);
						expect(documentChangeLines(changes, "nova")).toHaveLength(
							changes.count,
						);
						const listed = changes.forms.flatMap((form) =>
							Object.values(form.questions).flatMap((questions) =>
								questions.map((question) => question.uuid),
							),
						);
						expect(new Set(listed).size).toBe(listed.length);
					}
				},
			),
			{ numRuns: 200, seed: 20261115 },
		);
	}, 60_000);
});
