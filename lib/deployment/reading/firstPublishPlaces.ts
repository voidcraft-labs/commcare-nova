/**
 * Where a first-publish change stands: the vocabulary of the places each
 * entry of the register (`firstPublishChanges.ts::FIRST_PUBLISH_CHANGES`)
 * names on one reading, and the projections every entry builds its places
 * with from what the reading records.
 *
 * A place is a JSON Pointer over one tree that holds every part of CommCare
 * HQ's stored app by its position:
 *
 * - `/app/<key>...`: a key of the application itself (`/app/cloudcare_enabled`,
 *   `/app/multimedia_map/<path>`, `/app/translations/<code>/<key>`), `/app`
 *   alone every key of it but its menus;
 * - `/menu/<m>/<key>...`: a key of the `m`-th menu, HQ's module, but its forms
 *   (`/menu/1/case_details/short/sort_elements`);
 * - `/form/<m>.<f>/<key>...`: a key of the `f`-th form of the `m`-th menu
 *   (`/form/0.1/actions`, `/form/0.1/form_filter`), and under
 *   `/form/<m>.<f>/xform` its XForm: `xform/data/...` a node of its data by its
 *   path, `xform/title` its `<h:title>`, and `xform/**` followed by a part
 *   (`:itext`, `:control`, `:setvalue`, `case/update/<property>`) every such
 *   part under any node of the form;
 * - `/case/<type>/<property>...`: a case type's property, as the cases a form
 *   writes hold it, a property read through a relation by its relation's steps
 *   (`/case/member/parent/external_id`);
 * - the empty pointer, the whole app: the place of the one change declared
 *   app-wide (`forms-and-settings-rewritten`), which keeps what no other
 *   change's place holds.
 *
 * `**` in a place stands for any run of steps. The proof lane's judge meets a
 * difference with a place where the difference's own location lies at or
 * under it (`proof/checks/changes.py`), and credits the change whose place
 * there is the most exact.
 *
 * Pure: every projection reads only its arguments.
 */

import {
	generatedAppStringPattern,
	generatedAppStringPatternSpells,
} from "@/lib/commcare/appStringKeys";
import type { HqAppSource } from "@/lib/commcare/hq/appSource";
import { generatedKeyOwner } from "@/lib/commcare/reader/generatedTranslationKeys";
import { type SourceTable, tableOf } from "@/lib/commcare/sourceKeys";
import type { HqPlace } from "@/lib/publish/hqFindings";

/** Every kind of place, by the tree's first step and, in a form, by its XForm part. */
export const FIRST_PUBLISH_PLACE_KINDS = [
	/** The empty pointer: the whole app. */
	"app-wide",
	/** `/app/...`. */
	"app",
	/** `/menu/<m>/...`. */
	"menu",
	/** `/form/<m>.<f>/...` outside its XForm. */
	"form",
	/** `/form/<m>.<f>/xform/data/...`: a node of the form's data. */
	"form-node",
	/** `/form/<m>.<f>/xform/...` other than a data node: its title, or a part under any node. */
	"form-part",
	/** `/case/<type>/...`. */
	"case",
] as const;
export type FirstPublishPlaceKind = (typeof FIRST_PUBLISH_PLACE_KINDS)[number];

/** A place's steps, each a JSON Pointer token unescaped; none for the whole app. */
export function placeSteps(place: string): readonly string[] {
	if (place === "") return [];
	if (!place.startsWith("/"))
		throw new Error(
			`The first-publish place ${JSON.stringify(place)} is no JSON Pointer: a place starts with /, or is empty for the whole app.`,
		);
	return place
		.slice(1)
		.split("/")
		.map((step) => step.replaceAll("~1", "/").replaceAll("~0", "~"));
}

/** The place whose steps are `steps`, each escaped as a JSON Pointer token. */
export function placeOf(...steps: readonly (string | number)[]): string {
	return steps
		.map(
			(step) => `/${String(step).replaceAll("~", "~0").replaceAll("/", "~1")}`,
		)
		.join("");
}

/** The kind of `place`, or null where it is none the vocabulary holds. */
export function firstPublishPlaceKind(
	place: string,
): FirstPublishPlaceKind | null {
	const steps = placeSteps(place);
	if (steps.length === 0) return "app-wide";
	const [root, at, part, first] = steps;
	switch (root) {
		case "app":
			return "app";
		case "menu":
			return at !== undefined && /^[0-9]+$/.test(at) ? "menu" : null;
		case "case":
			return at !== undefined ? "case" : null;
		case "form":
			if (at === undefined || !/^[0-9]+\.[0-9]+$/.test(at)) return null;
			if (part !== "xform") return "form";
			return first === "data" ? "form-node" : "form-part";
		default:
			return null;
	}
}

/** The position token of a form, `<m>.<f>`, as the lane names a form (`form:<m>.<f>`). */
export type FormPosition = string;

/** Each form's position in `source` by its `xmlns` and by this read's id, the first of each. */
export interface FormPositions {
	readonly byXmlns: ReadonlyMap<string, FormPosition>;
	readonly byReadId: ReadonlyMap<string, FormPosition>;
	/** Every form's position, in menu and form order. */
	readonly all: readonly FormPosition[];
}

export function formPositionsOf(source: HqAppSource): FormPositions {
	const byXmlns = new Map<string, FormPosition>();
	const byReadId = new Map<string, FormPosition>();
	const all: FormPosition[] = [];
	source.modules.forEach((module, m) => {
		module.forms.forEach((form, f) => {
			const position = `${m}.${f}`;
			all.push(position);
			if (form.xmlns !== null && !byXmlns.has(form.xmlns))
				byXmlns.set(form.xmlns, position);
			if (!byReadId.has(form.readUniqueId))
				byReadId.set(form.readUniqueId, position);
		});
	});
	return { byXmlns, byReadId, all };
}

/** A question in the first-publish vocabulary, independent of the name of the
 * submission envelope. The reader proof compares the envelope name itself at
 * its own slot and uses `data` as the stable kind for a node. */
export function nodePlace(position: FormPosition, dataPath: string): string {
	return placeOf(
		"form",
		position,
		"xform",
		"data",
		...dataPath.split("/").slice(2),
	);
}

/** Every `part` under any node of the form at `position` (`:itext`, `:control`, `:setvalue`, `case`). */
export function partPlace(position: FormPosition, part: string): string {
	return `${placeOf("form", position, "xform")}/**${placeOf(part)}`;
}

const ATTACHMENT_SUFFIX = ".xml";

/**
 * The place of a JSON Pointer over CommCare HQ's stored app, as a reading
 * records a stored value Nova writes back another way
 * (`ReadFacts.sameStateRewrites`): a menu's or a form's key by its position, a
 * form's attachment, keyed by this read's id, as the form's XForm. Null where
 * the pointer names a form this read does not hold.
 */
export function placeOfStoredPointer(
	positions: FormPositions,
	pointer: string,
): string | null {
	const steps = placeSteps(pointer);
	const [root, at, ...rest] = steps;
	if (root === "_attachments" && at !== undefined) {
		const readId = at.endsWith(ATTACHMENT_SUFFIX)
			? at.slice(0, -ATTACHMENT_SUFFIX.length)
			: at;
		const position = positions.byReadId.get(readId);
		return position === undefined
			? null
			: placeOf("form", position, "xform", ...rest);
	}
	return placeOfAppSteps(steps);
}

/** The place of the steps of a key of CommCare HQ's stored app other than a form's attachment: a
 *  menu's or a form's key by its position, any other the application's own. */
function placeOfAppSteps(steps: readonly string[]): string {
	const [root, at, ...rest] = steps;
	if (root === "modules" && at !== undefined && /^[0-9]+$/.test(at)) {
		const [key, form, ...under] = rest;
		if (key === "forms" && form !== undefined && /^[0-9]+$/.test(form))
			return placeOf("form", `${at}.${form}`, ...under);
		return placeOf("menu", at, ...rest);
	}
	return placeOf("app", ...steps);
}

/** The data path of a question place: its path below the form's root (`HqPlace` "question"). */
function questionDataPath(path: string): string {
	return `/data/${path}`;
}

/** A slot the expression stage held up to a rewrite (`ReadFacts.rewrites`). */
export interface SlotAt {
	readonly place: HqPlace;
	readonly key: string;
	readonly pointer?: string;
}

/**
 * The place of a slot the expression stage held up to a rewrite: the value
 * of the app's JSON it was read from, by its pointer (a column's `field`, a
 * list's `filter`, a Search field's key, a form's `form_filter` or link), or
 * a question's node where a form's XForm holds it. A slot of a form's XForm
 * that names no question stands at that form's XForm.
 */
export function placesOfSlot(
	positions: FormPositions,
	slot: SlotAt,
): readonly string[] {
	if (slot.pointer !== undefined) {
		const place = placeOfStoredPointer(positions, slot.pointer);
		return place === null ? [] : [place];
	}
	const { place } = slot;
	switch (place.kind) {
		case "question":
			return [
				nodePlace(`${place.menu}.${place.form}`, questionDataPath(place.path)),
			];
		case "form":
			return [placeOf("form", `${place.menu}.${place.form}`, "xform")];
		default:
			throw new Error(
				`The expression stage reported a rewrite at a slot of the ${place.kind} under ${slot.key} with no pointer into the stored app. Every slot outside a form's XForm is read from a key of the app's JSON, whose pointer the reading carries (lib/commcare/reader/provisional.ts); look at how the slot was registered.`,
			);
	}
}

const JR_FILE = "jr://file/";

/** A media path as CommCare HQ's media map keys it, `jr://file/...`. */
export function mapPath(path: string): string {
	return path.startsWith(JR_FILE) ? path : `${JR_FILE}${path}`;
}

/** A media reference a reading recorded (`ReadFacts.mediaReferences`, `pendingMedia`). */
export interface MediaReferenceAt {
	readonly place: HqPlace;
	readonly path: string;
	readonly pointer?: string;
}

/**
 * The places a media reference stands at: its media map item; the value of
 * the app's JSON that names the path, by its pointer (a menu's or a form's
 * media map, a case list item's or Register button's, a case list column's
 * icon, a logo slot), or a question's node where a form's itext names it;
 * and where CommCare HQ's media listing names the path for a menu or a form
 * (`/menu/<m>/media/<path>`, `/form/<m>.<f>/media/<path>`): a menu's lists
 * every file of the menu, its case list item, its Register button and both
 * details' icon columns (`hqmedia/models.py::ModuleMediaMixin.all_media`).
 */
export function placesOfMediaReference(
	positions: FormPositions,
	reference: MediaReferenceAt,
): readonly string[] {
	const { place, path, pointer } = reference;
	const places = [placeOf("app", "multimedia_map", mapPath(path))];
	if (pointer !== undefined) {
		const at = placeOfStoredPointer(positions, pointer);
		if (at !== null) places.push(at);
	}
	switch (place.kind) {
		case "question": {
			const position = `${place.menu}.${place.form}`;
			places.push(
				nodePlace(position, questionDataPath(place.path)),
				placeOf("form", position, "media", mapPath(path)),
			);
			break;
		}
		case "form":
			places.push(
				placeOf("form", `${place.menu}.${place.form}`, "media", mapPath(path)),
			);
			break;
		case "menu":
		case "case-list":
		case "search":
		case "case-detail":
			places.push(placeOf("menu", place.menu, "media", mapPath(path)));
			break;
		default:
			break;
	}
	if (pointer === undefined && place.kind !== "question")
		throw new Error(
			`A reading recorded a media reference of the ${place.kind} with no pointer into the stored app. Every media reference outside a form's itext is read from a key of the app's JSON, whose pointer the reading carries (lib/commcare/reader/xform/media.ts::readMediaMap, appShell.ts::readLogos).`,
		);
	return places;
}

/** A step of a stored text's slot that the key spells: the menu's or the form's position, the
 *  detail's word, the column's position. */
interface KeyStep {
	readonly spelled: "menu" | "form" | "detail" | "column";
}

const MENU: KeyStep = { spelled: "menu" };
const FORM: KeyStep = { spelled: "form" };
const DETAIL: KeyStep = { spelled: "detail" };
const COLUMN: KeyStep = { spelled: "column" };

/** A step of a slot of CommCare HQ's stored app: a key, `*` for any position or language, or a
 *  step the key spells. */
type SlotStep = string | KeyStep;

/** The text one kind of generated key names in CommCare HQ's stored app. */
export interface FoldedTextSlots {
	/** HQ's id pattern (`appStringKeys.ts::GENERATED_APP_STRING_PATTERNS`), which the key is
	 *  spelled by whole (`generatedAppStringPatternSpells`). */
	readonly pattern: string;
	/** Each slot of the stored app that holds the text, as steps from the app's root. */
	readonly slots: readonly (readonly SlotStep[])[];
	/** Each part of the XForm of the form the key names that holds the text, as the proof lane
	 *  names a part (`proof/checks/xform_parts.py`), in the form's attachment. */
	readonly formParts?: readonly (readonly string[])[];
}

/** Where the projection writes a search property's text (`hqJson/caseList.ts::projectSearchInput`). */
const SEARCH_PROPERTY: readonly SlotStep[] = [
	"modules",
	MENU,
	"search_config",
	"properties",
	"*",
];

/**
 * Every kind of generated translation key a reading can fold
 * (`reader/assemble.ts::decideGeneratedKeys`, and the first language's `app.display.name`,
 * `reader/appShell.ts::readTranslations`), with the slots of CommCare HQ's stored app that hold
 * the text it names: the app strings HQ's build writes from each
 * (`app_strings.py::_create_custom_app_strings`, `id_strings.py`), which are where Nova's
 * projection writes the text of the translation unit the key's id feeds in Nova's own strings
 * (`hqJson/caseList.ts`, `expander.ts`). A key folds only where that id's source is one unit
 * (`generatedTranslationKeys.ts::classifyGeneratedTranslationKeys`), so every other generated
 * key, a media key, a constant (the Search button's label, a detail's empty-list and select
 * texts, a form's submit label), a string Nova never writes (a detail tab's title, a graph's
 * texts, an alt text, a callout header) and `homescreen.title`, which the app shell reads and
 * never folds, is no row. A more exact pattern stands before a wider one that also spells its
 * keys (a Search field's hint before its label).
 *
 * The register's entry allows exactly these slots' paths (`FOLDED_TEXT_PATHS`), and its places
 * are these slots at the positions each folded key spells (`placesOfGeneratedKey`), so a place
 * the entry stands at always lies under a path it allows.
 */
export const FOLDED_TEXT_SLOTS: readonly FoldedTextSlots[] = [
	// The first language's `app.display.name` over the app's `name`
	// (`reader/appShell.ts::readTranslations`, the one generated key the reading folds outside the
	// classifier); every other language's is the name's translation, a key Nova writes itself.
	{ pattern: "app.display.name", slots: [["name"]] },
	{ pattern: "modules.m#", slots: [["modules", MENU, "name", "*"]] },
	// A form's name, and in the app's first language its `<h:title>` and its data node's `name`,
	// which Nova writes from it (`lib/domain/formWireName.ts::formWireName`).
	{
		pattern: "forms.m#f#",
		slots: [["modules", MENU, "forms", FORM, "name", "*"]],
		formParts: [["title"], ["data", "@name"]],
	},
	{
		pattern: "case_lists.m#",
		slots: [["modules", MENU, "case_list", "label", "*"]],
	},
	{
		pattern: "case_list_form.m#",
		slots: [["modules", MENU, "case_list_form", "label", "*"]],
	},
	// A column's header, and a sort-only field's (`app_strings.py`, `create_temp_sort_column`),
	// which is its sort element's name in Sort by.
	{
		pattern: "m#.*.*_*_#.header",
		slots: [
			[
				"modules",
				MENU,
				"case_details",
				DETAIL,
				"columns",
				COLUMN,
				"header",
				"*",
			],
			[
				"modules",
				MENU,
				"case_details",
				DETAIL,
				"sort_elements",
				"*",
				"display",
				"*",
			],
		],
	},
	// An enum's label: a mapping's label, an interval's text, a case property's choice label.
	{
		pattern: "m#.*.*_*_*.enum.*",
		slots: [
			[
				"modules",
				MENU,
				"case_details",
				DETAIL,
				"columns",
				COLUMN,
				"enum",
				"*",
				"value",
				"*",
			],
		],
	},
	{
		pattern: "search_property.m#.*.hint",
		slots: [[...SEARCH_PROPERTY, "hint", "*"]],
	},
	{
		pattern: "search_property.m#.*.required.text",
		slots: [[...SEARCH_PROPERTY, "required", "text", "*"]],
	},
	{
		pattern: "search_property.m#.*.validation.#.text",
		slots: [[...SEARCH_PROPERTY, "validations", "*", "text", "*"]],
	},
	{
		pattern: "search_property.m#.*",
		slots: [[...SEARCH_PROPERTY, "label", "*"]],
	},
	{
		pattern: "case_search.m#.inputs",
		slots: [["modules", MENU, "search_config", "title_label", "*"]],
	},
	{
		pattern: "case_search.m#.description",
		slots: [["modules", MENU, "search_config", "description", "*"]],
	},
];

/** A slot's path over the stored app: every step a key spells is `*`. */
function slotPath(slot: readonly SlotStep[]): string {
	return slot
		.map(
			(step) =>
				`/${typeof step === "string" ? step.replaceAll("~", "~0").replaceAll("/", "~1") : "*"}`,
		)
		.join("");
}

/** A form's source in the stored app. */
const FORM_SOURCE_PATH = "/_attachments/*";

/** The paths of the slots of one row, a form's source where it names a part of one. */
export function foldedTextPathsOf(row: FoldedTextSlots): readonly string[] {
	return [
		...row.slots.map(slotPath),
		...(row.formParts === undefined ? [] : [FORM_SOURCE_PATH]),
	];
}

/** The path of every slot a fold can set, each once, in `FOLDED_TEXT_SLOTS`' order. */
export const FOLDED_TEXT_PATHS: readonly string[] = [
	...new Set(FOLDED_TEXT_SLOTS.flatMap(foldedTextPathsOf)),
];

/** The row whose pattern spells `key` whole, the first in order; undefined for a key no fold sets. */
export function foldedTextSlotsOf(key: string): FoldedTextSlots | undefined {
	return FOLDED_TEXT_SLOTS.find((row) =>
		generatedAppStringPatternSpells(row.pattern, key),
	);
}

/** HQ's detail types by the word a key spells them with (`id_strings.py::detail_column_header_locale`,
 *  `ModuleBase.get_details`): a search's details are copies of the case list's
 *  (`Module.search_detail`). */
const DETAIL_OF_KEY: SourceTable<string> = tableOf({
	case_short: "short",
	case_long: "long",
	search_short: "short",
	search_long: "long",
});

/**
 * The position in its detail's `columns` of the column a detail key names,
 * `m<m>.<detail>.<model>_<field>_<column + 1>.header` or `...<column + 1>.enum.<key>`
 * (`id_strings.py::detail_column_header_locale`, `detail_column_enum_variable`), or undefined
 * where the key spells none.
 */
function detailColumnIndex(key: string): number | undefined {
	const [menu, word] = key.split(".", 2) as [string, string?];
	if (word === undefined) return undefined;
	const rest = key.slice(menu.length + word.length + 2);
	const end = rest.endsWith(".header")
		? rest.length - ".header".length
		: rest.indexOf(".enum.");
	if (end < 0) return undefined;
	const token = rest.slice(0, end);
	const id = token.slice(token.lastIndexOf("_") + 1);
	if (!/^[0-9]+$/.test(id) || Number(id) < 1) return undefined;
	return Number(id) - 1;
}

/** The steps of `slot` at the positions `key` spells, up to the first step it does not: a
 *  position or a language no key names (`*`), or a part of the key it cannot read. */
function slotStepsOf(key: string, slot: readonly SlotStep[]): string[] {
	const owner = generatedKeyOwner(key);
	const steps: string[] = [];
	for (const step of slot) {
		let at: string | undefined;
		if (typeof step === "string") at = step === "*" ? undefined : step;
		else if (step.spelled === "menu")
			at = owner.kind === "app" ? undefined : String(owner.menu);
		else if (step.spelled === "form")
			at = owner.kind === "form" ? String(owner.form) : undefined;
		else if (step.spelled === "detail")
			at = DETAIL_OF_KEY.get(key.split(".")[1] ?? "");
		else {
			const column = detailColumnIndex(key);
			at = column === undefined ? undefined : String(column);
		}
		if (at === undefined) break;
		steps.push(at);
	}
	return steps;
}

/**
 * The places of the text a generated translation key names, which a fold of the key sets: each
 * slot of its row of `FOLDED_TEXT_SLOTS` at the positions the key spells
 * (`generatedTranslationKeys.ts::generatedKeyOwner`, the detail and the column a detail key
 * spells), up to the first it does not, and each part of the XForm of the form it names. Throws for a key no row spells, which the reader never
 * folds: Nova's strings hold no other generated id whose source is one translation unit.
 */
export function placesOfGeneratedKey(key: string): readonly string[] {
	const row = foldedTextSlotsOf(key);
	if (row === undefined)
		throw new Error(
			`A reading folded a generated translation key of the pattern ${JSON.stringify(generatedAppStringPattern(key) ?? "none")} that no row of FOLDED_TEXT_SLOTS spells, so the register cannot say where its text stands. A key folds only where Nova's own strings feed its id from one translation unit; add the row naming the stored slots of that unit's text in lib/deployment/reading/firstPublishPlaces.ts.`,
		);
	const owner = generatedKeyOwner(key);
	const position =
		owner.kind === "form" ? `${owner.menu}.${owner.form}` : undefined;
	return [
		...row.slots.map((slot) => placeOfAppSteps(slotStepsOf(key, slot))),
		...(position === undefined
			? []
			: (row.formParts ?? []).map((part) =>
					placeOf("form", position, "xform", ...part),
				)),
	];
}

/** `places` in code-unit order, each once. */
export function sortedPlaces(places: Iterable<string>): readonly string[] {
	return [...new Set(places)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
