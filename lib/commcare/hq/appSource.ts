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
import { log } from "@/lib/logger";
import {
	baseUrl,
	type CommCareApiError,
	type CommCareCredentials,
	INVALID_DOMAIN_SLUG,
	isValidDomainSlug,
} from "./http";
import { readHqJson } from "./readJson";

/**
 * The most bytes of an app source Nova reads: 64 MiB. A longer body refuses
 * the read whole. The bound guards the server's memory against a body of any
 * length; it is not fitted to any app's size.
 */
export const HQ_APP_SOURCE_MAX_BYTES = 64 * 1024 * 1024;

/** The four document kinds `hqmedia/models.py::CommCareMultimedia.get_doc_class` names. */
export const HQ_MEDIA_TYPES = [
	"CommCareImage",
	"CommCareAudio",
	"CommCareVideo",
	"CommCareMultimedia",
] as const;
export type HqMediaType = (typeof HQ_MEDIA_TYPES)[number];

/** One entry of `multimedia_map`. */
export interface HqMediaMapItem {
	/** The map's key: the path the app's content names, `jr://file/...`. */
	readonly path: string;
	/** HQ's id of the file, or null where the entry names none Nova can ask for. */
	readonly multimediaId: string | null;
	readonly mediaType: HqMediaType | null;
	/** True where the entry names a file by an id or a type Nova cannot read. Both are then null. */
	readonly unreadable: boolean;
}

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

/** One entry of `build_profiles`. */
export interface HqBuildProfile {
	/** The profile's key in `build_profiles`. */
	readonly id: string;
	/** `name`; `""` where HQ holds no string. */
	readonly name: string;
	/** `langs`: the profile's language codes, its default first. */
	readonly langs: readonly string[];
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
	| { readonly kind: "gone"; readonly deleted: boolean }
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
	 * every form a string `xmlns`, and anything else is `malformed`. This is a publish's check.
	 * `any`: a null `case_type` and a null `xmlns` are read as null, and a menu's absent, null or
	 * `""` `unique_id` is read as null. This is a bring-in's.
	 */
	readonly admit?: "plain" | "any";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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

const MALFORMED: CommCareApiError = {
	success: false,
	status: 502,
	cause: "malformed",
};

const MEDIA_TYPES: ReadonlySet<string> = new Set(HQ_MEDIA_TYPES);

/**
 * Read the app's source and say what CommCare HQ holds there.
 *
 * `gone` covers both forms of "HQ reports the app gone": the document does
 * not exist (404, `deleted: false`), and HQ's ordinary delete, which is soft
 * and leaves the read answering 200 with a `doc_type` ending `-Deleted`
 * (`models/applications.py::ApplicationBase.delete_app`, `deleted: true`).
 * Any other `doc_type` than `Application` is `unsupported`.
 *
 * Anything short of the expected shape is a refusal, never an empty
 * default: an empty profile, `translations`, `add_ons` or `build_profiles`
 * would make the next import erase configuration HQ owns or pass a state a
 * publish must stop on, and a menu with no id cannot be paired. `name`,
 * `last_modified` and `multimedia_map` are read where HQ sent them and null
 * where it did not, so none of them refuses a read.
 */
export async function readHqAppSource(
	creds: CommCareCredentials,
	domain: string,
	appId: string,
	options: ReadHqAppSourceOptions = {},
): Promise<HqAppSourceRead> {
	if (!isValidDomainSlug(domain) || !/^[\w-]+$/.test(appId))
		return INVALID_DOMAIN_SLUG;
	const admitAny = options.admit === "any";
	const url = `${baseUrl(creds)}/a/${domain}/apps/source/${encodeURIComponent(appId)}/`;
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
		return { kind: "gone", deleted: true };
	if (body.doc_type !== "Application") {
		return { kind: "unsupported", docType: body.doc_type };
	}

	const { modules, _attachments, profile, langs, build_spec, translations } =
		body;
	const addOns = body.add_ons;
	const logoRefs = body.logo_refs;
	if (!Array.isArray(modules)) return malformed(domain, appId, "modules");
	if (!isRecord(_attachments)) return malformed(domain, appId, "_attachments");
	if (!isRecord(profile)) return malformed(domain, appId, "profile");
	if (
		profile.custom_properties !== undefined &&
		!isRecord(profile.custom_properties)
	) {
		return malformed(domain, appId, "profile.custom_properties");
	}
	if (
		!Array.isArray(langs) ||
		!langs.every((lang): lang is string => typeof lang === "string")
	) {
		return malformed(domain, appId, "langs");
	}
	if (!isRecord(build_spec) || typeof build_spec.version !== "string") {
		return malformed(domain, appId, "build_spec");
	}
	if (!isStringBagByLanguage(translations)) {
		return malformed(domain, appId, "translations");
	}
	if (
		!isRecord(addOns) ||
		!Object.values(addOns).every((value) => typeof value === "boolean")
	) {
		return malformed(domain, appId, "add_ons");
	}
	if (logoRefs !== undefined && !isRecord(logoRefs)) {
		return malformed(domain, appId, "logo_refs");
	}
	const buildProfiles = readBuildProfiles(body.build_profiles);
	if (buildProfiles === null) {
		log.error("[commcare] build profiles are malformed", undefined, {
			domain,
			request: "app-source",
			appId,
		});
		return MALFORMED;
	}

	const parsedModules: HqAppSourceModule[] = [];
	for (const module of modules) {
		if (!isRecord(module) || !Array.isArray(module.forms)) {
			return malformed(domain, appId, "modules[]");
		}
		const uniqueId = moduleUniqueId(module.unique_id, admitAny);
		const caseType = textOrNull(module.case_type, admitAny);
		const docType = docTypeOf(module.doc_type, admitAny);
		if (uniqueId === undefined || caseType === undefined || docType === null) {
			return malformed(domain, appId, "modules[]");
		}
		const forms: HqAppSourceForm[] = [];
		for (const form of module.forms) {
			if (!isRecord(form) || typeof form.unique_id !== "string") {
				return malformed(domain, appId, "modules[].forms[]");
			}
			const xmlns = textOrNull(form.xmlns, admitAny);
			const formDocType = docTypeOf(form.doc_type, admitAny);
			if (xmlns === undefined || formDocType === null) {
				return malformed(domain, appId, "modules[].forms[]");
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
			logoRefs: isRecord(logoRefs) ? logoRefs : {},
			profile,
			langs,
			translations,
			addOns: addOns as Readonly<Record<string, boolean>>,
			modules: parsedModules,
			raw: body,
			name: typeof body.name === "string" ? body.name : null,
			lastModified:
				typeof body.last_modified === "string" ? body.last_modified : null,
			multimediaMap: readMultimediaMap(body.multimedia_map, domain, appId),
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
 * `build_profiles`, `models/applications.py::ApplicationBase.build_profiles`,
 * a `SchemaDictProperty(BuildProfile)` HQ serializes on every app: an object
 * whose every value holds a `langs` list of strings. Null where it is not.
 */
function readBuildProfiles(value: unknown): readonly HqBuildProfile[] | null {
	if (!isRecord(value)) return null;
	const profiles: HqBuildProfile[] = [];
	for (const [id, profile] of Object.entries(value)) {
		if (
			!isRecord(profile) ||
			!Array.isArray(profile.langs) ||
			!profile.langs.every((lang) => typeof lang === "string")
		)
			return null;
		profiles.push({
			id,
			name: typeof profile.name === "string" ? profile.name : "",
			langs: profile.langs as string[],
		});
	}
	return profiles;
}

/**
 * `multimedia_map`, `hqmedia/models.py::ApplicationMediaMixin.multimedia_map`:
 * path to `HQMediaMapItem`. An entry with no id names no file
 * (`HQMediaMapItem.url` is empty for it); an entry whose id or type Nova
 * cannot ask for is kept as unreadable, so one entry never refuses the read.
 */
function readMultimediaMap(
	value: unknown,
	domain: string,
	appId: string,
): readonly HqMediaMapItem[] | null {
	if (value === undefined) return null;
	if (!isRecord(value)) {
		log.error("[commcare] media map is malformed", undefined, {
			domain,
			request: "app-source",
			appId,
		});
		return null;
	}
	const items: HqMediaMapItem[] = [];
	for (const [index, [path, entry]] of Object.entries(value).entries()) {
		if (isRecord(entry)) {
			const id = entry.multimedia_id;
			if (id === undefined || id === null || id === "") {
				items.push({
					path,
					multimediaId: null,
					mediaType: null,
					unreadable: false,
				});
				continue;
			}
			const type = entry.media_type;
			if (
				typeof id === "string" &&
				/^[\w-]+$/.test(id) &&
				typeof type === "string" &&
				MEDIA_TYPES.has(type)
			) {
				items.push({
					path,
					multimediaId: id,
					mediaType: type as HqMediaType,
					unreadable: false,
				});
				continue;
			}
		}
		log.warn("[commcare] media map entry is unreadable", {
			domain,
			request: "app-source",
			appId,
			index,
		});
		items.push({ path, multimediaId: null, mediaType: null, unreadable: true });
	}
	return items;
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
	return MALFORMED;
}
