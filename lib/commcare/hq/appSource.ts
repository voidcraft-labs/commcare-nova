import "server-only";

/**
 * Read the source document of an app on CommCare HQ.
 *
 * One reader, called by each publish read that needs the app as HQ holds it:
 * the read that decides whether the mapped app is still there before an
 * update, the read after the shell create, and the second read after a
 * lookup table or a place push. Each caller takes its own read; none is
 * cached, because HQ can change the app between any two of them.
 *
 * The source view (`app_manager/views/apps.py::app_source`) needs edit-apps
 * and no API access. It serves `doc_type`, `build_spec`, `profile`, `langs`,
 * `translations`, `add_ons`, `cloudcare_enabled`, `logo_refs`, each module's
 * `unique_id` and each form's `xmlns`, and the form XML under `_attachments`.
 * It serves `name`, `last_modified`, `multimedia_map` and `build_profiles`
 * as stored, a mirror menu with a null `case_type`, a shadow form with a
 * null `xmlns` and a menu HQ never gave an id with no `unique_id`, and no
 * `version` and no `_id`. Every read mints its own form ids
 * (`models/applications.py::Application.scrub_source`,
 * `util.py::update_form_unique_ids`), so a form id from one read is a key
 * into that read only.
 */

import type { HqApplicationProfile } from "@/lib/commcare";
import { NO_ENTRIES } from "@/lib/domain/records";
import { log } from "@/lib/logger";
import { canonicalJsonText } from "@/lib/utils/canonicalJsonText";
import { HQ_APP_SOURCE_MAX_BYTES } from "./bounds";
import {
	type HqBuildProfile,
	readBuildProfiles,
	unusableBuildProfileKey,
} from "./buildProfiles";
import {
	type CommCareApiError,
	type CommCareCredentials,
	HQ_MALFORMED_ANSWER,
	hqDomainPath,
	INVALID_DOMAIN_SLUG,
	isValidDomainSlug,
} from "./http";
import {
	type HqMediaMapItem,
	readMultimediaMap,
	unreadableMediaIdentity,
} from "./mediaMap";
import { readHqJson } from "./readJson";

export { HQ_APP_SOURCE_MAX_BYTES } from "./bounds";
export {
	type HqBuildProfile,
	readBuildProfiles,
	unusableBuildProfileKey,
} from "./buildProfiles";
export {
	HQ_MEDIA_TYPES,
	type HqMediaMapItem,
	type HqMediaType,
	readMultimediaMap,
	UNREADABLE_MEDIA_ENTRY_POSITIONS,
	unreadableMediaIdentity,
} from "./mediaMap";

export interface HqAppSourceForm {
	/** `doc_type`: `Form`, `AdvancedForm` or `ShadowForm` (`models/forms.py::FormBase.wrap`). */
	readonly docType: string;
	/** `xmlns` as stored. Null on a shadow form, which stores none and takes its parent's. */
	readonly xmlns: string | null;
	/** This read's minted id: a key into this read only, never an identity. */
	readonly readUniqueId: string;
	/**
	 * `shadow_parent_form_id`: this read's id of the form a shadow form mirrors, rewritten with the
	 * form ids of the same read. Null where the key is absent, null or empty.
	 */
	readonly shadowParentReadId: string | null;
	/** The XForm under this read's `<form id>.xml`, or null when absent. */
	readonly attachment: string | null;
}

export interface HqAppSourceModule {
	/**
	 * `unique_id` as stored. Under `admit: "any"`, null where the menu stores none (absent, null or
	 * `""`). Under `admit: "plain"` always a string.
	 */
	readonly uniqueId: string | null;
	/**
	 * `doc_type`: `Module`, `AdvancedModule`, `ReportModule` or `ShadowModule`
	 * (`models/modules.py::ModuleBase.wrap`).
	 */
	readonly docType: string;
	/** `case_type` as stored: `""` for a menu with none, null on a mirror menu, which stores none. */
	readonly caseType: string | null;
	readonly forms: readonly HqAppSourceForm[];
}

export interface HqAppSource {
	readonly docType: "Application";
	/**
	 * `build_spec.version`, HQ's CommCare version for the app. The version
	 * floor (`lib/commcare/versionFloor.ts::compareToVersionFloor`) reads it
	 * from a publish's first read.
	 */
	readonly buildSpecVersion: string;
	/**
	 * `cloudcare_enabled`: whether Web Apps offers the app. HQ sets it from
	 * the project space's plan when an upload creates the app and Nova never
	 * writes it, so a publish reads it and says so where it is off.
	 */
	readonly cloudcareEnabled: boolean;
	/**
	 * `logo_refs`, each logo slot HQ holds; `{}` where the key is absent. An
	 * update that names `logo_refs` replaces the dict whole, so the import
	 * builds what it sends from this (`lib/commcare/targetLogoRefs.ts`).
	 */
	readonly logoRefs: Readonly<Record<string, unknown>>;
	readonly profile: HqApplicationProfile;
	/** `langs`, HQ's language codes in order. */
	readonly langs: readonly string[];
	/** `translations`: per language, the app string overrides HQ holds. */
	readonly translations: Readonly<
		Record<string, Readonly<Record<string, string>>>
	>;
	/** `add_ons`: each slug HQ holds, on or off. */
	readonly addOns: Readonly<Record<string, boolean>>;
	readonly modules: readonly HqAppSourceModule[];
	/** The whole parsed body, for work item B's baseline and work item D's overlays. */
	readonly raw: Readonly<Record<string, unknown>>;
	/** `name`, or null where HQ sent no string. */
	readonly name: string | null;
	/** `last_modified` as HQ wrote it, or null where HQ sent no string. */
	readonly lastModified: string | null;
	/** `multimedia_map` in HQ's key order, or null where the key is absent or holds no object. */
	readonly multimediaMap: readonly HqMediaMapItem[] | null;
	/** `build_profiles` in HQ's key order; empty where the app has none. Never null. */
	readonly buildProfiles: readonly HqBuildProfile[];
}

export type HqAppSourceRead =
	| { readonly kind: "source"; readonly source: HqAppSource }
	/** HQ reports the app gone: a 404 (`deleted: false`) or HQ's own soft delete (`deleted: true`). */
	| { readonly kind: "gone"; readonly deleted: false }
	| {
			readonly kind: "gone";
			readonly deleted: true;
			/**
			 * Whether the deleted document holds a `built_on`. Every build holds one
			 * (`models/applications.py::ApplicationBase.convert_app_to_build`), and
			 * so does a working app a person reverted to a build
			 * (`make_reversion_to_copy` copies it), so it may be either. The
			 * source holds no `copy_of`, which alone would say. A document without
			 * one is a working app.
			 */
			readonly mayBeBuild: boolean;
	  }
	/**
	 * An app Nova did not make and does not update: the one HQ's source view
	 * serves for a working app is `LinkedApplication`; a build's id is served
	 * as `Application`, and no caller passes one.
	 */
	| { readonly kind: "unsupported"; readonly docType: string }
	| CommCareApiError;

export interface ReadHqAppSourceOptions {
	/** The most bytes of the body read. `HQ_APP_SOURCE_MAX_BYTES` unless given. */
	readonly maxBytes?: number;
	/** The read's own deadline. 30 seconds unless given. */
	readonly deadlineMs?: number;
	readonly cancel?: AbortSignal;
	/**
	 * `plain`, the default: every menu holds a string `unique_id` and a string `case_type` and
	 * every form but a shadow form a string `xmlns`, and anything else is `malformed`. This is a
	 * publish's check.
	 * `any`: a null `case_type` and a null `xmlns` are read as null, and a menu's absent, null or
	 * `""` `unique_id` is read as null. This is a bring-in's.
	 */
	readonly admit?: "plain" | "any";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Advanced entries store a table tag directly. Its generated fixture URI
 * appears only in the built suite. A shadow stores its replacement and
 * additional choices in its own action list. */
export function entryLookupTableTags(source: HqAppSource): ReadonlySet<string> {
	const tags = new Set<string>();
	const modules = source.raw.modules;
	if (!Array.isArray(modules)) return tags;
	for (const menu of modules) {
		if (!isRecord(menu) || !Array.isArray(menu.forms)) continue;
		for (const form of menu.forms) {
			if (!isRecord(form)) continue;
			const actions =
				form.doc_type === "ShadowForm"
					? form.extra_actions
					: form.doc_type === "AdvancedForm"
						? form.actions
						: undefined;
			if (!isRecord(actions) || !Array.isArray(actions.load_update_cases))
				continue;
			for (const load of actions.load_update_cases) {
				const auto = isRecord(load) && load.auto_select;
				if (
					isRecord(auto) &&
					auto.mode === "fixture" &&
					typeof auto.value_source === "string"
				)
					tags.add(auto.value_source);
			}
		}
	}
	return tags;
}

/** An object of language entries, each an object of strings. */
function isStringBagByLanguage(
	value: unknown,
): value is Record<string, Record<string, string>> {
	return (
		isRecord(value) &&
		Object.values(value).every(
			(entry) =>
				isRecord(entry) &&
				Object.values(entry).every((text) => typeof text === "string"),
		)
	);
}

/**
 * Read the app's source and say what CommCare HQ holds there.
 *
 * `gone` covers both forms of "HQ reports the app gone": the document does
 * not exist (404, `deleted: false`), and HQ's ordinary delete, which is soft
 * and leaves the read answering 200 with a `doc_type` ending `-Deleted`
 * (`models/applications.py::ApplicationBase.delete_app`, `deleted: true`),
 * a working app's and a build's alike.
 * Any other `doc_type` than `Application` is `unsupported`.
 *
 * Anything short of the expected shape is a refusal, never an empty
 * default: an empty profile, `translations`, `add_ons` or `build_profiles`
 * would make the next import erase configuration HQ owns or pass a state a
 * publish must stop on, and a menu with no id cannot be paired. Every live app source must carry its media map. Its name and save time may be absent.
 */
export async function readHqAppSource(
	creds: CommCareCredentials,
	domain: string,
	appId: string,
	options: ReadHqAppSourceOptions = {},
): Promise<HqAppSourceRead> {
	if (!isValidDomainSlug(domain) || !/^[\w-]+$/.test(appId))
		return INVALID_DOMAIN_SLUG;
	const url = `${hqDomainPath(domain)}/apps/source/${encodeURIComponent(appId)}/`;
	const result = await readHqJson(creds, url, "app source", {
		maxBytes: options.maxBytes ?? HQ_APP_SOURCE_MAX_BYTES,
		deadlineMs: options.deadlineMs,
		cancel: options.cancel,
	});
	if ("success" in result) {
		return result.status === 404 && result.edgeRefusal !== true
			? { kind: "gone", deleted: false }
			: result;
	}
	const body = result.data;
	if (!isRecord(body) || typeof body.doc_type !== "string") {
		return malformed(domain, appId, "doc_type");
	}
	if (body.doc_type.endsWith("-Deleted"))
		return {
			kind: "gone",
			deleted: true,
			mayBeBuild: body.built_on !== undefined && body.built_on !== null,
		};
	if (body.doc_type !== "Application") {
		return { kind: "unsupported", docType: body.doc_type };
	}

	const parsed = parseHqAppSource(body, {
		admit: options.admit,
		onNote: (note) => {
			if (note.kind === "media-map-malformed") return; // The caller logs the malformed required key below.
			log.warn("[commcare] media map entries are unreadable", {
				domain,
				request: "app-source",
				appId,
				count: note.count,
				firstIndexes: note.firstIndexes,
			});
		},
	});
	if (parsed.kind === "source") {
		// An update can prune mappings even when the app sends no files.
		// A live reading must account for the map before it may be adopted,
		// refreshed or used for an import. Older stored sources still decode.
		return parsed.source.multimediaMap === null
			? malformed(domain, appId, "multimedia_map")
			: parsed;
	}
	if (parsed.key === "build_profiles.unusable-key")
		return { ...HQ_MALFORMED_ANSWER, installationProfileKeyUnusable: true };
	if (parsed.key === "build_profiles") {
		log.error("[commcare] build profiles are malformed", undefined, {
			domain,
			request: "app-source",
			appId,
		});
		return HQ_MALFORMED_ANSWER;
	}
	return malformed(domain, appId, parsed.key);
}

/** What a parse of a source met that its caller may log: a media map that is no object, or the
 *  entries of it Nova cannot ask for, as one note for the whole map with their count and the
 *  positions of the first few. Neither refuses the parse. */
export type HqAppSourceParseNote =
	| { readonly kind: "media-map-malformed" }
	| {
			readonly kind: "media-entries-unreadable";
			readonly count: number;
			/** The first `UNREADABLE_MEDIA_ENTRY_POSITIONS` positions, in the map's order. */
			readonly firstIndexes: readonly number[];
	  };

export type HqAppSourceParse =
	| { readonly kind: "source"; readonly source: HqAppSource }
	/** The first key whose value is not the shape HQ serializes. */
	| { readonly kind: "malformed"; readonly key: string };

/**
 * The source an `Application` body is, by the same checks `readHqAppSource`
 * makes of HQ's answer: anything short of the expected shape names the first
 * key that is not, and `doc_type` where the body is no `Application`. Pure:
 * it reads the body and reports what it met through `onNote`, never a log.
 */
export function parseHqAppSource(
	body: Readonly<Record<string, unknown>>,
	options: {
		readonly admit?: "plain" | "any";
		readonly onNote?: (note: HqAppSourceParseNote) => void;
	} = {},
): HqAppSourceParse {
	const admitAny = options.admit === "any";
	const refuse = (key: string): HqAppSourceParse => ({
		kind: "malformed",
		key,
	});
	if (body.doc_type !== "Application") return refuse("doc_type");
	const { modules, _attachments, profile, langs, build_spec, translations } =
		body;
	const addOns = body.add_ons;
	const logoRefs = body.logo_refs;
	if (!Array.isArray(modules)) return refuse("modules");
	if (!isRecord(_attachments)) return refuse("_attachments");
	if (!isRecord(profile)) return refuse("profile");
	if (
		profile.custom_properties !== undefined &&
		!isRecord(profile.custom_properties)
	) {
		return refuse("profile.custom_properties");
	}
	if (
		!Array.isArray(langs) ||
		!langs.every((lang): lang is string => typeof lang === "string")
	) {
		return refuse("langs");
	}
	if (!isRecord(build_spec) || typeof build_spec.version !== "string") {
		return refuse("build_spec");
	}
	if (!isStringBagByLanguage(translations)) {
		return refuse("translations");
	}
	if (
		!isRecord(addOns) ||
		!Object.values(addOns).every((value) => typeof value === "boolean")
	) {
		return refuse("add_ons");
	}
	if (logoRefs !== undefined && !isRecord(logoRefs)) {
		return refuse("logo_refs");
	}
	const ordinaryLanguages = new Set(langs);
	const buildProfiles = readBuildProfiles(
		body.build_profiles,
		ordinaryLanguages,
		modules.length,
	);
	if (buildProfiles === null)
		return refuse(
			unusableBuildProfileKey(
				body.build_profiles,
				ordinaryLanguages,
				modules.length,
			)
				? "build_profiles.unusable-key"
				: "build_profiles",
		);

	const parsedModules: HqAppSourceModule[] = [];
	for (const module of modules) {
		if (!isRecord(module) || !Array.isArray(module.forms)) {
			return refuse("modules[]");
		}
		const uniqueId = moduleUniqueId(module.unique_id, admitAny);
		const docType = docTypeOf(module.doc_type, admitAny);
		// HQ derives a second menu's case type from its source. A Nova upload omits
		// the inert stored property; HQ's source of that upload serializes it as null.
		const caseType =
			docType === "ShadowModule" && module.case_type == null
				? null
				: textOrNull(module.case_type, admitAny);
		if (uniqueId === undefined || caseType === undefined || docType === null) {
			return refuse("modules[]");
		}
		const forms: HqAppSourceForm[] = [];
		for (const form of module.forms) {
			if (!isRecord(form) || typeof form.unique_id !== "string") {
				return refuse("modules[].forms[]");
			}
			const formDocType = docTypeOf(form.doc_type, admitAny);
			/* A shadow form stores no namespace and takes its parent's
			 * (`ShadowForm.xmlns`); every reading reads it as none. */
			const xmlns =
				formDocType === "ShadowForm" &&
				(form.xmlns === null || form.xmlns === undefined)
					? null
					: textOrNull(form.xmlns, admitAny);
			if (xmlns === undefined || formDocType === null) {
				return refuse("modules[].forms[]");
			}
			/* Paired through this response's own form ids. Key sets are never
			 * compared: an app made before step 2 serves orphan attachments
			 * under stable keys. */
			const attachment = _attachments[`${form.unique_id}.xml`];
			const shadowParent = form.shadow_parent_form_id;
			forms.push({
				docType: formDocType,
				xmlns,
				readUniqueId: form.unique_id,
				shadowParentReadId:
					typeof shadowParent === "string" && shadowParent !== ""
						? shadowParent
						: null,
				attachment: typeof attachment === "string" ? attachment : null,
			});
		}
		parsedModules.push({ uniqueId, docType, caseType, forms });
	}

	return {
		kind: "source",
		source: {
			docType: "Application",
			buildSpecVersion: build_spec.version,
			/* HQ serializes the property on every app, so anything but `true`
			 * is an app Web Apps does not offer. */
			cloudcareEnabled: body.cloudcare_enabled === true,
			logoRefs: isRecord(logoRefs) ? logoRefs : NO_ENTRIES,
			profile: profile as unknown as HqApplicationProfile,
			langs,
			translations,
			addOns: addOns as Readonly<Record<string, boolean>>,
			modules: parsedModules,
			raw: body,
			name: typeof body.name === "string" ? body.name : null,
			lastModified:
				typeof body.last_modified === "string" ? body.last_modified : null,
			multimediaMap: readMultimediaMap(body.multimedia_map, options.onNote),
			buildProfiles,
		},
	};
}

/**
 * A menu's `unique_id`: a string under both modes; under `any`, null where
 * the menu stores none (absent, null or `""`). `undefined` where the mode
 * refuses it.
 */
function moduleUniqueId(
	value: unknown,
	admitAny: boolean,
): string | null | undefined {
	if (typeof value === "string") return admitAny && value === "" ? null : value;
	if (admitAny && (value === undefined || value === null)) return null;
	return undefined;
}

/** A string, or under `any` null too; `undefined` where the mode refuses it. */
function textOrNull(
	value: unknown,
	admitAny: boolean,
): string | null | undefined {
	if (typeof value === "string") return value;
	if (admitAny && value === null) return null;
	return undefined;
}

/**
 * A menu's or form's `doc_type`. HQ cannot load either without one
 * (`ModuleBase.wrap`, `FormBase.wrap`), so under `any` a missing one is
 * refused (null); under `plain`, which reads none, it reads `""`.
 */
function docTypeOf(value: unknown, admitAny: boolean): string | null {
	if (typeof value === "string") return value;
	return admitAny ? null : "";
}

/**
 * App-shell inputs the changes reader uses beyond the part Nova overwrites.
 * HQ prunes map keys unreferenced by both content and the retained logos.
 * A file outside the settled manifest may also be one the earlier reading
 * left out, or one HQ now serves. Map item versions and upload metadata
 * describe neither a path nor a file. Web Apps also affects how the reader
 * interprets an absent Incomplete Forms setting.
 *
 * The maps compare entry by entry. A path that left the map is a move. A
 * `settledPaths` path is Nova's own file there, so a new entry or another id
 * at it is not one: HQ's bulk upload adds Nova's file to the map after the
 * publish read the app back.
 */
export function publishReadingFactsMoved(
	previous: unknown,
	current: HqAppSource,
	settledPaths: ReadonlySet<string>,
): boolean {
	if (!isRecord(previous)) return true;
	if ((previous.cloudcare_enabled === true) !== current.cloudcareEnabled)
		return true;
	if (
		canonicalJsonText(previous.logo_refs ?? NO_ENTRIES) !==
		canonicalJsonText(current.logoRefs)
	)
		return true;
	const earlier = readMultimediaMap(previous.multimedia_map, undefined) ?? [];
	const now = current.multimediaMap ?? [];
	const nowPaths = new Set(now.map((item) => item.path));
	if (earlier.some((item) => !nowPaths.has(item.path))) return true;
	const byPath = new Map(earlier.map((item) => [item.path, item]));
	return now.some((item) => {
		const before = byPath.get(item.path);
		if (before === undefined) return !settledPaths.has(item.path);
		return (
			before.mediaType !== item.mediaType ||
			before.unreadable !== item.unreadable ||
			(item.unreadable &&
				unreadableMediaIdentity(previous, item.path) !==
					unreadableMediaIdentity(current.raw, item.path)) ||
			(before.multimediaId !== item.multimediaId &&
				!settledPaths.has(item.path))
		);
	});
}

function malformed(
	domain: string,
	appId: string,
	key: string,
): CommCareApiError {
	log.error("[commcare] app source is malformed", undefined, {
		domain,
		appId,
		key,
	});
	return HQ_MALFORMED_ANSWER;
}
