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
 * `unique_id` and each form's `xmlns`, and the form XML under `_attachments`. It serves no `version` and no `_id`, and every read mints
 * its own form ids (`models/applications.py::Application.scrub_source`,
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

export interface HqAppSourceForm {
	readonly xmlns: string;
	/** This read's minted id: a key into this read only, never an identity. */
	readonly readUniqueId: string;
	/** The XForm under this read's `<form id>.xml`, or null when absent. */
	readonly attachment: string | null;
}

export interface HqAppSourceModule {
	readonly uniqueId: string;
	/** `case_type`; the empty string for a menu with none. */
	readonly caseType: string;
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
}

export type HqAppSourceRead =
	| { readonly kind: "source"; readonly source: HqAppSource }
	/** HQ reports the app gone: a 404, or HQ's own soft delete. */
	| { readonly kind: "gone" }
	/** An app Nova did not make and does not update, such as a linked app. */
	| { readonly kind: "unsupported"; readonly docType: string }
	| CommCareApiError;

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

/**
 * Read the app's source and say what CommCare HQ holds there.
 *
 * `gone` covers both forms of "HQ reports the app gone": the document does
 * not exist (404), and HQ's ordinary delete, which is soft and leaves the
 * read answering 200 with a `doc_type` ending `-Deleted`
 * (`models/applications.py::ApplicationBase.delete_app`). Any other
 * `doc_type` than `Application` is `unsupported`; the one HQ's source view
 * serves is `LinkedApplication`.
 *
 * Anything short of the expected shape is a refusal, never an empty
 * default: an empty profile, `translations` or `add_ons` would make the next
 * import erase configuration HQ owns, and a menu with no id cannot be paired.
 */
export async function readHqAppSource(
	creds: CommCareCredentials,
	domain: string,
	appId: string,
	options: { readonly maxBytes?: number } = {},
): Promise<HqAppSourceRead> {
	if (!isValidDomainSlug(domain) || !/^[\w-]+$/.test(appId))
		return INVALID_DOMAIN_SLUG;
	const url = `${baseUrl(creds)}/a/${domain}/apps/source/${encodeURIComponent(appId)}/`;
	const result = await readHqJson(creds, url, "app source", {
		maxBytes: options.maxBytes ?? HQ_APP_SOURCE_MAX_BYTES,
	});
	if ("success" in result) {
		return result.status === 404 && result.edgeRefusal !== true
			? { kind: "gone" }
			: result;
	}
	const body = result.data;
	if (!isRecord(body) || typeof body.doc_type !== "string") {
		return malformed(domain, appId, "doc_type");
	}
	if (body.doc_type.endsWith("-Deleted")) return { kind: "gone" };
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

	const parsedModules: HqAppSourceModule[] = [];
	for (const module of modules) {
		if (
			!isRecord(module) ||
			typeof module.unique_id !== "string" ||
			typeof module.case_type !== "string" ||
			!Array.isArray(module.forms)
		) {
			return malformed(domain, appId, "modules[]");
		}
		const forms: HqAppSourceForm[] = [];
		for (const form of module.forms) {
			if (
				!isRecord(form) ||
				typeof form.xmlns !== "string" ||
				typeof form.unique_id !== "string"
			) {
				return malformed(domain, appId, "modules[].forms[]");
			}
			/* Paired through this response's own form ids. Key sets are never
			 * compared: an app made before step 2 serves orphan attachments
			 * under stable keys. */
			const attachment = _attachments[`${form.unique_id}.xml`];
			forms.push({
				xmlns: form.xmlns,
				readUniqueId: form.unique_id,
				attachment: typeof attachment === "string" ? attachment : null,
			});
		}
		parsedModules.push({
			uniqueId: module.unique_id,
			caseType: module.case_type,
			forms,
		});
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
		},
	};
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
