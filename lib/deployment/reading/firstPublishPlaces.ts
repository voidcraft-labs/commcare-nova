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

import type { HqAppSource } from "@/lib/commcare/hq/appSource";
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

/** `places` in code-unit order, each once. */
export function sortedPlaces(places: Iterable<string>): readonly string[] {
	return [...new Set(places)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
