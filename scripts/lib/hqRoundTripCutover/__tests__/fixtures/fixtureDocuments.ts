/**
 * The seventeen corpus documents the cutover's frozen fixtures are taken
 * from, each named by what it must hold (part 10 of step 2's plan, "Frozen
 * pre-step fixtures"), and the eleven histories written over five of them.
 *
 * Each row's `check` reads the raw carriers alone, so the capture test can
 * hold every fixture to its row at any head of the stack and fail naming the
 * row when a document does not hold it.
 */

import type { Mutation } from "@/lib/doc/types";
import { asUuid, type BlueprintDoc } from "@/lib/domain";
import type { Json, JsonRecord, RawDocument } from "../../oldShape";
import type { FixtureWitnesses } from "./preStep";

export interface FixtureDocument {
	readonly id: string;
	/** The fixture's carriers are the document after its drawn edit (`edit/document.json`). */
	readonly edited: boolean;
	/** What the row says the document holds. */
	readonly holds: string;
	readonly check: (document: RawDocument) => boolean;
	readonly witnesses: FixtureWitnesses;
}

const NONE: FixtureWitnesses = { steps: [], blockers: [], reasons: [] };

function record(value: Json | undefined): JsonRecord | undefined {
	return value !== null &&
		value !== undefined &&
		typeof value === "object" &&
		!Array.isArray(value)
		? (value as JsonRecord)
		: undefined;
}

function list(value: Json | undefined): readonly Json[] {
	return Array.isArray(value) ? value : [];
}

const forms = (document: RawDocument) => Object.values(document.forms);
const fields = (document: RawDocument) => Object.values(document.fields);
const modules = (document: RawDocument) => Object.values(document.modules);
const operations = (document: RawDocument) =>
	forms(document).flatMap((form) => list(form.caseOperations).map(record));

function leafCount(document: RawDocument, formUuid: string): number {
	return (document.fieldOrder[formUuid] ?? []).length;
}

export const FIXTURE_DOCUMENTS: readonly FixtureDocument[] = [
	{
		id: "case-operation-query",
		edited: false,
		holds:
			"case operations and a query repeat (the item step); its one create is target new with no idFrom",
		check: (document) => {
			const creates = operations(document).filter(
				(operation) => operation?.action === "create",
			);
			return (
				fields(document).some(
					(field) =>
						field.kind === "repeat" && field.repeat_mode === "query_bound",
				) &&
				creates.length === 1 &&
				record(creates[0]?.target)?.kind === "new" &&
				record(creates[0]?.target)?.idFrom === undefined
			);
		},
		witnesses: {
			steps: [],
			blockers: [],
			reasons: ["data-paths-move-once", "next-publish-asks-more"],
		},
	},
	{
		id: "case-operation-key",
		edited: false,
		holds: "a root create keyed by an answer (idFrom, outside any repeat)",
		check: (document) =>
			operations(document).some(
				(operation) =>
					operation?.action === "create" &&
					typeof record(operation.target)?.idFrom === "string" &&
					operation.forEach === undefined,
			),
		witnesses: NONE,
	},
	{
		id: "targeted-custom-tile",
		edited: false,
		holds: "a tile list with cells missing the three slots",
		check: (document) =>
			modules(document).some((module) =>
				list(record(module.caseListConfig)?.columns).some((column) => {
					const tile = record(record(column)?.tile);
					return (
						tile !== undefined &&
						(tile.horizontalAlign === undefined ||
							tile.verticalAlign === undefined ||
							tile.fontSize === undefined)
					);
				}),
			),
		witnesses: {
			steps: ["tile-cells"],
			blockers: [],
			reasons: ["tile-cell-defaults-set"],
		},
	},
	{
		id: "targeted-form-links-hidden-and-fallback",
		edited: false,
		holds:
			"three menus and five forms, form links, a destination a link takes when its condition fails; no hidden no-matches menu",
		check: (document) =>
			document.moduleOrder.length === 3 &&
			forms(document).length === 5 &&
			forms(document).some((form) => list(form.formLinks).length > 0) &&
			!forms(document).some(
				(form) => record(form.entry)?.kind === "search-no-matches",
			),
		witnesses: NONE,
	},
	{
		id: "no-matches-parent",
		edited: false,
		holds: "a hidden no-matches menu beside two authored menus",
		check: (document) =>
			document.moduleOrder.length === 2 &&
			forms(document).some(
				(form) => record(form.entry)?.kind === "search-no-matches",
			),
		witnesses: NONE,
	},
	{
		id: "targeted-invalid-connect-ids",
		edited: false,
		holds: "a Connect app with ids the grammar refuses",
		check: (document) =>
			document.connectType !== null &&
			forms(document).some((form) => {
				const connect = record(form.connect);
				return (
					connect !== undefined &&
					Object.values(connect).some((block) => {
						const id = record(block)?.id;
						return typeof id === "string" && /^(_|xml)/i.test(id);
					})
				);
			}),
		witnesses: {
			steps: ["connect-ids"],
			blockers: [],
			reasons: ["connect-block-renamed"],
		},
	},
	{
		id: "connect-deliver-default",
		edited: false,
		holds:
			"a Connect deliver form holding a deliver unit and a task beside two questions",
		check: (document) =>
			forms(document).some((form) => {
				const connect = record(form.connect);
				return (
					connect?.deliver_unit !== undefined &&
					connect.task !== undefined &&
					leafCount(document, String(form.uuid)) === 2
				);
			}),
		witnesses: {
			steps: ["connect-task-forms"],
			blockers: [],
			reasons: ["connect-task-moved-to-own-form"],
		},
	},
	{
		id: "targeted-invalid-question-ids",
		edited: false,
		holds: "question ids the grammar refuses",
		check: (document) =>
			fields(document).some(
				(field) =>
					typeof field.id === "string" &&
					(/^(_|xml)/i.test(field.id) || field.id.toLowerCase() === "meta"),
			),
		witnesses: {
			steps: ["question-ids", "entry-point-ids"],
			blockers: [],
			reasons: [
				"question-renamed",
				"entry-point-renamed",
				"deep-links-need-republish",
			],
		},
	},
	{
		id: "targeted-search-hq-compile",
		edited: false,
		holds:
			"one reserved input name, include_closed (simple, no options source), beside an owner_id input",
		check: (document) =>
			modules(document).some((module) => {
				const inputs = list(record(module.caseListConfig)?.searchInputs).map(
					record,
				);
				return (
					inputs.some(
						(input) =>
							input?.name === "include_closed" &&
							input.kind === "simple" &&
							input.optionsSource === undefined,
					) && inputs.some((input) => input?.name === "owner_id")
				);
			}),
		witnesses: {
			steps: ["reserved-search-inputs"],
			blockers: [],
			reasons: ["search-input-removed"],
		},
	},
	{
		id: "prompt-widgets",
		edited: false,
		holds: "a lookup-backed search input",
		check: (document) =>
			modules(document).some((module) =>
				list(record(module.caseListConfig)?.searchInputs).some(
					(input) => record(record(input)?.options)?.kind === "lookup",
				),
			),
		witnesses: {
			steps: [],
			blockers: [],
			reasons: [
				"lookup-choices-order-changes",
				"lookup-table-content-unsupported",
			],
		},
	},
	{
		id: "targeted-search-button-label",
		edited: true,
		holds:
			"a search button label (the document after its edit, which sets it with no translation entry)",
		check: (document) =>
			modules(document).some(
				(module) =>
					typeof record(module.caseSearchConfig)?.searchButtonLabel ===
					"string",
			),
		witnesses: {
			steps: ["search-button-label"],
			blockers: [],
			reasons: ["search-button-text-changed"],
		},
	},
	{
		id: "localization-optional",
		edited: false,
		holds: "several languages with a stored localization root",
		check: (document) =>
			list(record(document.localization)?.languageOrder).length > 1,
		witnesses: {
			steps: ["language-wire-codes"],
			blockers: [],
			reasons: [],
		},
	},
	{
		id: "container-live-count-entry",
		edited: false,
		holds:
			"questions inside sections, and a counted repeat whose generated count leaf HQ holds",
		check: (document) =>
			fields(document).some((field) => field.kind === "section") &&
			fields(document).some(
				(field) =>
					field.kind === "repeat" && field.repeat_mode === "count_bound",
			),
		witnesses: NONE,
	},
	{
		id: "xml-unicode",
		edited: false,
		holds:
			"fifteen questions, three with a validation message that reads a question",
		check: (document) =>
			forms(document).some(
				(form) => leafCount(document, String(form.uuid)) === 15,
			),
		witnesses: NONE,
	},
	{
		id: "navigation-base",
		edited: false,
		holds: "two forms in one menu",
		check: (document) =>
			document.moduleOrder.length === 1 &&
			(document.formOrder[document.moduleOrder[0] ?? ""] ?? []).length === 2,
		witnesses: {
			steps: ["app-settings"],
			blockers: ["app-mapping-without-pushed-revision"],
			reasons: [
				"android-form-lists-setting-stored",
				"local-archive-changes",
				"case-name-now-checked",
				"ccz-needs-project-space",
				"form-ids-change-once",
				"ids-change-once-unreadable",
				"hq-app-deleted",
				"hq-app-not-nova-made",
				"next-publish-overwrites-hq-edits",
				"next-publish-asks-before-overwriting",
				"setting-changes-at-next-publish",
				"settings-unknown-unreadable",
				"worker-settings-reset-at-next-publish",
				"commcare-version-below-floor",
			],
		},
	},
	{
		id: "case-choice-attendance",
		edited: false,
		holds:
			"selects whose choices are the worker's cases, and an attendance checklist over a query repeat inside a section",
		check: (document) => {
			const caseSelects = fields(document).filter(
				(field) => record(field.optionsSource)?.kind === "cases",
			);
			return (
				caseSelects.length >= 3 &&
				caseSelects.some(
					(field) => record(field.optionsSource)?.filter === undefined,
				) &&
				fields(document).some(
					(field) =>
						field.kind === "repeat" && field.repeat_mode === "query_bound",
				)
			);
		},
		witnesses: NONE,
	},
	{
		id: "targeted-label-sort",
		edited: false,
		holds:
			"two menus on one case type, each holding a follow-up named Visit with the one question notes",
		check: (document) =>
			document.moduleOrder.length === 2 &&
			document.moduleOrder.every((menu) => {
				const [form] = document.formOrder[menu] ?? [];
				const fieldUuids = document.fieldOrder[form ?? ""] ?? [];
				return (
					document.forms[form ?? ""]?.name === "Visit" &&
					fieldUuids.length === 1 &&
					document.fields[fieldUuids[0] ?? ""]?.id === "notes"
				);
			}),
		witnesses: {
			steps: [],
			blockers: [],
			reasons: ["menu-id-changes-once"],
		},
	},
];

// ── Histories ────────────────────────────────────────────────────────

/** One batch of a history, built over the document it applies to. */
export type HistoryBatch = (doc: BlueprintDoc) => Mutation[];

export interface HistorySpec {
	readonly document: string;
	readonly name: string;
	readonly batches: (start: BlueprintDoc) => readonly HistoryBatch[];
	/** What path two pairs, and at which stage (part 10, the histories table). */
	readonly pathTwo: string;
}

function menuNamed(doc: BlueprintDoc, name: string) {
	const uuid = doc.moduleOrder.find((menu) => doc.modules[menu]?.name === name);
	if (uuid === undefined) throw new Error(`No menu named ${name}.`);
	return asUuid(uuid);
}

function formNamed(doc: BlueprintDoc, menu: string, name: string) {
	const uuid = (doc.formOrder[asUuid(menu)] ?? []).find(
		(form) => doc.forms[form]?.name === name,
	);
	if (uuid === undefined) throw new Error(`No form named ${name}.`);
	return asUuid(uuid);
}

function fieldNamed(doc: BlueprintDoc, form: string, id: string) {
	const uuid = (doc.fieldOrder[asUuid(form)] ?? []).find(
		(field) => doc.fields[field]?.id === id,
	);
	if (uuid === undefined) throw new Error(`No question ${id}.`);
	return asUuid(uuid);
}

export const HISTORIES: readonly HistorySpec[] = [
	{
		document: "targeted-form-links-hidden-and-fallback",
		name: "menu-moved",
		pathTwo:
			"Every menu at stage 1, each at another index; every form at stage 2 in its own menu",
		batches: () => [
			(doc) => [
				{ kind: "moveModule", uuid: menuNamed(doc, "Frogs"), after: null },
			],
		],
	},
	{
		document: "targeted-form-links-hidden-and-fallback",
		name: "form-moved",
		pathTwo:
			"Review Ponds at stage 3, in another menu; the four other forms at stage 2",
		batches: () => [
			(doc) => [
				{
					kind: "moveForm",
					uuid: formNamed(doc, menuNamed(doc, "Ponds"), "Review Ponds"),
					toModuleUuid: menuNamed(doc, "Sites"),
					after: null,
				},
			],
		],
	},
	{
		document: "no-matches-parent",
		name: "empty-menu-moved",
		pathTwo:
			"Every menu at stage 1, Households by its name at another index and the hidden menu by its form's name; both forms at stage 2",
		batches: () => [
			(doc) => [
				{ kind: "moveModule", uuid: menuNamed(doc, "Households"), after: null },
			],
		],
	},
	{
		document: "no-matches-parent",
		name: "menu-renamed",
		pathTwo:
			"Households and the hidden menu at stage 1; Register patient at stage 2 and Visit at stage 3; Clients at stage 4, by Visit",
		batches: () => [
			(doc) => [
				{
					kind: "renameModule",
					uuid: menuNamed(doc, "Patients"),
					newId: "Clients",
				},
			],
		],
	},
	{
		document: "no-matches-parent",
		name: "empty-menu-renamed",
		pathTwo:
			"Patients and the hidden menu at stage 1; Homes at stage 5, by its case type alone; both forms at stage 2",
		batches: () => [
			(doc) => [
				{
					kind: "renameModule",
					uuid: menuNamed(doc, "Households"),
					newId: "Homes",
				},
			],
		],
	},
	{
		document: "xml-unicode",
		name: "questions-removed",
		pathTwo: "The form at stage 2, with ten of the fifteen paths HQ holds",
		batches: () => [
			(doc) => {
				const menu = menuNamed(doc, "Surveys");
				const form = formNamed(doc, menu, "Interview");
				return [
					"space",
					"xml_whitespace",
					"unicode_spacing",
					"mixed_nbsp",
					"consumer_spacing",
				].map((id) => ({
					kind: "removeField" as const,
					uuid: fieldNamed(doc, form, id),
				}));
			},
		],
	},
	{
		document: "xml-unicode",
		name: "typeless-menu-renamed",
		pathTwo: "No menu at stage 1; the form at stage 3; the menu at stage 4",
		batches: () => [
			(doc) => [
				{
					kind: "renameModule",
					uuid: menuNamed(doc, "Surveys"),
					newId: "Field surveys",
				},
			],
		],
	},
	{
		document: "navigation-base",
		name: "form-renamed",
		pathTwo: "Register at stage 2; Home visit at stage 6, by its paths",
		batches: () => [
			(doc) => [
				{
					kind: "renameForm",
					uuid: formNamed(doc, menuNamed(doc, "Patients"), "Visit"),
					newId: "Home visit",
				},
			],
		],
	},
	{
		document: "navigation-base",
		name: "question-renamed",
		pathTwo: "Register at stage 2; Visit at stage 6, by its name",
		batches: () => [
			(doc) => {
				const form = formNamed(doc, menuNamed(doc, "Patients"), "Visit");
				const field = fieldNamed(doc, form, "answer");
				return [
					{
						kind: "updateField",
						uuid: field,
						targetKind: doc.fields[field]?.kind,
						patch: { id: "reply" },
					} as unknown as Mutation,
				];
			},
		],
	},
	{
		document: "navigation-base",
		name: "form-reordered",
		pathTwo: "Both forms at stage 2, each at another form index",
		batches: () => [
			(doc) => {
				const menu = menuNamed(doc, "Patients");
				return [
					{
						kind: "moveForm",
						uuid: formNamed(doc, menu, "Visit"),
						toModuleUuid: menu,
						after: formNamed(doc, menu, "Register"),
					},
				];
			},
		],
	},
	{
		document: "targeted-label-sort",
		name: "twin-moved",
		pathTwo:
			"Both menus at stage 1; the moved Visit is contested and the pair dissolved: both forms stay unpaired",
		batches: () => [
			(doc) => {
				const first = menuNamed(doc, "Households by zone");
				const second = menuNamed(doc, "Households by level");
				return [
					{
						kind: "moveForm",
						uuid: formNamed(doc, second, "Visit"),
						toModuleUuid: first,
						after: null,
					},
					{
						kind: "updateModule",
						uuid: second,
						patch: { caseListOnly: true },
					} as unknown as Mutation,
				];
			},
			(doc) => {
				const first = menuNamed(doc, "Households by zone");
				const [, own] = doc.formOrder[first] ?? [];
				if (own === undefined)
					throw new Error("The first menu's own Visit is missing.");
				return [{ kind: "renameForm", uuid: own, newId: "Zone visit" }];
			},
		],
	},
];
