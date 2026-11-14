import "server-only";

/**
 * The one reader of CommCare HQ's application resource,
 * `GET /a/<domain>/api/application/v1/<app_id>/`
 * (`api/resources/v0_4.py::ApplicationResource`): API access on the plan,
 * Access APIs on the account, throttled, and reachable with an API key
 * through `LoginAndDomainAuthentication`.
 *
 * It answers the app's real form ids, each form's `xmlns`, HQ's summary of
 * every question, and the app's builds. `extras=true` is never sent: it adds
 * the raw stored document, which doubles the largest read for nothing the
 * source read does not give.
 *
 * `readHqApplication` checks the envelope and the builds and keeps the
 * modules unread, so a question summary Nova cannot read never stops a
 * status check, which reads `builds` alone; `hqApplicationModules` types the
 * modules for the reader that needs them.
 */

import { log } from "@/lib/logger";
import {
	baseUrl,
	type CommCareApiError,
	type CommCareCredentials,
	INVALID_DOMAIN_SLUG,
	isValidDomainSlug,
} from "./http";
import { isHqObject } from "./readCollection";
import { readHqJson } from "./readJson";

/** The most bytes of an application resource answer Nova reads: 64 MiB. */
export const HQ_APPLICATION_MAX_BYTES = 64 * 1024 * 1024;

/** One build CommCare HQ holds for an app. */
export interface HqAppBuild {
	readonly id: string;
	readonly version: number;
	readonly isReleased: boolean;
	readonly builtOn: string | null;
	readonly buildComment: string | null;
}

export interface HqApplication {
	readonly appId: string;
	readonly name: string;
	/** The save counter of the document the answer describes. */
	readonly version: number;
	/** `built_from_app_id`: null for a working app, the working app's id for a build. */
	readonly builtFromAppId: string | null;
	/**
	 * `versions`: the app's builds. Empty for a build rather than a working
	 * app (`ApplicationResource.dehydrate_versions`), so an empty list from a
	 * working app means nothing has been built.
	 */
	readonly builds: readonly HqAppBuild[];
	/** `modules` as HQ sent it, unread. `hqApplicationModules` types it. */
	readonly rawModules: readonly unknown[];
}

export interface ReadHqApplicationOptions {
	/** The most bytes of the body read. `HQ_APPLICATION_MAX_BYTES` unless given. */
	readonly maxBytes?: number;
	/** The read's own deadline. 30 seconds unless given. */
	readonly deadlineMs?: number;
	readonly cancel?: AbortSignal;
}

const MALFORMED: CommCareApiError = {
	success: false,
	status: 502,
	cause: "malformed",
};

function nonNegativeSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Read the application resource for `appId`.
 *
 * Every key the envelope requires (`id`, `name`, `version`,
 * `built_from_app_id`, `modules`, `versions`) is a declared field of
 * `ApplicationResource` that HQ dehydrates on every answer. A refused body is
 * kept, so `failure.ts::classifyHqFailure` can tell the plan refusal and the
 * cut-off from a key HQ did not accept.
 */
export async function readHqApplication(
	creds: CommCareCredentials,
	domain: string,
	appId: string,
	options: ReadHqApplicationOptions = {},
): Promise<HqApplication | CommCareApiError> {
	if (!isValidDomainSlug(domain) || !/^[\w-]+$/.test(appId))
		return INVALID_DOMAIN_SLUG;
	const result = await readHqJson(
		creds,
		`${baseUrl(creds)}/a/${domain}/api/application/v1/${encodeURIComponent(appId)}/`,
		"application",
		{
			keepRefusedBody: true,
			maxBytes: options.maxBytes ?? HQ_APPLICATION_MAX_BYTES,
			deadlineMs: options.deadlineMs,
			cancel: options.cancel,
		},
	);
	if ("success" in result) return result;
	const body = result.data;
	const malformed = (key: string): CommCareApiError => {
		log.error("[commcare] application is malformed", undefined, {
			domain,
			request: "application",
			key,
		});
		return MALFORMED;
	};
	if (!isHqObject(body)) return malformed("body");
	if (body.id !== appId) return malformed("id");
	if (typeof body.name !== "string") return malformed("name");
	if (!nonNegativeSafeInteger(body.version)) return malformed("version");
	if (
		body.built_from_app_id !== null &&
		typeof body.built_from_app_id !== "string"
	)
		return malformed("built_from_app_id");
	if (!Array.isArray(body.modules)) return malformed("modules");
	if (!Array.isArray(body.versions)) return malformed("versions");
	const builds: HqAppBuild[] = [];
	const ids = new Set<string>();
	for (const row of body.versions) {
		if (
			!isHqObject(row) ||
			typeof row.id !== "string" ||
			!/^[\w-]+$/.test(row.id) ||
			ids.has(row.id) ||
			!nonNegativeSafeInteger(row.version) ||
			typeof row.is_released !== "boolean"
		)
			return malformed("versions[]");
		ids.add(row.id);
		builds.push({
			id: row.id,
			version: row.version,
			isReleased: row.is_released,
			builtOn: typeof row.built_on === "string" ? row.built_on : null,
			buildComment:
				typeof row.build_comment === "string" ? row.build_comment : null,
		});
	}
	return {
		appId,
		name: body.name,
		version: body.version,
		builtFromAppId: body.built_from_app_id,
		builds,
		rawModules: body.modules,
	};
}

export interface HqQuestionSummary {
	/** `value`: the question's path. */
	readonly path: string;
	/** `tag`: the control's element name, or `hidden`. */
	readonly tag: string;
	/** `type`: HQ's name for the question's kind, null where HQ inferred none. */
	readonly type: string | null;
	readonly repeat: string | null;
	readonly group: string | null;
	readonly isGroup: boolean;
	/** Null on a node with no control, where HQ sends no `required`. */
	readonly required: boolean | null;
	readonly relevant: string | null;
	readonly constraint: string | null;
	/** HQ sends `calculate` for a node with no control only. */
	readonly calculate: string | null;
	readonly setvalue: string | null;
	/** `translations`: the label per language code, where HQ found one. */
	readonly labelTranslations: Readonly<Record<string, string>>;
	/** `options`, for a select with inline choices; null otherwise. */
	readonly options:
		| readonly {
				readonly value: string;
				readonly labelTranslations: Readonly<Record<string, string>>;
		  }[]
		| null;
}

export interface HqApplicationForm {
	/** The form's real `unique_id`, the one HQ stores. */
	readonly uniqueId: string;
	/**
	 * `xmlns` as the resource reports it. For a shadow form that is its parent's, and null where
	 * the parent is gone (`models/forms.py::ShadowForm.xmlns`).
	 */
	readonly xmlns: string | null;
	readonly questions: readonly HqQuestionSummary[];
}

export type HqApplicationModule =
	| {
			readonly kind: "summarized";
			/** `unique_id` as stored; null where the menu stores none (absent, null or `""`). */
			readonly uniqueId: string | null;
			readonly caseType: string | null;
			readonly forms: readonly HqApplicationForm[];
	  }
	/** HQ could not summarize this menu; `message` is its own text. */
	| { readonly kind: "error"; readonly message: string };

/** A string, or null where the key is null or absent; `undefined` for anything else. */
function optionalText(value: unknown): string | null | undefined {
	if (value === undefined || value === null) return null;
	return typeof value === "string" ? value : undefined;
}

/** An object of strings, `{}` where absent; `undefined` for anything else. */
function stringBag(
	value: unknown,
	absent: "empty" | "refuse",
): Readonly<Record<string, string>> | undefined {
	if (value === undefined) return absent === "empty" ? {} : undefined;
	if (
		!isHqObject(value) ||
		!Object.values(value).every((text) => typeof text === "string")
	)
		return undefined;
	return value as Record<string, string>;
}

/**
 * One question as `app_manager/xform.py::XForm.get_questions` summarized it,
 * or null where it is not what that method writes. Keys it does not name
 * (`label`, `label_ref`, `comment`, `hashtagValue`, `data_source`,
 * `constraintMsg_ref`, the stock keys) are not read.
 */
function questionSummary(value: unknown): HqQuestionSummary | null {
	if (
		!isHqObject(value) ||
		typeof value.value !== "string" ||
		typeof value.tag !== "string"
	)
		return null;
	const type = optionalText(value.type);
	const repeat = optionalText(value.repeat);
	const group = optionalText(value.group);
	const relevant = optionalText(value.relevant);
	const constraint = optionalText(value.constraint);
	const calculate = optionalText(value.calculate);
	const setvalue = optionalText(value.setvalue);
	if (
		type === undefined ||
		repeat === undefined ||
		group === undefined ||
		relevant === undefined ||
		constraint === undefined ||
		calculate === undefined ||
		setvalue === undefined
	)
		return null;
	if (value.is_group !== undefined && typeof value.is_group !== "boolean")
		return null;
	if (value.required !== undefined && typeof value.required !== "boolean")
		return null;
	const labelTranslations = stringBag(value.translations, "empty");
	if (labelTranslations === undefined) return null;
	let options: HqQuestionSummary["options"] = null;
	if (value.options !== undefined) {
		if (!Array.isArray(value.options)) return null;
		const read: {
			value: string;
			labelTranslations: Readonly<Record<string, string>>;
		}[] = [];
		for (const option of value.options) {
			if (!isHqObject(option) || typeof option.value !== "string") return null;
			const translations = stringBag(option.translations, "refuse");
			if (translations === undefined) return null;
			read.push({ value: option.value, labelTranslations: translations });
		}
		options = read;
	}
	return {
		path: value.value,
		tag: value.tag,
		type,
		repeat,
		group,
		isGroup: value.is_group === true,
		required: typeof value.required === "boolean" ? value.required : null,
		relevant,
		constraint,
		calculate,
		setvalue,
		labelTranslations,
		options,
	};
}

/**
 * The typed modules, in HQ's order, or where the answer stopped being readable.
 *
 * `ApplicationResource.dehydrate_module` wraps its whole body in
 * `try/except Exception` and returns `{'error': str(e)}`, so an entry is
 * either exactly that, read as `{ kind: "error" }`, or HQ's summary of the
 * menu. It writes `module.unique_id` as stored, so a menu that stores none
 * is summarized with a null one. A mirror menu is summarized with its source
 * menu's case type and no forms, and a shadow form with its parent's `xmlns`
 * and its parent's questions.
 */
export function hqApplicationModules(
	application: HqApplication,
): readonly HqApplicationModule[] | { readonly malformedAt: string } {
	const malformedAt = (path: string) => {
		log.error("[commcare] application modules are malformed", undefined, {
			request: "application",
			appId: application.appId,
			path,
		});
		return { malformedAt: path };
	};
	const modules: HqApplicationModule[] = [];
	for (const [i, entry] of application.rawModules.entries()) {
		const at = `modules[${i}]`;
		if (!isHqObject(entry)) return malformedAt(at);
		if (Object.hasOwn(entry, "error")) {
			if (Object.keys(entry).length !== 1 || typeof entry.error !== "string")
				return malformedAt(at);
			modules.push({ kind: "error", message: entry.error });
			continue;
		}
		const uniqueId = entry.unique_id;
		if (
			uniqueId !== undefined &&
			uniqueId !== null &&
			typeof uniqueId !== "string"
		)
			return malformedAt(at);
		if (entry.case_type !== null && typeof entry.case_type !== "string")
			return malformedAt(at);
		if (!Array.isArray(entry.forms)) return malformedAt(at);
		const forms: HqApplicationForm[] = [];
		for (const [j, form] of entry.forms.entries()) {
			const formAt = `${at}.forms[${j}]`;
			if (
				!isHqObject(form) ||
				typeof form.unique_id !== "string" ||
				(form.xmlns !== null && typeof form.xmlns !== "string") ||
				!Array.isArray(form.questions)
			)
				return malformedAt(formAt);
			const questions: HqQuestionSummary[] = [];
			for (const [k, question] of form.questions.entries()) {
				const summary = questionSummary(question);
				if (summary === null) return malformedAt(`${formAt}.questions[${k}]`);
				questions.push(summary);
			}
			forms.push({ uniqueId: form.unique_id, xmlns: form.xmlns, questions });
		}
		modules.push({
			kind: "summarized",
			uniqueId:
				typeof uniqueId === "string" && uniqueId !== "" ? uniqueId : null,
			caseType: entry.case_type,
			forms,
		});
	}
	return modules;
}
