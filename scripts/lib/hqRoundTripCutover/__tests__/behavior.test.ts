/**
 * The no-write lines `behavior.ts` reads from the migrated document, over the
 * frozen fixtures: which entities each reason names, and that reading them
 * changes nothing in the document.
 */

import { type Element, isTag } from "domhandler";
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { expandDoc } from "@/lib/commcare/expander";
import { derivedUniqueId } from "@/lib/commcare/wireIdentity";
import { parseXml } from "@/lib/commcare/xmlParse";
import {
	asUuid,
	type BlueprintDoc,
	type Column,
	type Form,
	type Module,
	type Uuid,
} from "@/lib/domain";
import { DOCUMENT_NOTICE_REASONS } from "@/lib/notices/migrationNotice";
import {
	BEHAVIOR_SELECTIONS,
	behaviorChanges,
	caseListOrderChanges,
	caseListSearchMatchesHiddenFields,
	caseNameNowChecked,
	closeMovesToSaveToCase,
	followUpNowTouchesCase,
	hiddenOrderColumnNotInSortMenu,
	linkedFollowUpNowWritesCase,
	localArchiveChanges,
	recordIdColumnNowShows,
	validationNowEnforced,
} from "../behavior";
import {
	migratedFixtureDocument,
	readFixtureManifest,
} from "./fixtures/preStep";

const fixtures = readFixtureManifest().fixtures.map((fixture) => fixture.id);

function fieldsOf(doc: BlueprintDoc) {
	return Object.values(doc.fields);
}

function formNamed(doc: BlueprintDoc, name: string): Form {
	const form = Object.values(doc.forms).find(
		(candidate) => candidate.name === name,
	);
	if (form === undefined) throw new Error(`No form named ${name}.`);
	return form;
}

function formEntity(form: Form) {
	return { type: "form", uuid: form.uuid, nameAtMigration: form.name };
}

/**
 * The document with a second menu over the same case type that selects
 * several cases, and `form` moved into it from its own menu.
 */
function moveToMultiSelectMenu(doc: BlueprintDoc, form: Uuid): BlueprintDoc {
	return produce(doc, (draft) => {
		const from = draft.moduleOrder.find((uuid) =>
			(draft.formOrder[uuid] ?? []).includes(form),
		);
		const menu = from === undefined ? undefined : draft.modules[from];
		if (from === undefined || menu === undefined)
			throw new Error("No menu holds the form.");
		const several = asUuid("00000000-0000-4000-8000-00000000e001");
		draft.modules[several] = {
			...menu,
			uuid: several,
			name: `${menu.name}, several`,
			caseListConfig: {
				...menu.caseListConfig,
				selection: { kind: "multiple", maximum: 10 },
			},
		} as Module;
		draft.moduleOrder.push(several);
		draft.formOrder[from] = (draft.formOrder[from] ?? []).filter(
			(uuid) => uuid !== form,
		);
		draft.formOrder[several] = [form];
	});
}

describe("validation-now-enforced", () => {
	it("names each barcode and secret question that holds a validation, with its form and kind", () => {
		const doc = migratedFixtureDocument("hand-validated-barcode-secret");
		const validated = fieldsOf(doc).filter(
			(field) =>
				(field.kind === "barcode" || field.kind === "secret") &&
				field.validate !== undefined,
		);
		expect(validated.map((field) => field.kind).sort()).toEqual([
			"barcode",
			"secret",
		]);
		const lines = validationNowEnforced.select(doc);
		expect(lines).toHaveLength(validated.length);
		for (const field of validated) {
			const form = Object.values(doc.forms).find((candidate) =>
				JSON.stringify(doc.fieldOrder[candidate.uuid] ?? []).includes(
					field.uuid,
				),
			);
			expect(lines).toContainEqual({
				reason: "validation-now-enforced",
				entity: { type: "field", uuid: field.uuid, nameAtMigration: field.id },
				detail: { form: form?.name, kind: field.kind },
			});
		}
	});

	it.each(["xml-unicode", "localization-optional", "hand-media-slots"])(
		"names no validated question of another kind in %s",
		(id) => {
			const doc = migratedFixtureDocument(id);
			expect(
				fieldsOf(doc).some((field) => "validate" in field && field.validate),
			).toBe(true);
			expect(validationNowEnforced.select(doc)).toEqual([]);
		},
	);
});

describe("follow-up-now-touches-case", () => {
	it("names the write-free follow-up of a single-select menu and not the follow-up with a write", () => {
		const doc = migratedFixtureDocument("hand-linked-follow-up");
		expect(followUpNowTouchesCase.select(doc)).toEqual([
			{
				reason: "follow-up-now-touches-case",
				entity: formEntity(formNamed(doc, "Check-in")),
			},
		]);
	});

	it("names no write-free follow-up of a multi-select menu", () => {
		const doc = migratedFixtureDocument("hand-linked-follow-up");
		const several = moveToMultiSelectMenu(doc, formNamed(doc, "Check-in").uuid);
		expect(followUpNowTouchesCase.select(several)).toEqual([]);
	});
});

describe("linked-follow-up-now-writes-case", () => {
	it("names the follow-up a link with datums opens, with the link's form as its source", () => {
		const doc = migratedFixtureDocument("hand-linked-follow-up");
		// Register links to Check-in and to Visit with datums, and Visit to
		// Check-in without: only the first opens a write-free follow-up by a
		// written value.
		const register = formNamed(doc, "Register");
		expect(
			(register.formLinks ?? []).map((link) => link.datums !== undefined),
		).toEqual([true, true]);
		expect(
			(formNamed(doc, "Visit").formLinks ?? []).map(
				(link) => link.datums !== undefined,
			),
		).toEqual([false]);
		expect(linkedFollowUpNowWritesCase.select(doc)).toEqual([
			{
				reason: "linked-follow-up-now-writes-case",
				entity: formEntity(formNamed(doc, "Check-in")),
				detail: { source: "Register" },
			},
		]);
	});
});

describe("close-moves-to-save-to-case", () => {
	it("names each close of a single-select menu the Case Management tab cannot state", () => {
		const doc = migratedFixtureDocument("hand-close-conditions");
		expect(closeMovesToSaveToCase.select(doc)).toEqual(
			["Close when done", "Close on either", "Close on the outcome"].map(
				(name) => ({
					reason: "close-moves-to-save-to-case",
					entity: formEntity(formNamed(doc, name)),
				}),
			),
		);
	});

	it("names no statable close and no close of a multi-select menu", () => {
		const frozen = migratedFixtureDocument("hand-close-conditions");
		// "Close when done" reads a Hidden Value with the answer `"done"`;
		// without the quotes the tab states it. "Close on either" moves to a
		// menu that selects several cases. "Close on the outcome" reads a
		// text question, which the tab does not offer.
		const statable = formNamed(frozen, "Close when done").uuid;
		const doc = produce(
			moveToMultiSelectMenu(frozen, formNamed(frozen, "Close on either").uuid),
			(draft) => {
				const condition = draft.forms[statable]?.closeCondition;
				if (condition === undefined) throw new Error("No close condition.");
				condition.answer = "done";
			},
		);
		expect(closeMovesToSaveToCase.select(doc)).toEqual([
			{
				reason: "close-moves-to-save-to-case",
				entity: formEntity(formNamed(doc, "Close on the outcome")),
			},
		]);
	});

	it("moves each such close, once, from the form's own case block to its Save to Case block", () => {
		const doc = migratedFixtureDocument("hand-close-conditions");
		const app = expandDoc(doc);
		const closes = closeMovesToSaveToCase.select(doc);
		expect(closes).toHaveLength(3);
		for (const { entity } of closes) {
			const uuid = asUuid(entity.uuid ?? "");
			const hqForm = app.modules
				.flatMap((module) => module.forms)
				.find((form) => form.unique_id === derivedUniqueId(uuid));
			expect(hqForm?.actions.close_case.condition.type).toBe("never");
			const source = app._attachments[`${derivedUniqueId(uuid)}.xml`];
			if (typeof source !== "string") throw new Error("No form source.");
			// The pre-step emitter wrote the close as the form's own case
			// block's `/data/case/close`.
			expect(closePaths(source)).toEqual([
				"/data/nova_operations/nova_condition_close/nova_close/case/close",
			]);
		}
	});
});

/** The path of every `close` element in a form source's data instance. */
function closePaths(xform: string): string[] {
	const children = (element: { children: unknown[] }): Element[] =>
		element.children.filter((child): child is Element => isTag(child as never));
	const named = (element: Element, name: string) =>
		element.name === name || element.name.endsWith(`:${name}`);
	const local = (element: Element) =>
		element.name.slice(element.name.indexOf(":") + 1);
	const descend = (element: Element, name: string) =>
		children(element).find((child) => named(child, name));
	const html = descend(
		{ children: parseXml(xform).children } as Element,
		"html",
	);
	const head = html === undefined ? undefined : descend(html, "head");
	const model = head === undefined ? undefined : descend(head, "model");
	const instance = model === undefined ? undefined : descend(model, "instance");
	const data = instance === undefined ? undefined : children(instance)[0];
	if (data === undefined) throw new Error("No data instance.");
	const paths: string[] = [];
	const walk = (element: Element, path: string) => {
		if (local(element) === "close") paths.push(path);
		for (const child of children(element))
			walk(child, `${path}/${local(child)}`);
	};
	walk(data, `/${local(data)}`);
	return paths;
}

/**
 * The `navigation-base` document with Visit's one question writing the case
 * name of `caseType`: the visited patient's, a rename, or a `referral` child
 * case's, a create.
 */
function withVisitAnswerWriting(caseType: string): BlueprintDoc {
	return produce(migratedFixtureDocument("navigation-base"), (draft) => {
		draft.caseTypes = [
			...(draft.caseTypes ?? []),
			{
				name: "referral",
				properties: [],
				parent_type: "patient",
				relationship: "child",
			},
		];
		const answer = Object.values(draft.fields).find(
			(field) => field.id === "answer",
		);
		if (answer === undefined || !("caseWrite" in answer))
			throw new Error("No answer question.");
		answer.caseWrite = { caseType, property: "case_name" };
	});
}

describe("case-name-now-checked", () => {
	it("names the form whose create reads a question a worker answers, with the question", () => {
		const doc = migratedFixtureDocument("navigation-base");
		// Visit writes no case name.
		expect(caseNameNowChecked.select(doc)).toEqual([
			{
				reason: "case-name-now-checked",
				entity: formEntity(formNamed(doc, "Register")),
				detail: { question: "name" },
			},
		]);
	});

	it("names the follow-up whose rename reads a question a worker answers, in a single-select menu only", () => {
		const doc = withVisitAnswerWriting("patient");
		const visit = formNamed(doc, "Visit");
		expect(caseNameNowChecked.select(doc)).toEqual([
			{
				reason: "case-name-now-checked",
				entity: formEntity(visit),
				detail: { question: "answer" },
			},
			{
				reason: "case-name-now-checked",
				entity: formEntity(formNamed(doc, "Register")),
				detail: { question: "name" },
			},
		]);
		// A multi-select menu renames its cases in the form's source.
		expect(
			caseNameNowChecked
				.select(moveToMultiSelectMenu(doc, visit.uuid))
				.map((change) => change.entity.nameAtMigration),
		).toEqual(["Register"]);
	});

	it("names the form whose child case's name reads a question a worker answers", () => {
		const doc = withVisitAnswerWriting("referral");
		expect(caseNameNowChecked.select(doc)).toContainEqual({
			reason: "case-name-now-checked",
			entity: formEntity(formNamed(doc, "Visit")),
			detail: { question: "answer" },
		});
	});

	it("names no form whose case name comes from a Hidden Value", () => {
		const frozen = migratedFixtureDocument("navigation-base");
		const doc = produce(frozen, (draft) => {
			const name = Object.values(draft.fields).find(
				(field) =>
					"caseWrite" in field && field.caseWrite?.property === "case_name",
			);
			if (name === undefined || !("caseWrite" in name))
				throw new Error("No case name question.");
			draft.fields[name.uuid] = {
				uuid: name.uuid,
				kind: "hidden",
				id: name.id,
				caseWrite: name.caseWrite,
			} as BlueprintDoc["fields"][Uuid];
		});
		expect(caseNameNowChecked.select(doc)).toEqual([]);
	});
});

describe("local-archive-changes", () => {
	it.each(fixtures.filter((id) => id !== "hand-target-parse"))(
		"names %s once, as the app, with no detail",
		(id) => {
			const doc = migratedFixtureDocument(id);
			expect(localArchiveChanges.select(doc)).toEqual([
				{
					reason: "local-archive-changes",
					entity: { type: "app", nameAtMigration: doc.appName },
				},
			]);
		},
	);
});

describe("the no-write lines", () => {
	it("are selected in the enum's order", () => {
		expect(BEHAVIOR_SELECTIONS.map((selection) => selection.reason)).toEqual(
			DOCUMENT_NOTICE_REASONS.filter((reason) =>
				BEHAVIOR_SELECTIONS.some((selection) => selection.reason === reason),
			),
		);
		expect(BEHAVIOR_SELECTIONS.map((selection) => selection.reason)).toEqual([
			"validation-now-enforced",
			"follow-up-now-touches-case",
			"linked-follow-up-now-writes-case",
			"close-moves-to-save-to-case",
			"case-list-order-changes",
			"case-list-search-matches-hidden-fields",
			"hidden-order-column-not-in-sort-menu",
			"record-id-column-now-shows",
			"local-archive-changes",
			"case-name-now-checked",
		]);
		expect(
			behaviorChanges(
				migratedFixtureDocument("hand-validated-barcode-secret"),
			).map((change) => change.reason),
		).toEqual([
			"validation-now-enforced",
			"validation-now-enforced",
			"local-archive-changes",
		]);
	});

	it("change nothing in the document they read", () => {
		const doc = migratedFixtureDocument("hand-validated-barcode-secret");
		const before = structuredClone(doc);
		behaviorChanges(doc);
		expect(doc).toEqual(before);
	});
});

// ── Pull request 11: case lists ─────────────────────────────────────

/** The one menu of navigation-base, whose list holds one plain Name column. */
const PATIENTS = asUuid("17a69048-be0c-59d4-a7a2-9bda805659b8");
const NAME_COLUMN = asUuid("56aac6e0-30dd-5cf4-aa85-c23ed492bfd0");
const columnUuid = (n: number) =>
	asUuid(`00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`);

/**
 * navigation-base with `columns` added to its list. Each goes first on
 * Results when `first` is set, and last otherwise, and last on Details.
 */
function withColumns(
	columns: readonly Column[],
	options: { first?: boolean; tile?: boolean } = {},
): BlueprintDoc {
	return produce(migratedFixtureDocument("navigation-base"), (draft) => {
		const config = draft.modules[PATIENTS]?.caseListConfig;
		if (config === undefined) throw new Error("navigation-base has no list.");
		for (const column of columns) {
			config.columns.push(column as never);
			if (options.first) config.listColumnOrder.unshift(column.uuid);
			else config.listColumnOrder.push(column.uuid);
			config.detailColumnOrder.push(column.uuid);
		}
		if (options.tile) config.tile = {} as never;
	});
}

function columnEntity(uuid: Uuid, name: string) {
	return { type: "caseListColumn", uuid, nameAtMigration: name };
}

const PATIENTS_ENTITY = {
	type: "module",
	uuid: PATIENTS,
	nameAtMigration: "Patients",
};

describe("case-list-order-changes", () => {
	it("names the ID mapping and the select's labels each list orders by first", () => {
		const doc = migratedFixtureDocument("targeted-label-sort");
		const menuNamed = (name: string) => {
			const module = Object.values(doc.modules).find(
				(candidate) => candidate.name === name,
			);
			if (module === undefined) throw new Error(`No menu ${name}.`);
			return { type: "module", uuid: module.uuid, nameAtMigration: name };
		};
		expect(caseListOrderChanges.select(doc)).toEqual([
			{
				reason: "case-list-order-changes",
				entity: menuNamed("Households by zone"),
				detail: { cause: "id-mapping", column: "Zone", kind: "id-mapping" },
			},
			{
				reason: "case-list-order-changes",
				entity: menuNamed("Households by level"),
				detail: { cause: "option-label", column: "Level", kind: "plain" },
			},
		]);
	});

	it("names a list with no order rule, and adds the date sentence where its first column is a date", () => {
		expect(
			caseListOrderChanges.select(migratedFixtureDocument("navigation-base")),
		).toEqual([
			{
				reason: "case-list-order-changes",
				entity: PATIENTS_ENTITY,
				detail: { cause: "unsorted", kind: "plain" },
			},
		]);
		const dated = withColumns(
			[
				{
					uuid: columnUuid(0xe101),
					kind: "date",
					field: "date_opened",
					header: "Opened",
					pattern: "%Y-%m-%d",
				},
			],
			{ first: true },
		);
		expect(caseListOrderChanges.select(dated)).toEqual([
			{
				reason: "case-list-order-changes",
				entity: PATIENTS_ENTITY,
				detail: { cause: "unsorted", kind: "date" },
			},
		]);
	});

	it("names a shown interval column and, in an app with media, a shown image map that takes the first rule", () => {
		const interval = withColumns([
			{
				uuid: columnUuid(0xe102),
				kind: "interval",
				field: "date_opened",
				header: "Since",
				threshold: 7,
				unit: "days",
				display: "always",
				text: "Overdue",
				sort: { direction: "asc", priority: 0 },
			},
		]);
		expect(caseListOrderChanges.select(interval)).toEqual([
			{
				reason: "case-list-order-changes",
				entity: PATIENTS_ENTITY,
				detail: { cause: "interval", column: "Since", kind: "interval" },
			},
		]);
		const imageMap = (assetIds: readonly string[]) =>
			withColumns([
				{
					uuid: columnUuid(0xe103),
					kind: "image-map",
					field: "notes",
					header: "Badge",
					mapping: assetIds.map((assetId, index) => ({
						value: `v${index}`,
						assetId,
					})),
					sort: { direction: "desc", priority: 0 },
				} as Column,
			]);
		expect(caseListOrderChanges.select(imageMap(["asset-one"]))).toEqual([
			{
				reason: "case-list-order-changes",
				entity: PATIENTS_ENTITY,
				detail: { cause: "image-map", column: "Badge", kind: "image-map" },
			},
		]);
		// An app with no media orders its empty map the same everywhere.
		expect(caseListOrderChanges.select(imageMap([]))).toEqual([]);
	});

	it("names no list whose first rule lands on a plain column, a hidden column or a carrier", () => {
		const sortedName = produce(
			migratedFixtureDocument("navigation-base"),
			(draft) => {
				const name = draft.modules[PATIENTS]?.caseListConfig?.columns.find(
					(column) => column.uuid === NAME_COLUMN,
				);
				if (name === undefined) throw new Error("No Name column.");
				name.sort = { direction: "asc", priority: 0 };
			},
		);
		expect(caseListOrderChanges.select(sortedName)).toEqual([]);
		const hiddenMapping = withColumns([
			{
				uuid: columnUuid(0xe104),
				kind: "id-mapping",
				field: "notes",
				header: "Code",
				mapping: [{ value: "a", label: "A" }],
				visibleInList: false,
				sort: { direction: "asc", priority: 0 },
			},
		]);
		expect(caseListOrderChanges.select(hiddenMapping)).toEqual([]);
		const carrier = withColumns(
			[
				{
					uuid: columnUuid(0xe105),
					kind: "id-mapping",
					field: "notes",
					header: "Code",
					mapping: [{ value: "a", label: "A" }],
					visibleInList: false,
					sort: { direction: "asc", priority: 0 },
				},
			],
			{ tile: true },
		);
		expect(caseListOrderChanges.select(carrier)).toEqual([]);
	});
});

describe("case-list-search-matches-hidden-fields and hidden-order-column-not-in-sort-menu", () => {
	const hidden = (sorted: boolean): Column => ({
		uuid: columnUuid(0xe201),
		kind: "plain",
		field: "notes",
		header: "Notes",
		visibleInList: false,
		...(sorted && { sort: { direction: "asc" as const, priority: 0 } }),
	});

	it("names a row list's hidden column for search, and a hidden column with an order rule for the Sort menu", () => {
		const doc = migratedFixtureDocument("hand-case-list-order");
		expect(caseListSearchMatchesHiddenFields.select(doc)).toEqual([
			{
				reason: "case-list-search-matches-hidden-fields",
				entity: PATIENTS_ENTITY,
			},
		]);
		expect(hiddenOrderColumnNotInSortMenu.select(doc)).toEqual([
			{
				reason: "hidden-order-column-not-in-sort-menu",
				entity: columnEntity(columnUuid(0xe01), "Notes"),
				detail: { menu: "Patients" },
			},
		]);
	});

	it("names no tile list for search, and still names its hidden order column", () => {
		const doc = withColumns([hidden(true)], { tile: true });
		expect(caseListSearchMatchesHiddenFields.select(doc)).toEqual([]);
		expect(hiddenOrderColumnNotInSortMenu.select(doc)).toEqual([
			{
				reason: "hidden-order-column-not-in-sort-menu",
				entity: columnEntity(columnUuid(0xe201), "Notes"),
				detail: { menu: "Patients" },
			},
		]);
	});

	it("names no Sort menu change for a hidden column with no order rule, nor any line for a list with none hidden", () => {
		expect(
			hiddenOrderColumnNotInSortMenu.select(withColumns([hidden(false)])),
		).toEqual([]);
		const shown = migratedFixtureDocument("navigation-base");
		expect(caseListSearchMatchesHiddenFields.select(shown)).toEqual([]);
		expect(hiddenOrderColumnNotInSortMenu.select(shown)).toEqual([]);
	});
});

describe("record-id-column-now-shows", () => {
	const overCaseId = (
		n: number,
		column: Partial<Column> & Pick<Column, "kind">,
	): Column =>
		({
			uuid: columnUuid(n),
			field: "case_id",
			header: `Record ${n.toString(16)}`,
			...column,
		}) as Column;

	it("names a plain, a phone and an image-map column over case_id that reach a screen, each with its kind", () => {
		const doc = withColumns([
			overCaseId(0xe301, { kind: "plain" }),
			overCaseId(0xe302, { kind: "phone" }),
			overCaseId(0xe303, {
				kind: "image-map",
				mapping: [],
				visibleInList: false,
			} as Partial<Column> & Pick<Column, "kind">),
		]);
		expect(recordIdColumnNowShows.select(doc)).toEqual(
			[
				[0xe301, "plain"],
				[0xe302, "phone"],
				[0xe303, "image-map"],
			].map(([n, kind]) => ({
				reason: "record-id-column-now-shows",
				entity: columnEntity(
					columnUuid(n as number),
					`Record ${(n as number).toString(16)}`,
				),
				detail: { menu: "Patients", kind },
			})),
		);
	});

	it("names no ID mapping or link over case_id, and no column hidden from both screens", () => {
		const doc = withColumns([
			overCaseId(0xe304, {
				kind: "id-mapping",
				mapping: [{ value: "a", label: "A" }],
			} as Partial<Column> & Pick<Column, "kind">),
			overCaseId(0xe305, { kind: "link", linkText: "Open" } as Partial<Column> &
				Pick<Column, "kind">),
			overCaseId(0xe306, {
				kind: "plain",
				visibleInList: false,
				visibleInDetail: false,
			}),
		]);
		expect(recordIdColumnNowShows.select(doc)).toEqual([]);
	});
});
