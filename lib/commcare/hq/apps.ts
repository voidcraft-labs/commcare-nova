import "server-only";

/**
 * A project space's apps, and whether its plan and the account let a key
 * read them through HQ's API.
 *
 * The app list is `views/cli.py::list_apps` (`@json_error`, `@api_auth()`,
 * `@api_throttle`): membership alone, no Edit Apps and no API access. It
 * reads `domain/models.py::Domain.applications` over the view
 * `applications_brief/map.js`, which holds documents whose `doc_type` is
 * `Application`, `RemoteApp` or `LinkedApplication` and whose `copy_of` is
 * null: working apps only, no build and no deleted app, sorted by name. Each
 * row carries `app_id`, `name`, `version` and `download_url`, so no row says
 * that an app is linked or remote, when it was edited, or whether it is
 * built.
 *
 * The API access check is one row of the lookup table list
 * (`fixtures/resources/v0_1.py::LookupTableResource`), the cheapest resource
 * behind `api/resources/__init__.py::HqBaseResource.dispatch`, which makes
 * the plan check for every resource alike.
 */

import { log } from "@/lib/logger";
import { classifyHqFailure, type HqFailure } from "./failure";
import {
	baseUrl,
	type CommCareApiError,
	type CommCareCredentials,
	INVALID_DOMAIN_SLUG,
	isValidDomainSlug,
} from "./http";
import { isHqObject } from "./readCollection";
import { readHqJson } from "./readJson";

export interface HqAppListing {
	/** HQ's id of the working app. */
	readonly appId: string;
	readonly name: string;
	/** The working app's save counter, the one `current_app_version` and the resource report. */
	readonly version: number;
}

/** The most bytes of the app list Nova reads: 4 MiB. */
export const HQ_APP_LIST_MAX_BYTES = 4 * 1024 * 1024;

const MALFORMED: CommCareApiError = {
	success: false,
	status: 502,
	cause: "malformed",
};

/**
 * The list's envelope, checked and no further: `{status: "success", applications: [...]}`, with the
 * rows unread. What proves a key reaches a project space's apps.
 */
export async function readHqAppListEnvelope(
	creds: CommCareCredentials,
	domain: string,
	options: { readonly cancel?: AbortSignal } = {},
): Promise<{ readonly applications: readonly unknown[] } | CommCareApiError> {
	if (!isValidDomainSlug(domain)) return INVALID_DOMAIN_SLUG;
	const result = await readHqJson(
		creds,
		`${baseUrl(creds)}/a/${domain}/apps/api/list_apps/`,
		"app list",
		{ maxBytes: HQ_APP_LIST_MAX_BYTES, cancel: options.cancel },
	);
	if ("success" in result) return result;
	const body = result.data;
	if (
		!isHqObject(body) ||
		body.status !== "success" ||
		!Array.isArray(body.applications)
	) {
		log.error("[commcare] app list is malformed", undefined, {
			domain,
			request: "app-list",
		});
		return MALFORMED;
	}
	return { applications: body.applications };
}

/** Every working app of the project space, in HQ's order (by name). */
export async function listHqApps(
	creds: CommCareCredentials,
	domain: string,
	options: { readonly cancel?: AbortSignal } = {},
): Promise<readonly HqAppListing[] | CommCareApiError> {
	const envelope = await readHqAppListEnvelope(creds, domain, options);
	if ("success" in envelope) return envelope;
	const listings: HqAppListing[] = [];
	const ids = new Set<string>();
	for (const [index, row] of envelope.applications.entries()) {
		/* `download_url` is dropped unread. */
		if (
			!isHqObject(row) ||
			typeof row.app_id !== "string" ||
			!/^[\w-]+$/.test(row.app_id) ||
			ids.has(row.app_id) ||
			typeof row.name !== "string" ||
			typeof row.version !== "number" ||
			!Number.isSafeInteger(row.version) ||
			row.version < 0
		) {
			log.error("[commcare] app list row is malformed", undefined, {
				domain,
				request: "app-list",
				index,
			});
			return MALFORMED;
		}
		ids.add(row.app_id);
		listings.push({ appId: row.app_id, name: row.name, version: row.version });
	}
	return listings;
}

export type HqApiAccess =
	| { readonly kind: "available" }
	| { readonly kind: "plan-lacks-api-access" }
	| { readonly kind: "account-lacks-access-apis" }
	| { readonly kind: "failed"; readonly failure: HqFailure };

/** The most bytes of the probe's one-row answer Nova reads: 1 MiB. */
export const HQ_API_ACCESS_PROBE_MAX_BYTES = 1024 * 1024;

/**
 * Whether the project space's plan has API access and the account Access
 * APIs, asked of the lookup table list for one row.
 *
 * Called after `listHqApps` answered for the same project space, so the key
 * is a member's: a 403 is the account's missing Access APIs, never lost
 * membership. The application resource classifies the same refusals again
 * when it is read, so a plan that changed since is still told truthfully.
 */
export async function probeHqApiAccess(
	creds: CommCareCredentials,
	domain: string,
): Promise<HqApiAccess> {
	const failed = (error: CommCareApiError): HqApiAccess => {
		const failure = classifyHqFailure(error, "api-access", { member: true });
		if (failure.kind === "plan-lacks-api-access")
			return { kind: "plan-lacks-api-access" };
		if (failure.kind === "permission")
			return { kind: "account-lacks-access-apis" };
		return { kind: "failed", failure };
	};
	if (!isValidDomainSlug(domain)) return failed(INVALID_DOMAIN_SLUG);
	const result = await readHqJson(
		creds,
		`${baseUrl(creds)}/a/${domain}/api/lookup_table/v1/?limit=1`,
		"API access",
		{ keepRefusedBody: true, maxBytes: HQ_API_ACCESS_PROBE_MAX_BYTES },
	);
	if ("success" in result) return failed(result);
	const body = result.data;
	if (
		!isHqObject(body) ||
		!isHqObject(body.meta) ||
		!Array.isArray(body.objects)
	) {
		log.error("[commcare] API access answer is malformed", undefined, {
			domain,
			request: "api-access",
		});
		return failed(MALFORMED);
	}
	return { kind: "available" };
}
