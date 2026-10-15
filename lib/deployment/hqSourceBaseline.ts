/**
 * The app half of the drift check: the stored form of one CommCare HQ app
 * source read, and the comparison of two such reads.
 *
 * A baseline is always HQ's own read, never what Nova sent. HQ serializes
 * every property its models declare, and an update replaces `modules` whole
 * (`models/applications.py::_merge_source_into_app`), so comparing a sent
 * body with a read would need HQ's defaults modeled here. Comparing one read
 * with another needs only what every read changes on its own, which
 * `normalizeHqAppSource` takes out.
 *
 * Pure: no I/O, no store. Every sentence a person reads about a part is in
 * `remoteChanges.ts`; this module returns typed parts.
 */

import { ownedProfile } from "@/lib/commcare/appOwnership";
import type { SchemaDefaultReader } from "@/lib/commcare/surface/schemaDefaults";
import {
	canonicalJsonDigest,
	canonicalJsonText,
} from "@/lib/utils/canonicalJson";
import type { AppOwnership } from "./types";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The position token a form's minted id is replaced by: `m<i>.f<j>`. */
function formToken(menu: number, form: number): string {
	return `m${menu}.f${form}`;
}

/**
 * Replace each form-id reference under `holder[key]` by the token of the
 * form it names, or `{ unresolved: <value> }` when it names none. Only a
 * non-empty string names anything; an absent or empty reference is kept.
 */
function resolveFormReference(
	holder: unknown,
	key: string,
	tokens: ReadonlyMap<string, string>,
): void {
	if (!isObject(holder)) return;
	const value = holder[key];
	if (typeof value !== "string" || value === "") return;
	holder[key] = tokens.get(value) ?? { unresolved: value };
}

function eachObject(list: unknown, visit: (item: JsonObject) => void): void {
	if (!Array.isArray(list)) return;
	for (const item of list) if (isObject(item)) visit(item);
}

/**
 * The stored form of one app source read.
 *
 * Every read mints a fresh id for every form (`models/applications.py::
 * Application.scrub_source`, `util.py::update_form_unique_ids`) and rewrites
 * each reference to a form to that read's id, so ids and the references to
 * them become position tokens; a form's attachment follows its id and is
 * re-keyed with it, and an attachment no current form owns is dropped,
 * because forms are paired with attachments through the same response and
 * never by key. `admin_password` is a salted hash Nova does not keep, and
 * each read mints a uuid per report config (`util.py::
 * update_report_module_ids`). Everything else stays as HQ returned it.
 *
 * Returns `{ malformed }` for anything that is not an Application source.
 */
export function normalizeHqAppSource(source: unknown):
	| {
			readonly normalized: unknown;
			readonly text: string;
			readonly digest: string;
			readonly bytes: number;
	  }
	| { readonly malformed: string } {
	if (!isObject(source) || source.doc_type !== "Application") {
		return { malformed: "doc_type" };
	}
	if (!Array.isArray(source.modules)) return { malformed: "modules" };
	if (!isObject(source._attachments)) return { malformed: "_attachments" };
	const normalized = structuredClone(source) as JsonObject & {
		modules: unknown[];
		_attachments: JsonObject;
	};

	/* The four paths `models/base.py::form_id_references` holds, filled by
	 * `FormIdProperty`: a form link, a shadow form's parent, a visit
	 * schedule's form, and a menu's case-list form. */
	const tokens = new Map<string, string>();
	const attachments: JsonObject = {};
	for (const [menu, module] of normalized.modules.entries()) {
		if (!isObject(module) || !Array.isArray(module.forms)) {
			return { malformed: "modules[]" };
		}
		for (const [index, form] of module.forms.entries()) {
			if (!isObject(form) || typeof form.unique_id !== "string") {
				return { malformed: "modules[].forms[]" };
			}
			const token = formToken(menu, index);
			tokens.set(form.unique_id, token);
			const attachment = source._attachments[`${form.unique_id}.xml`];
			if (attachment !== undefined) attachments[`${token}.xml`] = attachment;
			form.unique_id = token;
		}
	}
	for (const module of normalized.modules as JsonObject[]) {
		resolveFormReference(module.case_list_form, "form_id", tokens);
		eachObject(module.forms, (form) => {
			eachObject(form.form_links, (link) =>
				resolveFormReference(link, "form_id", tokens),
			);
			resolveFormReference(form, "shadow_parent_form_id", tokens);
		});
		eachObject(module.schedule_phases, (phase) =>
			eachObject(phase.forms, (form) =>
				resolveFormReference(form, "form_id", tokens),
			),
		);
		eachObject(module.report_configs, (config) => {
			delete config.uuid;
		});
	}
	normalized._attachments = attachments;
	delete normalized.admin_password;
	delete normalized.admin_password_charset;

	const text = canonicalJsonText(normalized);
	return {
		normalized,
		text,
		digest: canonicalJsonDigest(normalized),
		bytes: Buffer.byteLength(text, "utf8"),
	};
}

/** The keys of `value` that `keys` names, as HQ holds them; absent keys stay absent. */
function pick(value: unknown, keys: readonly string[]): JsonObject {
	if (!isObject(value)) return {};
	const picked: JsonObject = {};
	for (const key of keys) {
		if (Object.hasOwn(value, key)) picked[key] = value[key];
	}
	return picked;
}

/** One key copied when the source holds it, so an absent key stays absent. */
function copyKey(target: JsonObject, source: JsonObject, key: string): void {
	if (Object.hasOwn(source, key)) target[key] = source[key];
}

interface Projection {
	readonly modules: readonly unknown[];
	readonly attachments: JsonObject;
	readonly name: JsonObject;
	readonly languages: JsonObject;
	readonly settings: JsonObject;
	readonly text: JsonObject;
}

function project(normalized: unknown, ownership: AppOwnership): Projection {
	const source = isObject(normalized) ? normalized : {};
	const name: JsonObject = {};
	copyKey(name, source, "name");
	const languages: JsonObject = {};
	copyKey(languages, source, "langs");
	const settings: JsonObject = {};
	copyKey(settings, source, "application_version");
	copyKey(settings, source, "location_fixture_restore");
	settings.add_ons = pick(source.add_ons, ownership.addOns);
	settings.profile = ownedProfile(source.profile, ownership);
	if (ownership.autoGpsCapture) copyKey(settings, source, "auto_gps_capture");
	const text: JsonObject = {};
	/* The body replaces `translations` whole, so every key in it is one
	 * Nova writes. */
	copyKey(text, source, "translations");
	return {
		modules: Array.isArray(source.modules) ? source.modules : [],
		attachments: isObject(source._attachments) ? source._attachments : {},
		name,
		languages,
		settings,
		text,
	};
}

/**
 * What is compared: the normalized read restricted to what Nova writes,
 * under one ownership descriptor. Everything else is ignored: every key an
 * update never writes from its body (`models/applications.py::
 * ApplicationBase._update_excluded_fields`, `build_spec`, `_attachments`
 * beyond the forms' own), `last_modified`, `logo_refs`, and every key Nova
 * never sends.
 */
export function ownedProjection(
	normalized: unknown,
	ownership: AppOwnership,
): unknown {
	const projection = project(normalized, ownership);
	return {
		modules: projection.modules,
		attachments: projection.attachments,
		...projection.name,
		...projection.languages,
		...projection.settings,
		...projection.text,
	};
}

export type AppChangePart =
	| { readonly kind: "name" | "languages" | "settings" | "text" | "menu-list" }
	| { readonly kind: "menu"; readonly menu: number; readonly name: string }
	| {
			readonly kind: "form";
			readonly menu: number;
			readonly form: number;
			/** The form's name, from HQ's current read. */
			readonly name: string;
			/** Its menu's name, from HQ's current read. */
			readonly menuName: string;
	  };

/** Null, false, zero, an empty string, list or map. */
function isEmptyValue(value: unknown): boolean {
	return (
		value === null ||
		value === false ||
		value === 0 ||
		value === "" ||
		(Array.isArray(value) && value.length === 0) ||
		(isObject(value) && Object.keys(value).length === 0)
	);
}

function sameJson(left: unknown, right: unknown): boolean {
	return canonicalJsonText(left) === canonicalJsonText(right);
}

/**
 * Structural equality with the schema-growth rule. At an object that carries
 * a `doc_type`, a key held on one side only is no difference when its value
 * is the default the manifest records for that model's property, or, for a
 * key the manifest does not list, an empty value: HQ serializes every
 * declared property, so a property a newer HQ adds appears in every later
 * read. Under a property the manifest types `DictProperty`, every key is
 * content.
 */
function equalUnderSchema(
	left: unknown,
	right: unknown,
	reader: SchemaDefaultReader,
	isMap = false,
): boolean {
	if (Array.isArray(left) || Array.isArray(right)) {
		if (!Array.isArray(left) || !Array.isArray(right)) return false;
		if (left.length !== right.length) return false;
		return left.every((item, index) =>
			equalUnderSchema(item, right[index], reader),
		);
	}
	if (isObject(left) && isObject(right)) {
		const docType = isMap
			? null
			: typeof left.doc_type === "string"
				? left.doc_type
				: typeof right.doc_type === "string"
					? right.doc_type
					: null;
		const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
		for (const key of keys) {
			const inLeft = Object.hasOwn(left, key);
			const inRight = Object.hasOwn(right, key);
			if (inLeft && inRight) {
				const childIsMap = docType !== null && reader(docType, key).isMap;
				if (!equalUnderSchema(left[key], right[key], reader, childIsMap)) {
					return false;
				}
				continue;
			}
			if (docType === null) return false;
			const value = inLeft ? left[key] : right[key];
			const declared = reader(docType, key);
			const atDefault = declared.known
				? sameJson(value, declared.default)
				: isEmptyValue(value);
			if (!atDefault) return false;
		}
		return true;
	}
	return Object.is(left, right) || sameJson(left, right);
}

/**
 * A name as HQ holds it, a map from language code to text, read the way a
 * person would recognize it: the text under the first of the read's
 * languages that holds some, else the map's first non-empty text, else the
 * position counted from one.
 */
function displayName(
	name: unknown,
	langs: readonly string[],
	position: number,
): string {
	if (isObject(name)) {
		for (const code of langs) {
			const text = name[code];
			if (typeof text === "string" && text !== "") return text;
		}
		for (const text of Object.values(name)) {
			if (typeof text === "string" && text !== "") return text;
		}
	}
	return `#${position + 1}`;
}

function moduleWithoutForms(module: unknown): unknown {
	if (!isObject(module)) return module;
	const { forms: _forms, ...rest } = module;
	return rest;
}

function formsOf(module: unknown): readonly unknown[] {
	return isObject(module) && Array.isArray(module.forms) ? module.forms : [];
}

function uniqueIdOf(module: unknown): unknown {
	return isObject(module) ? module.unique_id : undefined;
}

/** A form with its attachment beside it, under the form's token. */
function formWithAttachment(form: unknown, attachments: JsonObject): unknown {
	const token = isObject(form) ? form.unique_id : undefined;
	const key = `${String(token)}.xml`;
	return {
		form,
		attachment: Object.hasOwn(attachments, key) ? attachments[key] : null,
	};
}

function langsOf(normalized: unknown): readonly string[] {
	return isObject(normalized) && Array.isArray(normalized.langs)
		? normalized.langs.filter(
				(lang): lang is string => typeof lang === "string",
			)
		: [];
}

/**
 * Empty when nothing Nova writes differs. Both sides are projected with the
 * BASELINE's ownership, at check time, so a publish whose document now needs
 * another add-on never reads as a change. With `shell: true` (the stored
 * baseline's origin is `create`) only `modules` is compared, and a
 * difference there is the one part `menu-list`.
 *
 * Menus pair by position, as do forms within a menu. A menu's `unique_id`
 * is stable across reads, so a list of another length, or another id at any
 * position, means a menu was added, removed or moved: the one part
 * `menu-list`, and no menu or form part. Otherwise each menu's own keys and
 * its count of forms decide its `menu` part, and each form, with its
 * attachment, its `form` part. Names come from HQ's current read.
 */
export function diffHqAppSource(input: {
	readonly baseline: unknown;
	readonly current: unknown;
	readonly ownership: AppOwnership;
	readonly shell: boolean;
	readonly schemaDefault: SchemaDefaultReader;
}): readonly AppChangePart[] {
	const reader = input.schemaDefault;
	const before = project(input.baseline, input.ownership);
	const after = project(input.current, input.ownership);
	const langs = langsOf(input.current);
	const parts: AppChangePart[] = [];

	if (input.shell) {
		return equalUnderSchema(before.modules, after.modules, reader)
			? []
			: [{ kind: "menu-list" }];
	}

	const reordered =
		before.modules.length !== after.modules.length ||
		before.modules.some(
			(module, index) =>
				!sameJson(uniqueIdOf(module), uniqueIdOf(after.modules[index])),
		);
	if (reordered) {
		parts.push({ kind: "menu-list" });
	} else {
		for (const [menu, current] of after.modules.entries()) {
			const earlier = before.modules[menu];
			const menuName = displayName(
				isObject(current) ? current.name : undefined,
				langs,
				menu,
			);
			const earlierForms = formsOf(earlier);
			const currentForms = formsOf(current);
			if (
				earlierForms.length !== currentForms.length ||
				!equalUnderSchema(
					moduleWithoutForms(earlier),
					moduleWithoutForms(current),
					reader,
				)
			) {
				parts.push({ kind: "menu", menu, name: menuName });
			}
			if (earlierForms.length !== currentForms.length) continue;
			for (const [form, currentForm] of currentForms.entries()) {
				if (
					!equalUnderSchema(
						formWithAttachment(earlierForms[form], before.attachments),
						formWithAttachment(currentForm, after.attachments),
						reader,
					)
				) {
					parts.push({
						kind: "form",
						menu,
						form,
						name: displayName(
							isObject(currentForm) ? currentForm.name : undefined,
							langs,
							form,
						),
						menuName,
					});
				}
			}
		}
	}
	/* The top-level keys are the Application's own properties, so the
	 * schema-growth rule reads them under its `doc_type`. */
	const appKeysDiffer = (group: keyof Projection): boolean =>
		!equalUnderSchema(
			{ doc_type: "Application", ...before[group] },
			{ doc_type: "Application", ...after[group] },
			reader,
		);
	if (appKeysDiffer("name")) parts.push({ kind: "name" });
	if (appKeysDiffer("languages")) parts.push({ kind: "languages" });
	if (appKeysDiffer("settings")) parts.push({ kind: "settings" });
	if (appKeysDiffer("text")) parts.push({ kind: "text" });
	return parts;
}
