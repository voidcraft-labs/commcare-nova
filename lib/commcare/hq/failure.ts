import "server-only";

/**
 * What a failed answer of CommCare HQ is, and the circumstance it is for a
 * read.
 *
 * Every reader returns a `CommCareApiError`; `classifyHqFailure` gives it one
 * kind, by its cause first and its status after, and `hqReadCircumstance`
 * words the kind for what was asked, so a failed table read is never worded
 * as a missing app. Pure: neither function reads anything but its arguments.
 */

import type { ReadCircumstance } from "@/lib/publish/hqFindings";
import { apiRefusalSentence, type CommCareApiError } from "./http";

export const HQ_FAILURE_KINDS = [
	"gateway-refused",
	"key-not-accepted",
	"plan-lacks-api-access",
	"api-cut-off",
	"not-a-member",
	"permission",
	"not-found",
	"rate-limited",
	"hq-unavailable",
	"timed-out",
	"too-large",
	"browser-only",
	"answer-unreadable",
	"refused",
] as const;
export type HqFailureKind = (typeof HQ_FAILURE_KINDS)[number];

/** What was asked of HQ. `app-import` is the one write, for the publish ladder. */
export const HQ_REQUEST_KINDS = [
	"project-spaces",
	"app-list",
	"api-access",
	"application",
	"app-source",
	"app-version",
	"lookup-tables",
	"lookup-rows",
	"location-types",
	"locations",
	"media-file",
	"app-import",
] as const;
export type HqRequestKind = (typeof HQ_REQUEST_KINDS)[number];

/** What the account lacks, where a 403 says so. */
export type HqPermissionNeed =
	| "edit-apps"
	| "access-apis"
	| "edit-apps-and-access-apis"
	| "locations";

interface HqFailureOf<K extends HqFailureKind> {
	readonly kind: K;
	readonly request: HqRequestKind;
	/** The status HQ, its edge or the reader gave. */
	readonly status: number;
}

/** One failed answer: its kind, what was asked, and, exactly where `kind` is `permission`, what the account lacks. */
export type HqFailure =
	| (HqFailureOf<Exclude<HqFailureKind, "permission">> & {
			readonly permission?: undefined;
	  })
	| (HqFailureOf<"permission"> & { readonly permission: HqPermissionNeed });

/**
 * What a 403 is, by what was asked. A non-member's 403 is
 * `domain/decorators.py::_login_or_challenge`'s, before any permission is
 * asked; the permission each read then asks is its view's or resource's.
 */
const FORBIDDEN_BY_REQUEST: Readonly<
	Record<HqRequestKind, "refused" | "not-a-member" | HqPermissionNeed>
> = {
	/* `api/resources/v0_5.py::UserDomainsResource` names no project space. */
	"project-spaces": "refused",
	/* These views ask no permission beyond membership. */
	"app-list": "not-a-member",
	"app-version": "not-a-member",
	/* `require_can_edit_apps`. */
	"app-source": "edit-apps",
	"app-import": "edit-apps",
	/* `LoginAndDomainAuthentication` runs `require_api_permission('access_api')`. */
	"api-access": "access-apis",
	application: "access-apis",
	"lookup-tables": "access-apis",
	/* `FixtureResource.Meta.authentication` is `RequirePermissionAuthentication(edit_apps)`, which adds `access_api`. */
	"lookup-rows": "edit-apps-and-access-apis",
	/* The plan's Locations or the account's Edit Locations, which HQ does not tell apart. */
	"location-types": "locations",
	locations: "locations",
	/* The media read holds a status and bytes, and reads nothing into a refusal. */
	"media-file": "refused",
};

/**
 * The kind of a failed answer, by the first rule that matches: the edge,
 * then the reader's own cause, then HQ's status. `member` is whether the
 * same credential's `list_apps` answered for this project space moments
 * before; it tells a 403's lost membership from a missing permission, and a
 * 401's plan sentence from a project space the key cannot reach or that is
 * gone. A caller that has not asked leaves it out, and reads the plan
 * sentence as the plan: every such caller reads a project space a publish or
 * a list answered for.
 */
export function classifyHqFailure(
	error: CommCareApiError,
	request: HqRequestKind,
	options: { readonly member?: boolean } = {},
): HqFailure {
	const { status } = error;
	const of = (kind: Exclude<HqFailureKind, "permission">): HqFailure => ({
		kind,
		request,
		status,
	});
	if (error.edgeRefusal === true) return of("gateway-refused");
	if (error.cause === "timeout") return of("timed-out");
	if (error.cause === "network") return of("hq-unavailable");
	if (error.cause === "too-large") return of("too-large");
	if (error.cause === "browser-page" || (status >= 300 && status <= 399))
		return of("browser-only");
	if (error.cause === "malformed") return of("answer-unreadable");
	if (status === 401) {
		const sentence = apiRefusalSentence(error);
		/* `HqBaseResource.dispatch` checks the plan before it asks who is
		 * calling, and a project space that does not exist has the default
		 * plan, which has no API access. So the plan sentence is about the
		 * plan only for a member: a caller that knows the list refused its
		 * key says so, and the sentence is then lost membership or a project
		 * space that is gone. */
		if (sentence === "plan")
			return of(
				options.member === false ? "not-a-member" : "plan-lacks-api-access",
			);
		if (sentence === "cut-off") return of("api-cut-off");
		return of("key-not-accepted");
	}
	if (status === 403) {
		const forbidden = FORBIDDEN_BY_REQUEST[request];
		if (forbidden === "refused" || forbidden === "not-a-member")
			return of(forbidden);
		if (options.member === false) return of("not-a-member");
		return { kind: "permission", request, status, permission: forbidden };
	}
	if (status === 404) return of("not-found");
	if (status === 429) return of("rate-limited");
	if (status >= 500) return of("hq-unavailable");
	return of("refused");
}

/** The requests whose 404 says the app itself is not there. */
const APP_REQUESTS: ReadonlySet<HqRequestKind> = new Set([
	"application",
	"app-source",
	"app-version",
]);

/** The requests whose body is the app, so a body over the bound is the app's size. */
const APP_BODY_REQUESTS: ReadonlySet<HqRequestKind> = new Set([
	"application",
	"app-source",
]);

const PERMISSION_CIRCUMSTANCE: Readonly<
	Record<HqPermissionNeed, ReadCircumstance>
> = {
	"edit-apps": "cannot-edit-apps",
	"access-apis": "cannot-access-apis",
	/* A bring-in reaches the rows after the application resource answered
	 * with Access APIs, so Edit Apps is the one that can have gone. */
	"edit-apps-and-access-apis": "cannot-edit-apps",
	locations: "cannot-read-organization",
};

/** The `READ_CIRCUMSTANCES` code a failed read of HQ is, by its kind and by what was asked. */
export function hqReadCircumstance(failure: HqFailure): ReadCircumstance {
	switch (failure.kind) {
		case "gateway-refused":
			return "hq-gateway-refused";
		case "key-not-accepted":
		case "plan-lacks-api-access":
		case "api-cut-off":
		case "not-a-member":
		case "rate-limited":
		case "browser-only":
			return failure.kind;
		case "permission":
			return PERMISSION_CIRCUMSTANCE[failure.permission];
		/* A table, row, level or place gone during the read changed under it;
		 * the next read reads the lists afresh. A project space that is gone
		 * gives no 404 to a key: its function views answer 403 and its
		 * resources the plan sentence (`domain/decorators.py::_login_or_challenge`,
		 * `HqBaseResource.dispatch`), so a 404 on a list of the project space
		 * itself is a route CommCare HQ no longer serves, which is an answer
		 * Nova could not read. */
		case "not-found":
			return APP_REQUESTS.has(failure.request) ? "app-gone" : "hq-unavailable";
		/* `too-large` words the app itself; a long list is no app. */
		case "too-large":
			return APP_BODY_REQUESTS.has(failure.request)
				? "too-large"
				: "hq-unavailable";
		case "hq-unavailable":
		case "timed-out":
		case "answer-unreadable":
		case "refused":
			return "hq-unavailable";
	}
}
