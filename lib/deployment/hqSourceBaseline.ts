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

import { translationKeyOwner } from "@/lib/commcare/appStringKeys";
import {
	type HqMediaMapItem,
	readMultimediaMap,
	unreadableMediaIdentity,
} from "@/lib/commcare/hq/mediaMap";
import { servedSchemaPropertyDefault } from "@/lib/commcare/surface/schemaDefaults";
import { withoutPathOnlyLogoRefs } from "@/lib/commcare/targetLogoRefs";
import { ownedProfilePart } from "@/lib/commcare/targetOverlay";
import {
	canonicalJsonDigest,
	canonicalJsonText,
	canonicalTextDigest,
} from "@/lib/utils/canonicalJson";
import type { DeploymentScope, DeploymentTargetKey } from "./store";
import type { AppOwnership, DeploymentResource } from "./types";

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
	const read = normalizedHqAppSource(source);
	if ("malformed" in read) return read;
	const text = canonicalJsonText(read.normalized);
	return {
		normalized: read.normalized,
		text,
		digest: canonicalTextDigest(text),
		bytes: Buffer.byteLength(text, "utf8"),
	};
}

/** `normalizeHqAppSource`'s normalized source alone, with no text or digest
 *  made of it, for a caller that reads the source and stores nothing. */
export function normalizedHqAppSource(
	source: unknown,
): { readonly normalized: unknown } | { readonly malformed: string } {
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
	return { normalized };
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

/**
 * Nova's part of `translations`: per language, every key the target does not
 * own (`appStringKeys.ts`), a generated key, a language's name, or a key
 * HQ's build writes as no one record of its own name, which no publish
 * carries, so one stored in CommCare HQ is a change the check sees. With
 * `languageNames: "target"` (the app mapping is `adopted`) a language's name
 * is the project space's, as the overlay carries it, and no part of Nova's.
 * A language left with no such key is left out.
 */
function ownedTranslations(
	translations: unknown,
	codes: ReadonlySet<string>,
	languageNames: "nova" | "target",
): JsonObject {
	if (!isObject(translations)) return {};
	const owned: JsonObject = {};
	for (const [language, entry] of Object.entries(translations)) {
		if (!isObject(entry)) {
			owned[language] = entry;
			continue;
		}
		const keys = Object.keys(entry).filter((key) => {
			const owner = translationKeyOwner(key, codes);
			return (
				owner === "generated" ||
				owner === "not-its-own" ||
				(owner === "language-name" && languageNames === "nova")
			);
		});
		if (keys.length > 0) owned[language] = pick(entry, keys);
	}
	return owned;
}

function project(
	normalized: unknown,
	ownership: AppOwnership,
	languageNames: "nova" | "target",
	codes: ReadonlySet<string> = new Set(langsOf(normalized)),
): Projection {
	const source = isObject(normalized) ? normalized : {};
	const name: JsonObject = {};
	copyKey(name, source, "name");
	const languages: JsonObject = {};
	copyKey(languages, source, "langs");
	const settings: JsonObject = {};
	copyKey(settings, source, "application_version");
	copyKey(settings, source, "location_fixture_restore");
	settings.add_ons = pick(source.add_ons, ownership.addOns);
	settings.profile = ownedProfilePart(source.profile, ownership);
	if (ownership.autoGpsCapture) copyKey(settings, source, "auto_gps_capture");
	/* HQ holds `case_sharing` false unless someone turned it on, and an
	 * import that leaves the key out keeps HQ's value: an absent key is off. */
	if (ownership.caseSharing)
		settings.case_sharing = source.case_sharing === true;
	const text: JsonObject = {};
	/* The body carries the target's own keys back, so only Nova's part of
	 * `translations` is compared, and a key a person saved in HQ is none. */
	if (Object.hasOwn(source, "translations")) {
		text.translations = ownedTranslations(
			source.translations,
			codes,
			languageNames,
		);
	}
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
 * never sends. `languageNames` is the publish's: `"target"` where the app
 * mapping is `adopted`, whose language names are the project space's.
 */
export function ownedProjection(
	normalized: unknown,
	ownership: AppOwnership,
	languageNames: "nova" | "target",
): unknown {
	const projection = project(normalized, ownership, languageNames);
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
	/** Files this app publishes that CommCare HQ now holds another file at the path of. */
	| { readonly kind: "media" | "unused-media"; readonly count: number }
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
 * is the default the manifest records for that model's property as a read
 * serves it (`servedSchemaPropertyDefault`: both sides of every comparison
 * are HQ's reads, and a read wraps a detail pair with its two details named),
 * or, for a key the manifest does not list, an empty value: HQ serializes
 * every declared property, so a property a newer HQ adds appears in every
 * later read. Under a property the manifest types `DictProperty`, every key
 * is content.
 */
function equalUnderSchema(
	left: unknown,
	right: unknown,
	isMap = false,
): boolean {
	if (Array.isArray(left) || Array.isArray(right)) {
		if (!Array.isArray(left) || !Array.isArray(right)) return false;
		if (left.length !== right.length) return false;
		return left.every((item, index) => equalUnderSchema(item, right[index]));
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
				const childIsMap =
					docType !== null && servedSchemaPropertyDefault(docType, key).isMap;
				if (!equalUnderSchema(left[key], right[key], childIsMap)) {
					return false;
				}
				continue;
			}
			if (docType === null) return false;
			const value = inLeft ? left[key] : right[key];
			const declared = servedSchemaPropertyDefault(docType, key);
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

/** Logo paths retained by this content update. HQ then keeps map keys named
 * either by the sent forms and menus or by these exact logo paths
 * (ApplicationMediaMixin.remove_unused_mappings). */
function keptLogoPaths(source: JsonObject): Set<string> {
	const logos = isObject(source.logo_refs) ? source.logo_refs : {};
	const kept = withoutPathOnlyLogoRefs(logos) ?? logos;
	return new Set(
		Object.values(kept).flatMap((ref) =>
			isObject(ref) && typeof ref.path === "string" ? [ref.path] : [],
		),
	);
}

interface ImportFiles {
	readonly published: readonly { readonly wirePath: string }[];
	readonly recorded: Readonly<Record<string, string>> | null;
}

export interface RemovedHqFile {
	readonly path: string;
	readonly multimediaId: string | null;
	readonly digest: string;
}

function prunedHqPaths(
	source: unknown,
	published: ImportFiles["published"],
): string[] {
	if (!isObject(source) || !isObject(source.multimedia_map)) return [];
	const retained = keptLogoPaths(source);
	for (const file of published) retained.add(`jr://file/${file.wirePath}`);
	return Object.keys(source.multimedia_map).filter(
		(path) => !retained.has(path),
	);
}

/** The local ledger slots consulted to decide whether a residual reference is
 * Nova's own file. Record them under the same lock as other judged files. */
export function removalLedgerPaths(
	source: unknown,
	published: ImportFiles["published"],
): string[] {
	const prefix = "jr://file/";
	return prunedHqPaths(source, published).flatMap((path) =>
		path.startsWith(prefix) ? [path.slice(prefix.length)] : [],
	);
}

/** The app's import removes the map paths outside the outgoing carriers and
 * the logo slots HQ retains. A file recorded as Nova's own at the same path
 * and id can be dropped by an edit in Nova. Every other removal belongs to
 * this concrete HQ reference, including an unreadable map entry. */
export function removedHqFiles(
	current: unknown,
	files: ImportFiles,
): RemovedHqFile[] {
	if (!isObject(current) || !isObject(current.multimedia_map)) return [];
	const removed: RemovedHqFile[] = [];
	const pruned = new Set(prunedHqPaths(current, files.published));
	for (const item of readMultimediaMap(current.multimedia_map) ?? []) {
		const { path, multimediaId: id } = item;
		if (!pruned.has(path)) continue;
		const recorded = path.startsWith("jr://file/")
			? files.recorded?.[path.slice("jr://file/".length)]
			: null;
		if (!item.unreadable && id !== null && recorded === id) continue;
		removed.push({
			path,
			multimediaId: id,
			digest: hqFileBinding(current, item),
		});
	}
	return removed.sort((a, b) =>
		a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
	);
}

/** The digest a removal binds: the path and the HQ file at it, or the raw
 * identity of an entry Nova cannot read. */
function hqFileBinding(source: unknown, item: HqMediaMapItem): string {
	const binding = item.unreadable
		? ["unreadable", unreadableMediaIdentity(source, item.path)]
		: [item.multimediaId, item.mediaType];
	return canonicalJsonDigest([item.path, binding]);
}

/**
 * Whether the reading a removal is compared with held another file at its
 * path: the person last accepted a reading with one file there, and HQ now
 * holds a different one, so the line says so rather than repeating itself.
 */
export function removedHqFileReplaced(
	file: Pick<RemovedHqFile, "path" | "digest">,
	earlier: unknown,
): boolean {
	if (!isObject(earlier) || !isObject(earlier.multimedia_map)) return false;
	const before = readMultimediaMap(earlier.multimedia_map)?.find(
		(item) => item.path === file.path,
	);
	return before !== undefined && hqFileBinding(earlier, before) !== file.digest;
}

/**
 * The top-level keys an update keeps from the app it updates whatever its
 * body holds (`models/applications.py::ApplicationBase._update_excluded_fields`
 * less the `_meta_fields` the source view drops, and `build_spec`;
 * `views/app_import_api.py` then sets `name` and `created_from_template` from
 * the request, so those two are written by every import).
 */
const UPDATE_KEEPS = new Set([
	"date_created",
	"comment",
	"doc_type",
	"multimedia_map",
	"family_id",
	"copy_history",
	"build_profiles",
	"custom_base_url",
	"practice_mobile_worker_id",
	"_LAZY_ATTACHMENTS",
	"build_spec",
]);
const IMPORT_WRITES = new Set(["name", "created_from_template"]);

/**
 * Whether the save after an update's own is CommCare HQ pruning the media map
 * in that same request, so a read-back two saves on is what this import
 * left. `overwrite_app_from_source` saves once (`save_attachments`), then
 * `_update_valid_domains_for_media` runs `remove_unused_mappings`, which
 * deletes every map key outside the app's media and logo paths and saves
 * again when it deleted one (`hqmedia/models.py`); it prunes nothing on an app
 * whose forms fail to validate. So it holds only where the import predicted a
 * pruned key, the read-back's map is the earlier map less exactly those
 * keys, and every key the import does not write reads as it did before:
 * anything another writer changed outside the body shows there. `before` is
 * the read the import was built over and `body` the app it sent.
 */
export function importPruneSave(input: {
	readonly before: unknown;
	readonly after: unknown;
	readonly body: object;
	readonly published: ImportFiles["published"];
}): boolean {
	const { before, after } = input;
	if (!isObject(before) || !isObject(after)) return false;
	const pruned = new Set(prunedHqPaths(before, input.published));
	if (pruned.size === 0 || !isObject(before.multimedia_map)) return false;
	const expectedMap = Object.fromEntries(
		Object.entries(before.multimedia_map).filter(([path]) => !pruned.has(path)),
	);
	if (
		canonicalJsonText(expectedMap) !==
		canonicalJsonText(after.multimedia_map ?? null)
	)
		return false;
	const written = (key: string) =>
		IMPORT_WRITES.has(key) || (key in input.body && !UPDATE_KEEPS.has(key));
	const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
	for (const key of keys) {
		if (key === "multimedia_map" || key === "last_modified" || written(key))
			continue;
		if (
			canonicalJsonText(before[key] ?? null) !==
			canonicalJsonText(after[key] ?? null)
		)
			return false;
	}
	return true;
}

export function unapprovedHqFiles(
	removed: readonly RemovedHqFile[],
	approved: readonly string[] | undefined,
) {
	const accepted = new Set(approved);
	return removed.filter((file) => !accepted.has(file.digest));
}

/** A physical approval is bound to its file. An older category warning, or a
 * previously accepted file that has since gone, requires reconciling the card. */
export function fileReviewMoved(
	removed: readonly RemovedHqFile[],
	baseline: {
		readonly approvedFileRemovals?: readonly string[];
		readonly hasFileRemovalWarning?: true;
	},
): boolean {
	const prior = baseline.approvedFileRemovals ?? [];
	return (
		unapprovedHqFiles(removed, prior).length > 0 ||
		prior.length !== removed.length ||
		(baseline.hasFileRemovalWarning === true && removed.length === 0)
	);
}

/** The reviewed editor, target and revisions. An HQ save number only orders
 * observations of one actual HQ app during a continuous claim. */
export function appConfirmationScope(
	scope: DeploymentScope,
	target: DeploymentTargetKey,
	live: Pick<
		DeploymentResource,
		"deploymentId" | "remoteId" | "pushToken" | "reviewGeneration"
	>,
	headSeq: number,
	remoteRevision: number,
	baseline: {
		readonly origin: string;
		readonly sourceDigest?: string | null;
		readonly novaRevision?: number | null;
	} | null,
) {
	return {
		actor: scope.actorUserId,
		role: scope.role,
		project: scope.projectId,
		app: scope.appId,
		server: target.server,
		domain: target.domain,
		remoteApp: live.remoteId,
		deployment: live.deploymentId,
		claim: live.pushToken,
		reviewGeneration: live.reviewGeneration ?? null,
		headSeq,
		remoteRevision,
		baseline: baseline && [
			baseline.origin,
			baseline.sourceDigest ?? null,
			baseline.novaRevision ?? null,
		],
	};
}

/** A confirmed overwrite applies to the same working save and normalized source at the final read. */
export function confirmedAppSourceMoved(
	confirmed: {
		readonly saveCounter: number | null;
		readonly sourceDigest: string;
	} | null,
	observedCounter: number | null,
	observedDigest: string,
): boolean {
	return (
		confirmed !== null &&
		(confirmed.saveCounter !== observedCounter ||
			confirmed.sourceDigest !== observedDigest)
	);
}

/** The overwrite receipt is independent of the approval to take HQ's changes. */
export function hqDiscardDigest(
	authority: ReturnType<typeof appConfirmationScope>,
	source: string,
	removed: readonly RemovedHqFile[],
	disclosure: "preview" | "complete" | "unavailable" = "preview",
): string {
	return canonicalJsonDigest({
		v: 2,
		action: "publish-over",
		authority,
		source,
		removed: removed.map((file) => file.digest),
		disclosure,
	});
}

/** A media map path as a person reads it: the file's path within the app. */
export function hqFilePathName(path: string): string {
	return path.startsWith("jr://file/") ? path.slice("jr://file/".length) : path;
}

/**
 * A file the next import takes out of HQ's app, named by its path in the
 * app's files. CommCare HQ's own id for the file names nothing a person can
 * find, so the line leaves it to the reading's digest.
 */
export function removedHqFileLine(
	file: Pick<RemovedHqFile, "path" | "multimediaId">,
	replaced = false,
): string {
	const name = hqFilePathName(file.path);
	const line = file.multimediaId
		? `Publishing removes the file “${name}” from the app in CommCare HQ. This app doesn't use it.`
		: `Publishing removes the reference to “${name}” from the app in CommCare HQ. This app doesn't use it.`;
	return replaced
		? `${line} CommCare HQ holds a different file at that path than when Nova last read it.`
		: line;
}

/**
 * Empty when nothing Nova writes differs. Both sides are projected with the
 * BASELINE's ownership, at check time, so a publish whose document now needs
 * another add-on never reads as a change. With `shell: true` (the stored
 * baseline's origin is `create`) only `modules` is compared, a difference
 * there is the one part `menu-list`, and the media and removed-file parts
 * come as they do for any app.
 *
 * Menus pair by position, as do forms within a menu. A menu's `unique_id`
 * is stable across reads, so a list of another length, or another id at any
 * position, means a menu was added, removed or moved: the one part
 * `menu-list`, and no menu or form part. Otherwise each menu's own keys and
 * its count of forms decide its `menu` part, and each form, with its
 * attachment, its `form` part. Names come from HQ's current read.
 *
 * `languageNames` is the publish's own: `"target"` where the live app
 * mapping is `adopted`, so a language's display name, which the project
 * space keeps there, is no part of the comparison.
 *
 * `mediaChanged` is how many files this app publishes CommCare HQ holds
 * another file in place of, which the caller works out from the media map
 * (`hqMedia.ts`), since no update writes the map and the projection reads
 * none of it: one `media` part where it is above zero, on a shell too.
 */
export function diffHqAppSource(input: {
	readonly baseline: unknown;
	readonly current: unknown;
	readonly ownership: AppOwnership;
	readonly shell: boolean;
	readonly languageNames: "nova" | "target";
	readonly mediaChanged?: number;
	/** When making a content import, which media keys the outgoing app names
	 * and which late upload results Nova can already account for. */
	readonly importFiles?: ImportFiles;
}): readonly AppChangePart[] {
	/* One set of language codes for both reads, so a key is classed alike on
	 * each side and a changed list of languages is the `languages` part. */
	const codes = new Set([
		...langsOf(input.baseline),
		...langsOf(input.current),
	]);
	const before = project(
		input.baseline,
		input.ownership,
		input.languageNames,
		codes,
	);
	const after = project(
		input.current,
		input.ownership,
		input.languageNames,
		codes,
	);
	const langs = langsOf(input.current);
	const parts: AppChangePart[] = [];

	const fileChanges: AppChangePart[] = [];
	if (input.importFiles) {
		const current = removedHqFiles(input.current, input.importFiles);
		const approved = removedHqFiles(input.baseline, input.importFiles).map(
			(file) => file.digest,
		);
		const count = unapprovedHqFiles(current, approved).length;
		if (count) fileChanges.push({ kind: "unused-media", count });
	}
	if (input.shell) {
		if (!equalUnderSchema(before.modules, after.modules))
			parts.push({ kind: "menu-list" });
		if (input.mediaChanged)
			parts.push({ kind: "media", count: input.mediaChanged });
		return [...parts, ...fileChanges];
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
		);
	if (appKeysDiffer("name")) parts.push({ kind: "name" });
	if (appKeysDiffer("languages")) parts.push({ kind: "languages" });
	if (appKeysDiffer("settings")) parts.push({ kind: "settings" });
	if (appKeysDiffer("text")) parts.push({ kind: "text" });
	const mediaChanged = input.mediaChanged ?? 0;
	if (mediaChanged > 0) parts.push({ kind: "media", count: mediaChanged });
	return [...parts, ...fileChanges];
}
