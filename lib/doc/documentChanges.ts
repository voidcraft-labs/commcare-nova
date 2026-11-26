/**
 * What changed between two documents, by place: each menu and form that
 * changed and in which of its parts, each question of a form named by its
 * id, and a handful of things at the app's level. Pure and client-safe.
 *
 * It words nothing: `lib/publish/documentChangeCopy.ts::documentChangeLines`
 * turns a value into the lines a person reads, and `count` is exactly the
 * number of those lines, so a list has something on it exactly where its
 * count is above zero. Every difference given is filed under some line: a
 * difference is never dropped.
 *
 * Each difference is filed under the entity it lies in: a question under its
 * form (through either document's parent index), a form under its menu. Names
 * come from `after`, and from `before` for a removed thing. A question is
 * named by its id, with the ids of the groups, repeats and sections above it
 * joined by "/", since an id is unique only among its siblings.
 */

import { deepEqual } from "@/lib/doc/deepEqual";
import {
	type BlueprintDoc,
	type CaseListConfig,
	type Column,
	columnOnList,
	type Form,
	type Module,
	type PersistableDoc,
	type Uuid,
} from "@/lib/domain";
import {
	effectiveAppLocalization,
	languageEntries,
} from "@/lib/domain/localization";
import { type AssetRef, walkAssetRefs } from "@/lib/domain/mediaRefs";
import {
	type DocumentDifference,
	documentDifferences,
} from "./documentDifferences";

export type MenuPart =
	| "name"
	| "case-list"
	| "case-details"
	| "search"
	| "settings"
	| "note";
export type FormPart =
	| "name"
	| "menu"
	| "settings"
	| "case-changes"
	| "after-submit"
	| "note";
export type AppPart =
	| "name"
	| "languages"
	| "settings"
	| "logo"
	| "case-types"
	| "worker-properties"
	| "roles"
	| "personas"
	| "organization"
	| "automations";

/** The order a menu's, a form's and the app's parts are listed in. */
export const MENU_PARTS: readonly MenuPart[] = [
	"name",
	"case-list",
	"case-details",
	"search",
	"settings",
	"note",
];
export const FORM_PARTS: readonly FormPart[] = [
	"name",
	"menu",
	"settings",
	"case-changes",
	"after-submit",
	"note",
];
export const APP_PARTS: readonly AppPart[] = [
	"name",
	"languages",
	"settings",
	"logo",
	"case-types",
	"worker-properties",
	"roles",
	"personas",
	"organization",
	"automations",
];

/** One question, named as Nova names a question for a person: by its id (see above). */
export interface QuestionRef {
	readonly uuid: Uuid;
	readonly name: string;
}
export interface FormChange {
	readonly uuid: Uuid;
	readonly name: string;
	readonly menuName: string;
	readonly state: "added" | "removed" | "changed";
	readonly parts: readonly FormPart[];
	/** Each question once, in the form's order. A count is a list's length. */
	readonly questions: {
		readonly added: readonly QuestionRef[];
		readonly removed: readonly QuestionRef[];
		readonly changed: readonly QuestionRef[];
		readonly moved: readonly QuestionRef[];
	};
}
export interface MenuChange {
	readonly uuid: Uuid;
	readonly name: string;
	readonly state: "added" | "removed" | "changed";
	readonly parts: readonly MenuPart[];
	readonly formsReordered: boolean;
}
export interface DocumentChanges {
	readonly app: readonly AppPart[];
	readonly translations: {
		/** Entries added, removed, or holding another text. */
		readonly text: number;
		/** Entries holding the same text whose review state, origin or source fingerprint differs. */
		readonly review: number;
	};
	/** The pictures and sounds the differences add, remove or replace: a
	 *  choice's slot is its choice's, an image map's rows are their column's,
	 *  so a slot that only moved changes none. */
	readonly mediaFiles: number;
	readonly menusReordered: boolean;
	readonly menus: readonly MenuChange[];
	readonly forms: readonly FormChange[];
	/** The number of lines `documentChangeLines` gives for this value. */
	readonly count: number;
}

/**
 * The part each key of a menu is listed under. `null` only for the menu's
 * own `uuid`, which names the entity and never differs within it. A held
 * kind is a setting: a hold a server recorded is already in both documents
 * where it is no change, and one a change moved has its line.
 */
export const MENU_KEY_PARTS = {
	autoSelectSingle: "case-list",
	entryPoint: "settings",
	caseListEntryPoint: "case-list",
	uuid: null,
	id: "settings",
	name: "name",
	formsFromMenu: "settings",
	parentModuleUuid: "settings",
	parentCaseModuleUuid: "case-list",
	caseType: "settings",
	caseListMenuItem: "case-list",
	caseListRegistrationForm: "case-list",
	purpose: "note",
	displayCondition: "settings",
	badge: "settings",
	hiddenFromMenu: "settings",
	formsInMenuAbove: "settings",
	menuLayout: "settings",
	caseListConfig: "case-list",
	caseSearchConfig: "search",
	icon: "settings",
	audioLabel: "settings",
	mediaByLanguage: "settings",
	mediaByFormerCode: "settings",
	heldKind: "settings",
} as const satisfies Record<keyof Module, MenuPart | null>;

/**
 * The part each key of a menu's case list is listed under. A column is the
 * case list's, its case details' or both, by where it shows (see
 * `columnParts`).
 */
export const CASE_LIST_KEY_PARTS = {
	calculatedSorts: "case-list",
	columns: "case-list",
	listColumnOrder: "case-list",
	detailColumnOrder: "case-details",
	detailTabs: "case-details",
	detailTile: "case-details",
	contextAboveForm: "case-details",
	filter: "case-list",
	searchInputs: "search",
	searchFilters: "search",
	searchCondition: "search",
	selection: "case-list",
	emptyText: "case-list",
	selectButtonText: "case-list",
	optimizations: "case-list",
	tile: "case-list",
} as const satisfies Record<keyof CaseListConfig, MenuPart>;

/**
 * The part each key of a form is listed under. `null` only for the form's
 * own `uuid`. Its type, its conditions, its case changes and the held place
 * of its own close and of its opening records are what it saves to cases.
 */
export const FORM_KEY_PARTS = {
	heldSelectionTags: "case-changes",
	shadowOf: "case-changes",
	caseSelections: "case-changes",
	openingAssignments: "case-changes",
	heldBasicOpening: "case-changes",
	computedDatums: "settings",
	submitLabel: "settings",
	entryPoint: "settings",
	entryCaseCreations: "settings",
	uuid: null,
	id: "settings",
	name: "name",
	type: "case-changes",
	purpose: "note",
	displayCondition: "settings",
	badge: "settings",
	hiddenFromMenu: "settings",
	captureLocation: "settings",
	plainText: "settings",
	openCondition: "case-changes",
	closeCondition: "case-changes",
	ownClosePlacement: "case-changes",
	postSubmit: "after-submit",
	formLinks: "after-submit",
	otherwise: "after-submit",
	caseOperations: "case-changes",
	icon: "settings",
	audioLabel: "settings",
	mediaByLanguage: "settings",
	mediaByFormerCode: "settings",
	dataRootName: "settings",
	automaticSubmissionText: "settings",
	skipAutomaticSyncText: "settings",
	validateChangedAnswersText: "settings",
	activityKeyText: "settings",
	activityTitleText: "settings",
	activityWindowText: "settings",
} as const satisfies Record<keyof Form, FormPart | null>;

/** Where a key of the document's root is filed: an app part, or one of the walks below. */
type RootPlace =
	| AppPart
	| "menus"
	| "menu-order"
	| "forms"
	| "form-order"
	| "questions"
	| "question-order"
	| "localization";

/**
 * Where each key of the document's root is filed. `appId` names the app and
 * never differs between two documents of one app; it is a setting where it
 * does.
 */
export const ROOT_KEY_PLACES = {
	appId: "settings",
	appName: "name",
	connectRoles: "settings",
	caseTypes: "case-types",
	localization: "localization",
	appSettings: "settings",
	modules: "menus",
	forms: "forms",
	fields: "questions",
	moduleOrder: "menu-order",
	formOrder: "form-order",
	fieldOrder: "question-order",
	logo: "logo",
	userProperties: "worker-properties",
	userPropertyOrder: "worker-properties",
	userTypes: "roles",
	userTypeOrder: "roles",
	personas: "personas",
	personaOrder: "personas",
	organizationLevels: "organization",
	organizationLevelOrder: "organization",
	locationProperties: "organization",
	locationPropertyOrder: "organization",
	automations: "automations",
	automationOrder: "automations",
} as const satisfies Record<keyof PersistableDoc, RootPlace>;

// ── Indexes over one document ────────────────────────────────────────

interface DocIndex {
	readonly doc: BlueprintDoc;
	/** Each field's parent: a form or a container field. */
	readonly parentOf: ReadonlyMap<string, string>;
	/** Each form's menu. */
	readonly menuOfForm: ReadonlyMap<string, string>;
}

function indexOf(doc: BlueprintDoc): DocIndex {
	const parentOf = new Map<string, string>();
	for (const [parent, children] of Object.entries(doc.fieldOrder)) {
		for (const child of children) parentOf.set(child, parent);
	}
	const menuOfForm = new Map<string, string>();
	for (const [menu, forms] of Object.entries(doc.formOrder)) {
		for (const form of forms) menuOfForm.set(form, menu);
	}
	return { doc, parentOf, menuOfForm };
}

function holds(record: object, key: string): boolean {
	return Object.hasOwn(record, key);
}

/** The form a field lies in, through its parents. */
function formOfField(index: DocIndex, field: string): string | undefined {
	let at = index.parentOf.get(field);
	const seen = new Set<string>();
	while (at !== undefined && !seen.has(at)) {
		if (holds(index.doc.forms, at)) return at;
		seen.add(at);
		at = index.parentOf.get(at);
	}
	return undefined;
}

/** A question's id, with the ids of the containers above it joined by "/". */
function questionName(index: DocIndex, field: string): string {
	const ids: string[] = [];
	let at: string | undefined = field;
	const seen = new Set<string>();
	while (at !== undefined && holds(index.doc.fields, at) && !seen.has(at)) {
		seen.add(at);
		ids.unshift(index.doc.fields[at as Uuid].id);
		at = index.parentOf.get(at);
	}
	return ids.join("/");
}

/** Every field of a form in preorder, the form's order. */
function formFieldOrder(doc: BlueprintDoc, form: string): string[] {
	const out: string[] = [];
	const visit = (parent: string): void => {
		for (const child of doc.fieldOrder[parent as Uuid] ?? []) {
			out.push(child);
			visit(child);
		}
	};
	visit(form);
	return out;
}

/** The slot path of each media reference `walkAssetRefs` visits. */
function mediaSlotPath(doc: BlueprintDoc, ref: AssetRef): readonly string[] {
	const location = ref.location;
	const language =
		location.language === undefined
			? []
			: [
					location.formerLanguage ? "mediaByFormerCode" : "mediaByLanguage",
					location.language,
				];
	switch (location.kind) {
		case "app_logo":
			return ["logo"];
		case "module_icon":
			return ["modules", location.moduleUuid, ...language, "icon"];
		case "module_audio_label":
			return ["modules", location.moduleUuid, ...language, "audioLabel"];
		case "case_list_icon":
			return [
				"modules",
				location.moduleUuid,
				"caseListMenuItem",
				...language,
				"icon",
			];
		case "case_list_audio_label":
			return [
				"modules",
				location.moduleUuid,
				"caseListMenuItem",
				...language,
				"audioLabel",
			];
		case "case_list_registration_icon":
			return [
				"modules",
				location.moduleUuid,
				"caseListRegistrationForm",
				...language,
				"icon",
			];
		case "case_list_registration_audio_label":
			return [
				"modules",
				location.moduleUuid,
				"caseListRegistrationForm",
				...language,
				"audioLabel",
			];
		case "form_icon":
			return ["forms", location.formUuid, ...language, "icon"];
		case "form_audio_label":
			return ["forms", location.formUuid, ...language, "audioLabel"];
		case "field_media_bundle":
			return [
				"fields",
				location.fieldUuid,
				location.bundleKey,
				...language,
				ref.role ?? ref.slotKind,
			];
		case "option_media": {
			const field = doc.fields[location.fieldUuid];
			const options =
				(field.kind === "single_select" || field.kind === "multi_select") &&
				field.optionsSource.kind === "inline"
					? field.optionsSource.options
					: [];
			const at = options.findIndex(
				(option) => option.uuid === location.optionUuid,
			);
			return [
				"fields",
				location.fieldUuid,
				"optionsSource",
				"options",
				String(at),
				"media",
				...language,
				ref.role ?? ref.slotKind,
			];
		}
		case "image_map_mapping": {
			const columns =
				doc.modules[location.moduleUuid].caseListConfig?.columns ?? [];
			const at = columns.findIndex(
				(column) => column.uuid === location.columnUuid,
			);
			return [
				"modules",
				location.moduleUuid,
				"caseListConfig",
				"columns",
				String(at),
				"mapping",
				String(location.rowIndex),
				"assetId",
			];
		}
		default: {
			const unplaced: never = location;
			return unplaced;
		}
	}
}

const SEP = "\u0000";

function keyOf(path: readonly string[]): string {
	return path.join(SEP);
}

/**
 * What a media slot is, whatever position it holds: a choice's slot by the
 * choice's uuid, and an image map's rows together, by the column's uuid,
 * since a row has no identity of its own. Every other slot's path already
 * names its owner by uuid.
 */
function mediaSlotIdentity(
	path: readonly string[],
	ref: AssetRef,
): readonly string[] {
	const location = ref.location;
	if (location.kind === "option_media")
		return [
			"option",
			location.optionUuid,
			...(location.language ? [location.language] : []),
			ref.role ?? ref.slotKind,
		];
	if (location.kind === "image_map_mapping")
		return ["image-map", location.columnUuid];
	return path;
}

/** The media slots of two documents: each slot under every slot path above
 *  it, and the files each slot holds on each side. */
interface MediaSlots {
	readonly byPrefix: ReadonlyMap<string, ReadonlySet<string>>;
	readonly files: ReadonlyMap<string, MediaSlotFiles>;
}

/** The files one media slot holds before and after. */
type MediaSlotFiles = readonly [readonly string[], readonly string[]];

function mediaSlotsOf(before: BlueprintDoc, after: BlueprintDoc): MediaSlots {
	const byPrefix = new Map<string, Set<string>>();
	const files = new Map<string, [string[], string[]]>();
	for (const [side, doc] of [before, after].entries()) {
		for (const ref of walkAssetRefs(doc)) {
			const path = mediaSlotPath(doc, ref);
			const slot = keyOf(mediaSlotIdentity(path, ref));
			let held = files.get(slot);
			if (held === undefined) {
				held = [[], []];
				files.set(slot, held);
			}
			held[side].push(ref.assetId);
			for (let length = 1; length <= path.length; length++) {
				const prefix = keyOf(path.slice(0, length));
				let slots = byPrefix.get(prefix);
				if (slots === undefined) {
					slots = new Set();
					byPrefix.set(prefix, slots);
				}
				slots.add(slot);
			}
		}
	}
	return { byPrefix, files };
}

/**
 * The files a slot changed: one where a slot holds another file or none, and
 * for an image map's rows, the files one side holds that the other does not,
 * the larger of the two counts, so a row moved or its value reworded
 * changes no picture.
 */
function changedFiles(held: MediaSlotFiles | undefined): number {
	if (held === undefined) return 0;
	const [was, now] = held;
	const remaining = new Map<string, number>();
	for (const file of was) remaining.set(file, (remaining.get(file) ?? 0) + 1);
	let added = 0;
	for (const file of now) {
		const left = remaining.get(file) ?? 0;
		if (left > 0) remaining.set(file, left - 1);
		else added++;
	}
	let removed = 0;
	for (const left of remaining.values()) removed += left;
	return Math.max(added, removed);
}

/** Whether a path names a whole menu, form or question. */
function isEntityPath(path: readonly string[]): boolean {
	return (
		path.length === 2 &&
		(path[0] === "modules" || path[0] === "forms" || path[0] === "fields")
	);
}

/**
 * The items of `after` outside the longest run both sequences keep in
 * order: the fewest items to move to turn one order into the other. The two
 * sequences hold the same distinct items, so the run is the longest
 * increasing run of each item's position in `before`, taken in
 * O(n log n).
 */
function movedItems(
	before: readonly string[],
	after: readonly string[],
): Set<string> {
	const position = new Map(before.map((item, i) => [item, i]));
	// `tails[k]`: the index into `after` of the smallest position ending a run of k + 1.
	const tails: number[] = [];
	const previous = new Array<number>(after.length).fill(-1);
	for (const [j, item] of after.entries()) {
		const at = position.get(item);
		if (at === undefined) continue;
		let low = 0;
		let high = tails.length;
		while (low < high) {
			const middle = (low + high) >> 1;
			if ((position.get(after[tails[middle]]) ?? 0) < at) low = middle + 1;
			else high = middle;
		}
		previous[j] = low > 0 ? tails[low - 1] : -1;
		tails[low] = j;
	}
	const kept = new Set<string>();
	for (
		let j = tails.length > 0 ? tails[tails.length - 1] : -1;
		j >= 0;
		j = previous[j]
	)
		kept.add(after[j]);
	return new Set(after.filter((item) => !kept.has(item)));
}

function sameSequence(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((item, i) => item === b[i]);
}

// ── The walk ─────────────────────────────────────────────────────────

type QuestionState = "added" | "removed" | "changed" | "moved";
const QUESTION_RANK: Readonly<Record<QuestionState, number>> = {
	added: 3,
	removed: 3,
	changed: 2,
	moved: 1,
};

type EntityState = "added" | "removed" | "changed";
interface MenuEntry {
	state: EntityState;
	readonly parts: Set<MenuPart>;
	reordered: boolean;
}
interface FormEntry {
	state: EntityState;
	readonly parts: Set<FormPart>;
}

interface Collector {
	readonly app: Set<AppPart>;
	readonly menus: Map<string, MenuEntry>;
	readonly forms: Map<string, FormEntry>;
	readonly questions: Map<string, QuestionState>;
	readonly translations: Map<string, "text" | "review">;
	/** Each media slot under a difference, with the files it holds on each side. */
	readonly media: Map<string, MediaSlotFiles | undefined>;
	menusReordered: boolean;
}

function noteMenu(
	collector: Collector,
	menu: string,
	state: EntityState,
): MenuEntry {
	let entry = collector.menus.get(menu);
	if (entry === undefined) {
		entry = { state, parts: new Set(), reordered: false };
		collector.menus.set(menu, entry);
	} else if (state !== "changed") entry.state = state;
	return entry;
}

function noteForm(
	collector: Collector,
	form: string,
	state: EntityState,
): FormEntry {
	let entry = collector.forms.get(form);
	if (entry === undefined) {
		entry = { state, parts: new Set() };
		collector.forms.set(form, entry);
	} else if (state !== "changed") entry.state = state;
	return entry;
}

function noteQuestion(
	collector: Collector,
	field: string,
	state: QuestionState,
): void {
	const held = collector.questions.get(field);
	if (held === undefined || QUESTION_RANK[state] > QUESTION_RANK[held]) {
		collector.questions.set(field, state);
	}
}

/** Where a column shows: the case list, its case details, or both. */
function columnParts(column: Column): MenuPart[] {
	const parts: MenuPart[] = [];
	if (columnOnList(column) && column.visibleInList !== false)
		parts.push("case-list");
	if (column.visibleInDetail !== false) parts.push("case-details");
	return parts;
}

function fileMenuDifference(
	collector: Collector,
	before: DocIndex,
	after: DocIndex,
	path: readonly string[],
): void {
	const menu = path[1];
	const inBefore = holds(before.doc.modules, menu);
	const inAfter = holds(after.doc.modules, menu);
	if (!inBefore || !inAfter) {
		noteMenu(collector, menu, inAfter ? "added" : "removed");
		return;
	}
	const entry = noteMenu(collector, menu, "changed");
	const key = path[2] as keyof Module | undefined;
	if (key === undefined) {
		entry.parts.add("settings");
		return;
	}
	if (key !== "caseListConfig") {
		entry.parts.add(MENU_KEY_PARTS[key] ?? "settings");
		return;
	}
	if (path.length === 3) {
		entry.parts.add("case-list");
		return;
	}
	const listKey = path[3] as keyof CaseListConfig;
	if (listKey !== "columns" || path.length === 4) {
		entry.parts.add(CASE_LIST_KEY_PARTS[listKey] ?? "case-list");
		return;
	}
	const at = Number(path[4]);
	const sides = [
		before.doc.modules[menu as Uuid].caseListConfig?.columns[at],
		after.doc.modules[menu as Uuid].caseListConfig?.columns[at],
	];
	const parts = new Set<MenuPart>();
	const slot = path[5];
	if (slot === "visibleInDetail") parts.add("case-details");
	else if (
		slot === "visibleInList" ||
		slot === "notOnList" ||
		slot === "sort" ||
		slot === "tile"
	)
		parts.add("case-list");
	else
		for (const column of sides)
			if (column !== undefined)
				for (const part of columnParts(column)) parts.add(part);
	if (parts.size === 0) parts.add("case-list");
	for (const part of parts) entry.parts.add(part);
}

function fileFormDifference(
	collector: Collector,
	before: DocIndex,
	after: DocIndex,
	path: readonly string[],
): void {
	const form = path[1];
	const inBefore = holds(before.doc.forms, form);
	const inAfter = holds(after.doc.forms, form);
	if (!inBefore || !inAfter) {
		noteForm(collector, form, inAfter ? "added" : "removed");
		return;
	}
	const key = path[2] as keyof Form | undefined;
	const part =
		key === undefined ? "settings" : (FORM_KEY_PARTS[key] ?? "settings");
	noteForm(collector, form, "changed").parts.add(part);
}

function fileQuestionDifference(
	collector: Collector,
	before: DocIndex,
	after: DocIndex,
	path: readonly string[],
): void {
	const field = path[1];
	const inBefore = holds(before.doc.fields, field);
	const inAfter = holds(after.doc.fields, field);
	noteQuestion(
		collector,
		field,
		inAfter ? (inBefore ? "changed" : "added") : "removed",
	);
}

/** Whether a field stands under the same parent in both documents. */
function sameParent(before: DocIndex, after: DocIndex, field: string): boolean {
	return before.parentOf.get(field) === after.parentOf.get(field);
}

/*
 * An ordering array is compared by the order it gives the members both
 * sides hold, once per array however many of its positions differ: a member
 * one side lacks is a change of that member's own, and the shift of every
 * position after it moves nothing.
 */

/** The differences of one parent's questions: who joined, who left, who moved. */
function fileQuestionOrder(
	collector: Collector,
	before: DocIndex,
	after: DocIndex,
	parent: string,
): void {
	const was = before.doc.fieldOrder[parent as Uuid] ?? [];
	const now = after.doc.fieldOrder[parent as Uuid] ?? [];
	let filed = false;
	for (const field of new Set([...was, ...now])) {
		if (!holds(after.doc.fields, field)) {
			noteQuestion(collector, field, "removed");
			filed = true;
		} else if (!holds(before.doc.fields, field)) {
			noteQuestion(collector, field, "added");
			filed = true;
		} else if (!sameParent(before, after, field)) {
			noteQuestion(collector, field, "moved");
			filed = true;
		}
	}
	const kept = (field: string): boolean =>
		holds(before.doc.fields, field) &&
		holds(after.doc.fields, field) &&
		sameParent(before, after, field);
	for (const field of movedItems(was.filter(kept), now.filter(kept))) {
		noteQuestion(collector, field, "moved");
		filed = true;
	}
	if (filed) return;
	// The two arrays hold the same questions in the same order, so the
	// difference is the parent's entry itself (an empty list one side lacks).
	if (holds(after.doc.fields, parent) || holds(before.doc.fields, parent))
		noteQuestion(collector, parent, "changed");
	else if (holds(after.doc.forms, parent) || holds(before.doc.forms, parent))
		noteForm(
			collector,
			parent,
			holds(after.doc.forms, parent)
				? holds(before.doc.forms, parent)
					? "changed"
					: "added"
				: "removed",
		).parts.add("settings");
	else collector.app.add("settings");
}

/**
 * The differences of one menu's forms: a form added or removed, a form that
 * came from or went to another menu (its own `menu` part), and the order of
 * the forms both lists hold.
 */
function fileFormOrder(
	collector: Collector,
	before: DocIndex,
	after: DocIndex,
	menu: string,
): void {
	const inBefore = holds(before.doc.modules, menu);
	const inAfter = holds(after.doc.modules, menu);
	if (!inBefore || !inAfter) {
		noteMenu(collector, menu, inAfter ? "added" : "removed");
		return;
	}
	const was = before.doc.formOrder[menu as Uuid] ?? [];
	const now = after.doc.formOrder[menu as Uuid] ?? [];
	let filed = false;
	for (const form of new Set([...was, ...now])) {
		if (!holds(after.doc.forms, form)) {
			noteForm(collector, form, "removed");
			filed = true;
		} else if (!holds(before.doc.forms, form)) {
			noteForm(collector, form, "added");
			filed = true;
		} else if (before.menuOfForm.get(form) !== after.menuOfForm.get(form)) {
			noteForm(collector, form, "changed").parts.add("menu");
			filed = true;
		}
	}
	const inWas = new Set(was);
	const inNow = new Set(now);
	if (
		!sameSequence(
			was.filter((form) => inNow.has(form)),
			now.filter((form) => inWas.has(form)),
		)
	)
		noteMenu(collector, menu, "changed").reordered = true;
	// The two lists hold the same forms in the same order, so the difference
	// is the menu's entry itself (an empty list one side lacks).
	else if (!filed) noteMenu(collector, menu, "changed").parts.add("settings");
}

/**
 * The differences of the menus' order: a menu added or removed, and the
 * order of the menus both documents hold that kept their parent. A menu
 * placed under another parent is its own settings change.
 */
function fileMenuOrder(
	collector: Collector,
	before: DocIndex,
	after: DocIndex,
): void {
	const was = before.doc.moduleOrder;
	const now = after.doc.moduleOrder;
	let filed = false;
	for (const menu of new Set([...was, ...now])) {
		if (!holds(after.doc.modules, menu)) {
			noteMenu(collector, menu, "removed");
			filed = true;
		} else if (!holds(before.doc.modules, menu)) {
			noteMenu(collector, menu, "added");
			filed = true;
		} else if (
			before.doc.modules[menu as Uuid].parentModuleUuid !==
			after.doc.modules[menu as Uuid].parentModuleUuid
		) {
			noteMenu(collector, menu, "changed").parts.add("settings");
			filed = true;
		}
	}
	const stayed = (menu: string): boolean =>
		holds(before.doc.modules, menu) &&
		holds(after.doc.modules, menu) &&
		before.doc.modules[menu as Uuid].parentModuleUuid ===
			after.doc.modules[menu as Uuid].parentModuleUuid;
	if (!sameSequence(was.filter(stayed), now.filter(stayed)) || !filed)
		collector.menusReordered = true;
}

function translationEntries(
	doc: BlueprintDoc,
	language: string,
): readonly string[] {
	const map = languageEntries(doc.localization, language);
	return map === undefined ? [] : Object.keys(map);
}

function fileLocalizationDifference(
	collector: Collector,
	before: DocIndex,
	after: DocIndex,
	path: readonly string[],
): void {
	const noteUnit = (
		language: string,
		unit: string,
		kind: "text" | "review",
	) => {
		const key = keyOf([language, unit]);
		if (collector.translations.get(key) !== "text")
			collector.translations.set(key, kind);
	};
	if (path.length === 1) {
		// The root appears or goes with its first or last stored wording; the languages change
		// only where the effective catalog does.
		const languagesOf = (doc: BlueprintDoc) => {
			const {
				translations: _translations,
				generatedSourceWording: _wording,
				...languages
			} = effectiveAppLocalization(doc.localization);
			return languages;
		};
		if (!deepEqual(languagesOf(before.doc), languagesOf(after.doc)))
			collector.app.add("languages");
		for (const doc of [before.doc, after.doc]) {
			for (const language of doc.localization?.languageOrder ?? [])
				for (const unit of translationEntries(doc, language))
					noteUnit(language, unit, "text");
		}
		return;
	}
	if (path[1] === "generatedSourceWording") {
		for (const { doc } of [before, after]) {
			const loc = doc.localization;
			if (!loc) continue;
			for (const unit of path[2]
				? [path[2]]
				: Object.keys(loc.generatedSourceWording ?? {}))
				noteUnit(
					loc.sourceLanguage,
					unit,
					path.length <= 3 || path[3] === "value" ? "text" : "review",
				);
		}
		return;
	}
	if (path[1] !== "translations" || path.length === 2) {
		collector.app.add("languages");
		return;
	}
	const language = path[2];
	if (path.length === 3) {
		const units = [
			...translationEntries(before.doc, language),
			...translationEntries(after.doc, language),
		];
		if (units.length === 0) collector.app.add("languages");
		for (const unit of units) noteUnit(language, unit, "text");
		return;
	}
	noteUnit(
		language,
		path[3],
		path.length === 4 || path[4] === "value" ? "text" : "review",
	);
}

/**
 * What changed from `before` to `after`, by place. `differences` defaults to
 * every difference of the two; given, only those are filed, each under the
 * entity it lies in.
 */
export function documentChanges(
	before: BlueprintDoc,
	after: BlueprintDoc,
	/** The differences to word. Default: every difference of the two. */
	differences?: readonly DocumentDifference[],
): DocumentChanges {
	const given = differences ?? documentDifferences(before, after);
	const was = indexOf(before);
	const now = indexOf(after);
	const collector: Collector = {
		app: new Set(),
		menus: new Map(),
		forms: new Map(),
		questions: new Map(),
		translations: new Map(),
		media: new Map(),
		menusReordered: false,
	};
	const mediaSlots: MediaSlots =
		given.length === 0
			? { byPrefix: new Map(), files: new Map() }
			: mediaSlotsOf(before, after);
	// Each ordering array a difference lies in, compared once after the walk.
	const questionParents = new Set<string>();
	const formMenus = new Set<string>();
	let menuOrderDiffers = false;
	/** The keys whose lists differ, where a whole ordering record differs. */
	const differingKeys = (
		pick: (doc: BlueprintDoc) => Readonly<Record<string, readonly string[]>>,
	): string[] => {
		const was = pick(before);
		const now = pick(after);
		return [...new Set([...Object.keys(was), ...Object.keys(now)])].filter(
			(key) =>
				holds(was, key) !== holds(now, key) ||
				!sameSequence(was[key] ?? [], now[key] ?? []),
		);
	};

	for (const { path } of given) {
		if (path.length === 0) {
			collector.app.add("settings");
			continue;
		}
		if (!isEntityPath(path)) {
			for (const slot of mediaSlots.byPrefix.get(keyOf(path)) ?? [])
				collector.media.set(slot, mediaSlots.files.get(slot));
		}
		const place: RootPlace =
			ROOT_KEY_PLACES[path[0] as keyof PersistableDoc] ?? "settings";
		switch (place) {
			case "menus":
				fileMenuDifference(collector, was, now, path);
				break;
			case "forms":
				fileFormDifference(collector, was, now, path);
				break;
			case "questions":
				fileQuestionDifference(collector, was, now, path);
				break;
			case "menu-order":
				menuOrderDiffers = true;
				break;
			case "form-order":
				for (const menu of path.length === 1
					? differingKeys((doc) => doc.formOrder)
					: [path[1]])
					formMenus.add(menu);
				break;
			case "question-order":
				for (const parent of path.length === 1
					? differingKeys((doc) => doc.fieldOrder)
					: [path[1]])
					questionParents.add(parent);
				break;
			case "localization":
				fileLocalizationDifference(collector, was, now, path);
				break;
			default:
				collector.app.add(place);
		}
	}
	if (menuOrderDiffers) fileMenuOrder(collector, was, now);
	for (const menu of formMenus) fileFormOrder(collector, was, now, menu);
	for (const parent of questionParents)
		fileQuestionOrder(collector, was, now, parent);

	// Each question is filed under its form, which changed with it.
	const questionsOfForm = new Map<string, Map<QuestionState, string[]>>();
	for (const [field, state] of collector.questions) {
		const form =
			state === "removed"
				? formOfField(was, field)
				: (formOfField(now, field) ?? formOfField(was, field));
		if (form === undefined) continue;
		noteForm(
			collector,
			form,
			holds(before.forms, form)
				? holds(after.forms, form)
					? "changed"
					: "removed"
				: "added",
		);
		let byState = questionsOfForm.get(form);
		if (byState === undefined) {
			byState = new Map();
			questionsOfForm.set(form, byState);
		}
		const list = byState.get(state) ?? [];
		list.push(field);
		byState.set(state, list);
	}

	return assemble(collector, was, now, questionsOfForm);
}

function assemble(
	collector: Collector,
	was: DocIndex,
	now: DocIndex,
	questionsOfForm: ReadonlyMap<string, ReadonlyMap<QuestionState, string[]>>,
): DocumentChanges {
	const before = was.doc;
	const after = now.doc;

	const menuRank = new Map<string, number>();
	for (const [i, menu] of after.moduleOrder.entries()) menuRank.set(menu, i);
	for (const [i, menu] of before.moduleOrder.entries())
		if (!menuRank.has(menu)) menuRank.set(menu, after.moduleOrder.length + i);
	const rank = (map: ReadonlyMap<string, number>, key: string): number =>
		map.get(key) ?? Number.MAX_SAFE_INTEGER;

	const menus: MenuChange[] = [...collector.menus]
		.filter(
			([, entry]) =>
				entry.state !== "changed" || entry.parts.size > 0 || entry.reordered,
		)
		.sort(([a], [b]) => rank(menuRank, a) - rank(menuRank, b))
		.map(([uuid, entry]) => {
			const named = holds(after.modules, uuid) ? after : before;
			const changed = entry.state === "changed";
			return {
				uuid: uuid as Uuid,
				name: named.modules[uuid as Uuid].name,
				state: entry.state,
				parts: changed
					? MENU_PARTS.filter((part) => entry.parts.has(part))
					: [],
				formsReordered: changed && entry.reordered,
			};
		});

	const formRank = new Map<string, number>();
	let next = 0;
	for (const menu of after.moduleOrder)
		for (const form of after.formOrder[menu] ?? []) formRank.set(form, next++);
	for (const menu of before.moduleOrder)
		for (const form of before.formOrder[menu] ?? [])
			if (!formRank.has(form)) formRank.set(form, next++);

	const forms: FormChange[] = [...collector.forms]
		.sort(([a], [b]) => rank(formRank, a) - rank(formRank, b))
		.map(([uuid, entry]) => {
			const side = holds(after.forms, uuid) ? now : was;
			const menu = side.menuOfForm.get(uuid);
			const changed = entry.state === "changed";
			const byState = questionsOfForm.get(uuid);
			const ordered = (state: QuestionState): QuestionRef[] => {
				if (!changed) return [];
				const fields = byState?.get(state) ?? [];
				if (fields.length === 0) return [];
				const from = state === "removed" ? was : now;
				const order = formFieldOrder(from.doc, uuid);
				const position = new Map(order.map((field, i) => [field, i]));
				return [...fields]
					.sort(
						(a, b) =>
							(position.get(a) ?? Number.MAX_SAFE_INTEGER) -
							(position.get(b) ?? Number.MAX_SAFE_INTEGER),
					)
					.map((field) => ({
						uuid: field as Uuid,
						name: questionName(from, field),
					}));
			};
			return {
				uuid: uuid as Uuid,
				name: side.doc.forms[uuid as Uuid].name,
				menuName:
					menu === undefined || !holds(side.doc.modules, menu)
						? ""
						: side.doc.modules[menu as Uuid].name,
				state: entry.state,
				parts: changed
					? FORM_PARTS.filter((part) => entry.parts.has(part))
					: [],
				questions: {
					added: ordered("added"),
					removed: ordered("removed"),
					changed: ordered("changed"),
					moved: ordered("moved"),
				},
			};
		});

	const app = APP_PARTS.filter((part) => collector.app.has(part));
	let text = 0;
	let review = 0;
	for (const kind of collector.translations.values()) {
		if (kind === "text") text++;
		else review++;
	}
	let mediaFiles = 0;
	for (const files of collector.media.values())
		mediaFiles += changedFiles(files);

	const count =
		app.length +
		(collector.menusReordered ? 1 : 0) +
		menus.reduce(
			(sum, menu) =>
				sum +
				(menu.state === "changed"
					? (menu.parts.length > 0 ? 1 : 0) + (menu.formsReordered ? 1 : 0)
					: 1),
			0,
		) +
		forms.length +
		(text > 0 ? 1 : 0) +
		(review > 0 ? 1 : 0) +
		(mediaFiles > 0 ? 1 : 0);

	return {
		app,
		translations: { text, review },
		mediaFiles,
		menusReordered: collector.menusReordered,
		menus,
		forms,
		count,
	};
}
