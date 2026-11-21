/**
 * CommCare HQ REST API client — server-side only.
 *
 * Handles authenticated requests to CommCare HQ for listing project spaces,
 * importing apps, and uploading an imported app's media bytes. All calls go
 * through our API routes (never from the client browser) so the user's API
 * key stays server-side.
 *
 * Error handling: the client returns `{ success: false, status }` on failure.
 * It does NOT compose user-facing messages — callers know their own context
 * and decide what to show. The raw response body is logged server-side for
 * debugging only.
 *
 * API reference (from dimagi/commcare-hq#37559, update support + endpoint
 * decorators from dimagi/commcare-hq#37972):
 *   - User domains:   GET  /api/user_domains/v1/
 *   - App import:     POST /a/{domain}/apps/api/import_app/                 (optional app_id = update in place)
 *   - Media upload:   POST /a/{domain}/apps/api/{app_id}/multimedia/        (bulk ZIP)
 *   - Media status:   GET  /a/{domain}/apps/api/{app_id}/multimedia/status/{processing_id}/
 *
 * Authentication uses CommCare's API key format:
 *   Authorization: ApiKey {username}:{api_key}
 *
 * The media upload uses the bulk `upload_multimedia_api` endpoint (same
 * `@api_auth()` gate as import) — NOT the per-kind `multimedia/uploaded/{kind}/`
 * endpoints, which are session-only and reject the API key. See
 * `uploadAppMediaBundle`.
 */

import { log } from "@/lib/logger";
import {
	type ProjectSpaceAdvisoryId,
	type ProjectSpaceAdvisoryProbe,
	type ProjectSpaceCapabilityProbe,
	projectSpaceCompatibilityForNonMember,
	projectSpaceCompatibilityForTarget,
} from "@/lib/publish/projectSpaceCompatibility";
import { profileReferencesBuildSuite } from "./buildProfile";
import { readHqAppListEnvelope } from "./hq/apps";
import {
	HQ_APP_VERSIONS_MAX_BYTES,
	HQ_BUILD_RESOURCE_MAX_BYTES,
	HQ_IMPORT_ACK_MAX_BYTES,
	HQ_MEDIA_BUNDLE_ACK_MAX_BYTES,
	HQ_MEDIA_BUNDLE_STATUS_MAX_BYTES,
	HQ_PROJECT_SPACE_LIST_MAX_BYTES,
	HQ_PROJECT_SPACE_LIST_MAX_ROWS,
} from "./hq/bounds";
import { type HqReadDeadline, withHqRequestDeadline } from "./hq/deadline";
import { classifyHqFailure, type HqFailure } from "./hq/failure";
import {
	baseUrl,
	type CommCareApiError,
	type CommCareCredentials,
	delay,
	HQ_MALFORMED_ANSWER,
	type HqAnswer,
	hqTextFacts,
	isEdgeRefusal,
	isHqCount,
	isValidDomainSlug,
	logAndReturnError,
	readAnswerJson,
	readRefusedBody,
	retryAfterMs,
	sendHq,
	WAF_PADDING,
	warnAndReturnError,
} from "./hq/http";
import { isHqObject, readHqCollection } from "./hq/readCollection";
import { readHqJson } from "./hq/readJson";
import { HQ_THROTTLE_MAX_WAIT_MS } from "./hq/throttle";
/** Private compatibility inputs stay behind the CommCare boundary: the probe
 * takes its plan as data, and the one flag this client reads by name comes
 * from `hqPrivateFeatureFlag`, so its slug is the probe's own. */
import type {
	HqPrivateFeatureFlagRequirement,
	HqProjectSpaceAdvisoryProbePlan,
	HqProjectSpaceCapabilityProbePlan,
	HqProjectSpaceCompatibilityProbePlan,
} from "./projectSpaceCompatibility";
import { hqPrivateFeatureFlag } from "./projectSpaceCompatibility";
import { domainFeatureFlag } from "./surface/gates";

/* The HQ wire primitives live in `./hq/http` so every driver shares one
 * base-URL catalog, one auth scheme, and one WAF padding field. They are
 * re-exported here because this module was their home first and a great
 * many callers import them by this path; the definitions are not
 * duplicated. */
export type { HqAppBuild } from "./hq/application";
export type { CommCareApiError, CommCareCredentials } from "./hq/http";
export { isValidDomainSlug } from "./hq/http";

// ── Types ──────────────────────────────────────────────────────────

/** A CommCare project space the user has access to. */
export interface CommCareDomain {
	/** URL-safe domain slug (used in API paths). */
	name: string;
	/** Human-readable project name. */
	displayName: string;
}

/** Successful app import result. */
export interface ImportResult {
	success: true;
	/** CommCare HQ application ID for the created or updated app. */
	appId: string;
	/**
	 * The HQ app's version after an in-place update; null on create (HQ's
	 * create response carries no version).
	 */
	version: number | null;
	/** Optional import warnings (e.g. missing multimedia). */
	warnings: string[];
}

/** Union result type for import operations. */
export type ImportResponse = ImportResult | CommCareApiError;

// ── Client ─────────────────────────────────────────────────────────

/**
 * List all project spaces (domains) the authenticated user has access to.
 *
 * CommCare HQ's `/api/user_domains/v1/` endpoint correctly scopes results
 * to domains where the user has membership. If the API key is domain-scoped,
 * only that single domain is returned.
 *
 * Current HQ returns the complete set in one page through
 * `DoesNothingPaginator`, which names only `total_count`. The shared list
 * reader asks any later page by its own offset on the same URL, so the
 * `feature_flag` filter holds on every page.
 */
export async function listDomains(
	creds: CommCareCredentials,
): Promise<CommCareDomain[] | CommCareApiError> {
	return listDomainsMatching(creds);
}

/**
 * The user-domains endpoint doubles as HQ's only feature-flag probe. Passing
 * `feature_flag` returns only domains for which that registered toggle is
 * enabled. Unknown/retired slugs return 400 — deliberately preserved as an
 * unavailable diagnostic rather than misreported as "off".
 */
async function listDomainsMatching(
	creds: CommCareCredentials,
	featureFlag?: string,
	within?: HqReadDeadline,
): Promise<CommCareDomain[] | CommCareApiError> {
	const query = new URLSearchParams({ limit: "100" });
	if (featureFlag) query.set("feature_flag", featureFlag);
	const list = await readHqCollection(creds, {
		label: "project space list",
		firstUrl: `${baseUrl(creds)}/api/user_domains/v1/?${query.toString()}`,
		maxPages: 51,
		maxRows: HQ_PROJECT_SPACE_LIST_MAX_ROWS,
		maxBytes: HQ_PROJECT_SPACE_LIST_MAX_BYTES,
		row: toCommCareDomain,
		identity: (domain) => domain.name,
		...(within !== undefined && { deadline: within }),
	});
	if ("success" in list) return list;
	/* A list past Nova's bound cannot say a project space is absent. */
	if ("kind" in list)
		return { success: false, status: 502, cause: "too-large" };
	return [...list.rows];
}

/** One row of `UserDomainsResource`, or null where it is not one. */
function toCommCareDomain(value: unknown): CommCareDomain | null {
	if (
		!isHqObject(value) ||
		typeof value.domain_name !== "string" ||
		!isValidDomainSlug(value.domain_name) ||
		(typeof value.project_name !== "string" && value.project_name !== null)
	)
		return null;
	return {
		name: value.domain_name,
		displayName: value.project_name || value.domain_name,
	};
}

export interface HqProjectSpaceCompatibilityProbeResult {
	readonly capabilities: readonly ProjectSpaceCapabilityProbe[];
	readonly advisories: readonly ProjectSpaceAdvisoryProbe[];
	readonly availableAdvisories: readonly ProjectSpaceAdvisoryId[];
	readonly report: ReturnType<typeof projectSpaceCompatibilityForTarget>;
	/**
	 * Whether the project space holds `USH_EMPTY_CASE_LIST_TEXT`, under which
	 * HQ's build gives every case list an empty-list text. `null` when the
	 * read was not asked for, when the unfiltered list did not hold the
	 * target, or when the filtered read failed. It never changes a verdict.
	 */
	readonly emptyCaseListText: boolean | null;
}

export interface HqProjectSpaceCompatibilityProbeOptions {
	/**
	 * Also read `USH_EMPTY_CASE_LIST_TEXT` for the target, whatever the plan
	 * holds: a publish stores the answer with the deployment, and a `.ccz`
	 * made for it writes the empty-list text exactly where HQ's build there
	 * does.
	 */
	readonly readEmptyCaseListText?: boolean;
}

/**
 * Check the private HQ prerequisites behind the app's semantic capabilities.
 *
 * Every private check settles to available, missing, or unverified. A required
 * capability is missing when any exact prerequisite is confirmed missing, and
 * unverified when none is missing but at least one check could not complete.
 * Callers serialize only the semantic result, never the probe plan.
 */
export async function probeHqProjectSpaceCompatibility(
	creds: CommCareCredentials,
	domain: string,
	plan: HqProjectSpaceCompatibilityProbePlan,
	options: HqProjectSpaceCompatibilityProbeOptions = {},
): Promise<HqProjectSpaceCompatibilityProbeResult> {
	const readEmptyCaseListText = options.readEmptyCaseListText === true;
	if (
		!readEmptyCaseListText &&
		plan.capabilities.length === 0 &&
		plan.advisories.length === 0
	) {
		return {
			capabilities: [],
			advisories: [],
			availableAdvisories: [],
			report: projectSpaceCompatibilityForTarget(domain, [], []),
			emptyCaseListText: null,
		};
	}
	if (!isValidDomainSlug(domain)) {
		return unverifiedProjectSpaceResult(domain, plan);
	}

	// An empty filtered response only proves a flag is missing when the same
	// credentials can still see the target in the unfiltered endpoint. Stored
	// domain approvals can become stale after HQ membership changes; without
	// this guard, losing access would be misreported as every flag being off.
	try {
		const visibleDomains = await runBoundedCompatibilityProbe((within) =>
			listDomainsMatching(creds, undefined, within),
		);
		if (!Array.isArray(visibleDomains)) {
			log.warn(
				"[commcare/project-space] target domain unavailable to live credentials",
				{ domain, status: visibleDomains.status },
			);
			return unverifiedProjectSpaceResult(domain, plan);
		}
		/* HQ's list answered and does not hold the target: the connected
		 * account is no longer a member (`api/resources/v0_5.py::UserDomainsResource`
		 * lists only the spaces a user belongs to). A filtered read would
		 * then miss the target too, so no flag's answer means anything. */
		if (!visibleDomains.some((candidate) => candidate.name === domain)) {
			log.warn("[commcare/project-space] connected account left the target", {
				domain,
			});
			return notAMemberProjectSpaceResult(domain, plan);
		}
	} catch (error) {
		log.warn("[commcare/project-space] live domain check threw", {
			domain,
			error,
		});
		return unverifiedProjectSpaceResult(domain, plan);
	}

	const allPlans = [...plan.capabilities, ...plan.advisories];
	const privateFlags = new Map<string, HqPrivateFeatureFlagRequirement>();
	for (const item of allPlans) {
		for (const flag of [...item.featureFlags, ...item.featureFlagsOff]) {
			privateFlags.set(flag.id, flag);
		}
	}
	const needsCaseSearchRuntime = allPlans.some((item) =>
		item.runtimeProbes.includes("case-search"),
	);
	const [flagEntries, caseSearchRuntime, emptyCaseListTextState] =
		await Promise.all([
			Promise.all(
				[...privateFlags.values()].map(
					async (flag) =>
						[
							flag.id,
							await probePrivateFeatureFlag(creds, domain, flag),
						] as const,
				),
			),
			needsCaseSearchRuntime
				? probeCaseSearchRuntime(creds, domain)
				: Promise.resolve(undefined),
			readEmptyCaseListText
				? probePrivateFeatureFlag(creds, domain, EMPTY_CASE_LIST_TEXT_FLAG)
				: Promise.resolve(undefined),
		]);
	const flagResults = new Map(flagEntries);

	const capabilities: ProjectSpaceCapabilityProbe[] = plan.capabilities.map(
		(item) => ({
			capability: item.capability,
			...aggregatePrivateProbeState(item, flagResults, caseSearchRuntime),
		}),
	);
	const advisories: ProjectSpaceAdvisoryProbe[] = plan.advisories.map(
		(item) => ({
			advisory: item.advisory,
			state: aggregatePrivateProbeState(item, flagResults, caseSearchRuntime)
				.state,
		}),
	);
	return {
		capabilities,
		advisories,
		availableAdvisories: advisories.flatMap((item) =>
			item.state === "available" ? [item.advisory.id] : [],
		),
		report: projectSpaceCompatibilityForTarget(
			domain,
			capabilities,
			advisories,
		),
		emptyCaseListText:
			emptyCaseListTextState === "available"
				? true
				: emptyCaseListTextState === "missing"
					? false
					: null,
	};
}

/**
 * `USH_EMPTY_CASE_LIST_TEXT`, a flag HQ keys by project space alone, so a
 * filtered list that holds the target is the project space's own flag and
 * never the publisher's (`toggles/__init__.py`, `namespaces=[NAMESPACE_DOMAIN]`).
 */
const EMPTY_CASE_LIST_TEXT_FLAG = (() => {
	const flag = domainFeatureFlag("USH_EMPTY_CASE_LIST_TEXT");
	return {
		id: "empty-case-list-text",
		slug: flag.slug,
		namespace: flag.namespace,
	} as const;
})();

type PrivateProbeState = "available" | "missing" | "unverified";
type PrivateProbeAssessment = {
	readonly state: PrivateProbeState;
	readonly issue?: NonNullable<ProjectSpaceCapabilityProbe["issue"]>;
};

async function probePrivateFeatureFlag(
	creds: CommCareCredentials,
	domain: string,
	requirement: Omit<HqPrivateFeatureFlagRequirement, "id"> & {
		readonly id: string;
	},
): Promise<PrivateProbeState> {
	if (requirement.namespace !== "domain") {
		log.warn("[commcare/project-space] unsafe private probe namespace", {
			domain,
			probe: requirement.id,
		});
		return "unverified";
	}

	try {
		const enabledDomains = await runBoundedCompatibilityProbe((within) =>
			listDomainsMatching(creds, requirement.slug, within),
		);
		if (!Array.isArray(enabledDomains)) {
			log.warn("[commcare/project-space] private probe unavailable", {
				domain,
				probe: requirement.id,
				status: enabledDomains.status,
			});
			return "unverified";
		}
		return enabledDomains.some((candidate) => candidate.name === domain)
			? "available"
			: "missing";
	} catch (error) {
		log.warn("[commcare/project-space] private probe threw", {
			domain,
			probe: requirement.id,
			error,
		});
		return "unverified";
	}
}

/**
 * A GET no answer began for, its connection closed or never opened, sent once
 * more at once, as `hq/readJson.ts::readHqJson` sends a read: native fetch
 * sends nothing again by itself, so a kept-alive connection CommCare HQ closed
 * as the request went out on it would otherwise fail it. A send the signal
 * ended is no lost answer and goes out no more. Only a GET goes through here.
 */
async function getResendingUnanswered(
	send: () => Promise<HqAnswer>,
	signal: AbortSignal,
	label: string,
	domain: string,
): Promise<HqAnswer> {
	try {
		return await send();
	} catch (error) {
		if (signal.aborted) throw error;
		log.warn(`[commcare] ${label} not answered, sending again`, {
			domain,
			request: label,
			error,
		});
		return send();
	}
}

const CASE_SEARCH_DISABLED_RESPONSE =
	"Case search is not enabled for this project";
const CASE_SEARCH_PROBE_TYPE = "__nova_compatibility_probe__";

async function probeCaseSearchRuntime(
	creds: CommCareCredentials,
	domain: string,
): Promise<PrivateProbeAssessment> {
	try {
		return await runBoundedCompatibilityProbe(async ({ signal }) => {
			const query = new URLSearchParams({ case_type: CASE_SEARCH_PROBE_TYPE });
			const url = `${baseUrl(creds)}/a/${domain}/phone/search/?${query.toString()}`;
			const response = await getResendingUnanswered(
				() => sendHq(creds, url, { signal }),
				signal,
				"Case search runtime probe",
				domain,
			);
			if (response.status === 200) {
				// HQ emits a fixture as text/xml. Headers distinguish the runtime
				// answer from a successful HTML login/proxy page without reading
				// any case data. application/xml is the equivalent XML media type.
				const mediaType = response
					.header("content-type")
					?.split(";")[0]
					.trim()
					.toLowerCase();
				await response.discard();
				return {
					state:
						mediaType === "text/xml" || mediaType === "application/xml"
							? "available"
							: "unverified",
				};
			}
			if (response.status === 404) {
				const body = await readRefusedBody(response);
				return {
					state:
						body.kind === "text" &&
						body.whole &&
						body.text === CASE_SEARCH_DISABLED_RESPONSE
							? "missing"
							: "unverified",
				};
			}
			if (response.status === 403) {
				/* HQ's exact readiness path is a mobile runtime endpoint. A web
				 * account may be allowed to edit/import apps while this separate
				 * role permission is absent. Diagnose that recoverable distinction;
				 * never reinterpret it as Case Search being disabled. */
				const body = await readRefusedBody(response);
				return {
					state: "unverified",
					...(body.kind === "unavailable" || isEdgeRefusal(body.text)
						? {}
						: { issue: "connected-account-permission" as const }),
				};
			}
			await response.discard();
			return { state: "unverified" };
		});
	} catch (error) {
		log.warn("[commcare/project-space] Case search runtime probe threw", {
			domain,
			error,
		});
		return { state: "unverified" };
	}
}

function aggregatePrivateProbeState(
	plan: HqProjectSpaceCapabilityProbePlan | HqProjectSpaceAdvisoryProbePlan,
	flagResults: ReadonlyMap<string, PrivateProbeState>,
	caseSearchRuntime: PrivateProbeAssessment | undefined,
): PrivateProbeAssessment {
	const states = plan.featureFlags.map(
		(flag) => flagResults.get(flag.id) ?? "unverified",
	);
	/* A flag the app needs off reads inverted: listed (on) is missing, and
	 * not listed once the unfiltered list proved the target visible is
	 * available. An unreadable list stays unverified. */
	for (const flag of plan.featureFlagsOff) {
		const state = flagResults.get(flag.id) ?? "unverified";
		states.push(
			state === "available"
				? "missing"
				: state === "missing"
					? "available"
					: "unverified",
		);
	}
	if (plan.runtimeProbes.includes("case-search")) {
		states.push(caseSearchRuntime?.state ?? "unverified");
	}
	if (states.includes("missing")) return { state: "missing" };
	if (states.includes("unverified")) {
		return {
			state: "unverified",
			...(caseSearchRuntime?.issue === undefined
				? {}
				: { issue: caseSearchRuntime.issue }),
		};
	}
	return { state: "available" };
}

function unverifiedProjectSpaceResult(
	domain: string,
	plan: HqProjectSpaceCompatibilityProbePlan,
): HqProjectSpaceCompatibilityProbeResult {
	const capabilities: ProjectSpaceCapabilityProbe[] = plan.capabilities.map(
		(item) => ({
			capability: item.capability,
			state: "unverified",
		}),
	);
	const advisories: ProjectSpaceAdvisoryProbe[] = plan.advisories.map(
		(item) => ({
			advisory: item.advisory,
			state: "unverified",
		}),
	);
	return {
		capabilities,
		advisories,
		availableAdvisories: [],
		report: projectSpaceCompatibilityForTarget(
			domain,
			capabilities,
			advisories,
		),
		emptyCaseListText: null,
	};
}

function notAMemberProjectSpaceResult(
	domain: string,
	plan: HqProjectSpaceCompatibilityProbePlan,
): HqProjectSpaceCompatibilityProbeResult {
	const capabilities: ProjectSpaceCapabilityProbe[] = plan.capabilities.map(
		(item) => ({
			capability: item.capability,
			state: "unverified",
			issue: "not-a-member",
		}),
	);
	const advisories: ProjectSpaceAdvisoryProbe[] = plan.advisories.map(
		(item) => ({
			advisory: item.advisory,
			state: "unverified",
		}),
	);
	return {
		capabilities,
		advisories,
		availableAdvisories: [],
		report: projectSpaceCompatibilityForNonMember(
			domain,
			plan.capabilities.map((item) => item.capability),
			plan.advisories.map((item) => item.advisory),
		),
		emptyCaseListText: null,
	};
}

/** Whether CommCare HQ's builds in a project space save an answer only when the worker changed it. */
export type HqSaveOnlyEditedAnswers =
	/** The project space holds the flag: CommCare HQ's build compares before it saves. */
	| { readonly kind: "applied" }
	/** The project space does not hold it: CommCare HQ's build saves every time. */
	| { readonly kind: "not-applied" }
	/** The key's own list of project spaces answered and does not hold this one. */
	| { readonly kind: "not-a-member" }
	| { readonly kind: "failed"; readonly failure: HqFailure };

/**
 * Read the one flag that changes what a property write saved only if the
 * worker changed it means: `app_manager/xform.py::XFormCaseBlock.add_case_updates`
 * compares before it saves only where the project space holds
 * `SAVE_ONLY_EDITED_FORM_FIELDS`.
 *
 * The two reads the publish probe makes for a flag, one after the other,
 * each under the default deadline: the key's whole list of project spaces,
 * which proves the key still reaches this one, then the list filtered by the
 * flag's slug. The flag is keyed by project space alone
 * (`surface/gates.ts::domainFeatureFlag` refuses any other), so a listed
 * project space is the space's own flag. Unlike the probe, a failed read is
 * the answer, never a guess.
 */
export async function readHqSaveOnlyEditedAnswers(
	creds: CommCareCredentials,
	domain: string,
	options: { readonly cancel?: AbortSignal } = {},
): Promise<HqSaveOnlyEditedAnswers> {
	const failed = (error: CommCareApiError): HqSaveOnlyEditedAnswers => ({
		kind: "failed",
		failure: classifyHqFailure(error, "project-spaces"),
	});
	const list = (featureFlag: string | undefined) =>
		withHqRequestDeadline(
			(signal, deadline) =>
				listDomainsMatching(creds, featureFlag, { signal, deadline }),
			undefined,
			options.cancel,
		);
	const visible = await list(undefined);
	if (!Array.isArray(visible)) return failed(visible);
	if (!visible.some((candidate) => candidate.name === domain))
		return { kind: "not-a-member" };
	const flag = hqPrivateFeatureFlag("save-only-edited-answers");
	const flagged = await list(flag.slug);
	if (!Array.isArray(flagged)) {
		/* A slug HQ no longer knows answers 400, which is Nova's to fix. */
		if (flagged.status === 400 && flagged.cause === undefined)
			log.error("[commcare] feature flag list refused", undefined, {
				domain,
				request: "project-spaces",
				status: flagged.status,
			});
		return failed(flagged);
	}
	return flagged.some((candidate) => candidate.name === domain)
		? { kind: "applied" }
		: { kind: "not-applied" };
}

/** A compatibility check must never hold open the publish preflight. */
export const HQ_PROJECT_SPACE_COMPATIBILITY_PROBE_TIMEOUT_MS = 5_000;

/** Each check owns its five second deadline, handed on as the signal and its instant. */
async function runBoundedCompatibilityProbe<T>(
	probe: (within: HqReadDeadline) => Promise<T>,
): Promise<T> {
	return withHqRequestDeadline(
		(signal, deadline) => probe({ signal, deadline }),
		HQ_PROJECT_SPACE_COMPATIBILITY_PROBE_TIMEOUT_MS,
	);
}

/**
 * Test whether the API key can access a specific domain.
 *
 * Reads the app list's envelope (`hq/apps.ts::readHqAppListEnvelope`): its
 * explicit JSON success envelope proves access; ordinary 401/403 responses
 * refuse it. CommCare HQ returns 401 (not 403) for domains where the API key
 * lacks app-level access, even though the key is valid for the user_domains
 * endpoint. Since callers already validated the key via listDomains(), a
 * per-domain 401 is a scope issue, not invalid creds. Edge refusals,
 * redirects, transport failures and malformed envelopes remain unavailable
 * answers rather than silently dropping an accessible space.
 *
 * The rows are not checked: HQ passes each app's `name` and `version`
 * through as stored, discovery stops on the first error of any project
 * space, and one app Nova cannot type must not fail the save of a key that
 * reaches hundreds. For the same reason a list longer than the envelope
 * read's bound is access: `readHqJson` answers `too-large` only for a 2xx
 * body that does not open as a page, and `views/cli.py::list_apps` answers
 * 2xx with JSON only as its envelope (`@json_error` answers its errors
 * with their own status), so the list of a project space with many apps
 * proves the key reaches it without Nova holding it. A slug Nova cannot put
 * in a URL is a project space the key does not reach, never an error that
 * stops discovery.
 */
export async function testDomainAccess(
	creds: CommCareCredentials,
	domain: string,
): Promise<boolean | CommCareApiError> {
	if (!isValidDomainSlug(domain)) return false;
	const result = await readHqAppListEnvelope(creds, domain);
	if ("success" in result) {
		if (
			(result.status === 401 || result.status === 403) &&
			result.edgeRefusal !== true
		)
			return false;
		if (result.cause === "too-large") return true;
		return result;
	}
	return true;
}

/**
 * Resolve the set of project spaces the key can reach at the app level.
 *
 * `listDomains` returns every space the user belongs to that the key's scope
 * allows — but HQ returns 401 from the app-level endpoint for some of those
 * (membership without app access; see `testDomainAccess`). So we probe every
 * listed space and keep only the ones that pass.
 *
 * Probes run in a BOUNDED-concurrency window (`PROBE_CONCURRENCY` at a time),
 * not all at once. An unscoped key on a heavily-shared account (e.g. a Dimagi
 * internal user) can list hundreds of spaces; firing every probe simultaneously
 * would open hundreds of connections to HQ and self-inflict a 429 — and since
 * a 429 on any probe fails the whole discovery, that would make save/refresh
 * fail outright for exactly the largest keys. The window keeps HQ load modest
 * while still parallelizing; save/refresh are rare and not latency-critical.
 *
 * A 5xx (or 429) from `listDomains` or any probe surfaces as `CommCareApiError`
 * so the caller can tell "HQ is down / throttling" from "the key reaches these
 * spaces"; the first such error short-circuits the remaining windows.
 *
 * Fidelity caveat: the probe hits the read-level `list_apps` endpoint, which
 * the actual upload (`import_app`) does not — upload additionally requires the
 * `edit_apps` permission on the space. So this set can slightly OVER-report: a
 * space where the user can read but not author apps passes the probe yet the
 * upload itself returns 403. That degrades cleanly (the upload surfaces a
 * permission error naming the space); we don't pre-probe `edit_apps` because
 * there is no cheap read-only endpoint that gates on it.
 */
const PROBE_CONCURRENCY = 8;

export async function discoverAccessibleDomains(
	creds: CommCareCredentials,
): Promise<CommCareDomain[] | CommCareApiError> {
	const all = await listDomains(creds);
	if (!Array.isArray(all)) return all;

	const accessible: CommCareDomain[] = [];
	/* Sequential windows of `PROBE_CONCURRENCY` parallel probes. Bounds peak
	 * connections to HQ regardless of how many spaces the key lists. */
	for (let i = 0; i < all.length; i += PROBE_CONCURRENCY) {
		const window = all.slice(i, i + PROBE_CONCURRENCY);
		const probed = await Promise.all(
			window.map(async (domain) => ({
				domain,
				access: await testDomainAccess(creds, domain.name),
			})),
		);

		/* A server error (5xx) or throttle (429) means we can't trust the
		 * result set — propagate it rather than silently dropping a space or
		 * continuing to hammer HQ. */
		const serverError = probed.find((p) => typeof p.access === "object");
		if (serverError) return serverError.access as CommCareApiError;

		for (const p of probed) if (p.access === true) accessible.push(p.domain);
	}

	return accessible;
}

/** The most an import waits on a `Retry-After` before sending again. */
export const IMPORT_RETRY_MAX_WAIT_MS = HQ_THROTTLE_MAX_WAIT_MS;

/** How many times one import is sent at most: the first and two resends. */
const IMPORT_SENDS = 3;

/**
 * The wait a 429's `Retry-After` asks of an import, or null when the import
 * does not wait it out: the header's wait (`hq/http.ts::retryAfterMs`) where
 * it is at most `IMPORT_RETRY_MAX_WAIT_MS`.
 */
export function importRetryWaitMs(retryAfter: string | null): number | null {
	const ms = retryAfterMs(retryAfter);
	return ms !== null && ms <= IMPORT_RETRY_MAX_WAIT_MS ? ms : null;
}

/**
 * Import an app into a CommCare HQ project space.
 *
 * Sends the expanded HQ JSON as a multipart form upload. Without
 * `updateAppId`, CommCare HQ creates a new app in the domain. With one, HQ
 * overwrites that app in place — same app id, version bumped — and reports
 * the resulting `version`; an unknown id draws a 404, which passes through
 * as `{ success: false, status: 404 }` so the caller can record that the
 * remote app is gone. `app_name` is sent on both paths: HQ applies it after
 * the merge, so an update also renames the HQ app to Nova's current name.
 *
 * Wire contract verified against
 * `commcare-hq/.../app_manager/views/app_import_api.py::_handle_import_app`
 * (the optional `app_id` field) and
 * `models/applications.py::overwrite_app_from_source` (the in-place merge).
 * An update of a deleted app answers 400 (its `doc_type` no longer matches
 * the body's), and an update of an id HQ does not hold answers 404.
 *
 * A first publish sends two imports, the shell create and the update, and
 * both pass `corehq/apps/api/decorators.py::api_throttle`, so the pair can
 * trip the project space's per-second window by itself. HQ answers that 429
 * before the view runs (`SETTLED_BEFORE_THE_VIEW`), with a `Retry-After` of
 * the seconds left in the window, so the import is sent again after a wait
 * of at most `IMPORT_RETRY_MAX_WAIT_MS`, and at most twice. A longer or
 * absent `Retry-After`, or a third 429, is the refusal: the minute, hour and
 * day windows are the project space's whole budget, and a wait cannot widen
 * it. The wait runs inside the import's own deadline: one that would
 * outlast it is not begun, and one the deadline cuts short sends nothing
 * more, so either way the answer is HQ's 429.
 */
export async function importApp(
	creds: CommCareCredentials,
	domain: string,
	appName: string,
	appJson: object,
	updateAppId?: string,
): Promise<ImportResponse> {
	if (
		!isValidDomainSlug(domain) ||
		(updateAppId !== undefined && !/^[A-Za-z0-9_-]+$/.test(updateAppId))
	) {
		return { success: false, status: 400 };
	}
	const base = baseUrl(creds);
	const url = `${base}/a/${domain}/apps/api/import_app/`;
	const appFile = JSON.stringify(appJson);

	/* Multipart form: waf_padding (see WAF_PADDING) + app_name (string) +
	 * optional app_id (the HQ app to update in place) + app_file (JSON
	 * blob). Built for each send, so a resend carries the same bytes. */
	const formData = () => {
		const form = new FormData();
		form.append("waf_padding", WAF_PADDING);
		form.append("app_name", appName);
		if (updateAppId) {
			form.append("app_id", updateAppId);
		}
		form.append(
			"app_file",
			new Blob([appFile], { type: "application/json" }),
			"app.json",
		);
		return form;
	};

	return withHqRequestDeadline(async (signal, deadline) => {
		let res: HqAnswer;
		for (let sent = 1; ; sent++) {
			try {
				res = await sendHq(creds, url, {
					method: "POST",
					body: formData(),
					signal,
				});
			} catch (error) {
				log.error("[commcare] import response unavailable", error, {
					domain,
				});
				return {
					success: false,
					status: 503,
					cause: signal.aborted ? "timeout" : "network",
				};
			}
			const wait =
				res.status === 429 && sent < IMPORT_SENDS
					? importRetryWaitMs(res.header("retry-after"))
					: null;
			/* A resend the deadline would cut off is no resend: HQ's 429 is
			 * the answer. */
			if (wait === null || Date.now() + wait >= deadline) break;
			await res.discard();
			log.warn("[commcare] import rate limited, sending again", {
				domain,
				waitMs: wait,
			});
			await delay(wait, signal);
			if (signal.aborted) break;
		}

		if (!res.ok) {
			/* A 404 on the update arm is an ANSWER — the app Nova mapped was
			 * deleted on HQ's side — handled as a first-class outcome by the
			 * publish lifecycle, so it files at warn level like the observation
			 * reads' expected refusals. */
			if (updateAppId && res.status === 404) {
				return await warnAndReturnError("import target missing", res);
			}
			return await logAndReturnError("import failed", res);
		}

		/* An acknowledgement longer than Nova reads is one it cannot read: the
		 * publish takes it as it takes any unreadable answer, as an import that
		 * may have landed. */
		const answer = await readAnswerJson(res, HQ_IMPORT_ACK_MAX_BYTES);
		if (answer.kind === "unreadable") {
			log.error("[commcare] import acknowledgement is unreadable", undefined, {
				domain,
				why: answer.why,
			});
			return signal.aborted
				? { success: false, status: 503, cause: "timeout" }
				: HQ_MALFORMED_ANSWER;
		}
		const data = answer.data;
		if (typeof data !== "object" || data === null || Array.isArray(data)) {
			return HQ_MALFORMED_ANSWER;
		}
		const acknowledgement = data as Record<string, unknown>;

		/* HQ can return HTTP 200 with success:false for application-level
		 * import failures (malformed JSON, schema violations). Its `error`
		 * can quote the app (`AppEditingError` names a form or a question),
		 * so the line names that text's shape and length, never the text. */
		if (acknowledgement.success === false) {
			const error = hqTextFacts(
				typeof acknowledgement.error === "string" ? acknowledgement.error : "",
			);
			log.error("[commcare] import rejected by HQ", undefined, {
				domain,
				error: error.shape,
				errorBytes: error.bytes,
			});
			return { success: false, status: 422 };
		}
		const { app_id: appId, version, warnings } = acknowledgement;
		if (
			acknowledgement.success !== true ||
			typeof appId !== "string" ||
			!/^[A-Za-z0-9_-]+$/.test(appId) ||
			(updateAppId !== undefined && appId !== updateAppId) ||
			(version !== undefined && !isHqCount(version)) ||
			(warnings !== undefined &&
				(!Array.isArray(warnings) ||
					!warnings.every((warning) => typeof warning === "string")))
		) {
			// This id becomes the durable ownership mapping. A truthy verdict or
			// an unrelated returned id cannot establish what this publish wrote.
			log.error("[commcare] import acknowledgement is malformed", undefined, {
				domain,
			});
			return HQ_MALFORMED_ANSWER;
		}

		return {
			success: true,
			appId,
			version: typeof version === "number" ? version : null,
			warnings: warnings ?? [],
		};
	}, 60_000);
}

// ── Multimedia upload (bulk API) ───────────────────────────────────

/** One file HQ couldn't match to a reference, from the status report's
 *  `unmatched_files` list — the wire path (`commcare/<hash><ext>`) plus HQ's
 *  own reason string. The upload route maps the path back to the carrier it
 *  serves so the user sees WHICH media, WHERE, didn't attach. */
export interface UnmatchedMediaFileReport {
	readonly path: string;
	readonly reason: string;
}

/**
 * Outcome of a bulk media upload. `matched` / `unmatched` come from HQ's
 * async processing of the ZIP (files matched to the app's references vs
 * files the app doesn't reference); `unmatchedFiles` carries the per-file
 * detail behind `unmatched` (path + reason) so the caller can name what didn't
 * attach instead of a bare count; `errors` carries any processing errors HQ
 * reported. `timedOut` means we stopped polling before HQ finished — the ZIP
 * was accepted, but we could not confirm the final attachment result.
 */
export interface MediaBundleUploadResult {
	readonly matched: number;
	readonly unmatched: number;
	readonly unmatchedFiles: readonly UnmatchedMediaFileReport[];
	/**
	 * Every file HQ matched, across its media classes: the app's own path
	 * (`jr://file/...`) and the id of the document HQ mapped there
	 * (`hqmedia/models.py::CommCareMultimedia.get_media_info`'s `path` and
	 * `m_id`, which `tasks.py::process_bulk_upload_zip` writes into the app's
	 * map). Null where the report holds no `matched_files` of that shape: a
	 * report Nova cannot read for ids is no failed upload.
	 */
	readonly matchedFiles: readonly MatchedMediaFileReport[] | null;
	readonly errors: readonly string[];
	readonly timedOut: boolean;
}

/** One file HQ matched to a path of the app, from the status report's `matched_files`. */
export interface MatchedMediaFileReport {
	readonly path: string;
	readonly multimediaId: string;
}

/**
 * `matched_files` as `hqmedia/cache.py::BulkMultimediaStatusCache.get_response` serves it,
 * a map from media class to the matched entries, or null where it is not that
 * shape or an entry holds no `path` and `m_id` Nova can use.
 */
function matchedMediaFiles(
	value: unknown,
): readonly MatchedMediaFileReport[] | null {
	if (!isHqObject(value)) return null;
	const files: MatchedMediaFileReport[] = [];
	for (const entries of Object.values(value)) {
		if (!Array.isArray(entries)) return null;
		for (const entry of entries) {
			if (
				!isHqObject(entry) ||
				typeof entry.path !== "string" ||
				typeof entry.m_id !== "string" ||
				!/^[\w-]+$/.test(entry.m_id)
			)
				return null;
			files.push({ path: entry.path, multimediaId: entry.m_id });
		}
	}
	return files;
}

/* Poll cadence + ceiling for the async bulk-upload processing. The bytes
 * are already accepted when polling starts, so this only confirms the match
 * result — bounded so a slow/stuck task can't hold the request open. */
const MEDIA_BUNDLE_UPLOAD_TIMEOUT_MS = 60_000;
const MEDIA_BUNDLE_POLL_INTERVAL_MS = 1500;
const MEDIA_BUNDLE_POLL_TIMEOUT_MS = 45_000;

/**
 * Upload an app's media as one bulk ZIP to CommCare HQ's
 * `upload_multimedia_api` (`POST /a/{domain}/apps/api/{app_id}/multimedia/`).
 *
 * This is the API-key-authenticated media path — the SAME `@api_auth()`
 * gate as `import_app_api`. The per-kind `multimedia/uploaded/<kind>/`
 * endpoints are `login_and_domain_required` (session/cookie auth that
 * ignores the `ApiKey` header), so an API-key client gets HQ's HTML login
 * page back instead of JSON — they can't be used here. Verified against
 * `commcare-hq/.../app_manager/views/app_import_api.py` (the `@api_auth()`
 * decorator) and `hqmedia/views.py` (the session-only per-kind views).
 *
 * HQ unzips the bundle and matches each `commcare/<hash><ext>` entry against
 * the app's FORM/MENU media paths — `process_bulk_upload_zip` keeps only
 * entries whose path is in `app.get_all_paths_of_type(...)`, and HQ's
 * `ApplicationMediaMixin.all_media` EXCLUDES app-level media (logos). So a
 * file referenced anywhere in the forms/menus attaches; an image used ONLY
 * as the web-apps logo is reported `unmatched` here (its only HQ home is the
 * session-auth per-logo endpoint, unreachable by API key, or the bundled
 * `.ccz`). A logo image that's ALSO form/menu media still attaches — the
 * file matches via that reference and the logo resolves to the same path.
 * Processing is asynchronous: the POST returns a `processing_id` once the
 * ZIP is accepted, and the match runs in a background task we poll to a
 * bounded deadline.
 */
export async function uploadAppMediaBundle(
	creds: CommCareCredentials,
	domain: string,
	appId: string,
	zipBytes: Buffer,
	options: {
		/**
		 * Called once with the job id HQ named, the moment it accepted the
		 * ZIP and before any status read: whatever the reads answer after it,
		 * the job may run, and the caller holds the id it is polled by.
		 */
		readonly onAccepted?: (processingId: string) => void;
	} = {},
): Promise<MediaBundleUploadResult | CommCareApiError> {
	if (!isValidDomainSlug(domain) || !/^[\w-]+$/.test(appId)) {
		return { success: false, status: 400 };
	}
	const base = `${baseUrl(creds)}/a/${domain}/apps/api/${appId}/multimedia`;
	const formData = new FormData();
	formData.append("waf_padding", WAF_PADDING);
	formData.append(
		"bulk_upload_file",
		new Blob([new Uint8Array(zipBytes)], { type: "application/zip" }),
		"multimedia.zip",
	);
	const controller = new AbortController();
	const timer = setTimeout(
		() => controller.abort(),
		MEDIA_BUNDLE_UPLOAD_TIMEOUT_MS,
	);
	let started: unknown;
	try {
		const response = await sendHq(creds, `${base}/`, {
			method: "POST",
			body: formData,
			signal: controller.signal,
		});
		if (!response.ok)
			return await warnAndReturnError("media bundle upload refused", response);
		const answer = await readAnswerJson(
			response,
			HQ_MEDIA_BUNDLE_ACK_MAX_BYTES,
		);
		if (answer.kind === "unreadable")
			return { success: false, status: controller.signal.aborted ? 503 : 502 };
		started = answer.data;
	} catch (error) {
		log.warn("[commcare] media bundle upload could not be confirmed", {
			domain,
			appId,
			error,
		});
		return { success: false, status: 503 };
	} finally {
		clearTimeout(timer);
	}
	if (!isHqObject(started)) return { success: false, status: 502 };
	if (started.success === false) return { success: false, status: 422 };
	if (
		started.success !== true ||
		typeof started.processing_id !== "string" ||
		!/^[\w-]+$/.test(started.processing_id)
	)
		return { success: false, status: 502 };
	options.onAccepted?.(started.processing_id);
	return pollMediaBundleStatus(
		creds,
		domain,
		base,
		started.processing_id,
		MEDIA_BUNDLE_POLL_TIMEOUT_MS,
	);
}

/** How long a later read of a media job's status watches it before it answers `running`. */
const MEDIA_JOB_STATUS_READ_MS = 5_000;

/**
 * Whether a media job CommCare HQ accepted earlier has finished, read by the
 * job id it named (`hqmedia/cache.py::BulkMultimediaStatusCache`, kept for an
 * hour): `complete` where HQ reports it done, `running` where it reports it
 * not done within a few seconds of watching, and `unknown` where no status
 * could be read, an expired one among them.
 */
export async function readAppMediaBundleStatus(
	creds: CommCareCredentials,
	domain: string,
	appId: string,
	processingId: string,
): Promise<"complete" | "running" | "unknown"> {
	if (
		!isValidDomainSlug(domain) ||
		!/^[\w-]+$/.test(appId) ||
		!/^[\w-]+$/.test(processingId)
	)
		return "unknown";
	const base = `${baseUrl(creds)}/a/${domain}/apps/api/${appId}/multimedia`;
	const status = await pollMediaBundleStatus(
		creds,
		domain,
		base,
		processingId,
		MEDIA_JOB_STATUS_READ_MS,
	);
	if ("success" in status) return "unknown";
	return status.timedOut ? "running" : "complete";
}

/** One deadline owns all status fetches, their bodies and the waits between
 * reads. HQ's cache can briefly be absent; HTTP failures are retried, whereas
 * a malformed answer, or a status read that gets no answer when sent once
 * more (`getResendingUnanswered`), returns an unconfirmed typed error.
 * Expiry proves only that we stopped observing, never that HQ is still working.
 * Wire fields come from hqmedia/cache.py::BulkMultimediaStatusCache.get_response.
 */
async function pollMediaBundleStatus(
	creds: CommCareCredentials,
	domain: string,
	base: string,
	processingId: string,
	watchMs: number,
): Promise<MediaBundleUploadResult | CommCareApiError> {
	return withHqRequestDeadline(async (signal) => {
		const deadline = Date.now() + watchMs;
		while (!signal.aborted && Date.now() < deadline) {
			let response: HqAnswer;
			try {
				response = await getResendingUnanswered(
					() =>
						sendHq(creds, `${base}/status/${processingId}/`, {
							accept: "application/json",
							noStore: true,
							signal,
						}),
					signal,
					"media bundle status",
					domain,
				);
			} catch {
				if (signal.aborted) break;
				return { success: false, status: 503 };
			}
			if (response.status >= 300 && response.status < 400)
				return await warnAndReturnError(
					"media bundle status redirected",
					response,
				);
			if (response.ok) {
				const answer = await readAnswerJson(
					response,
					HQ_MEDIA_BUNDLE_STATUS_MAX_BYTES,
				);
				if (answer.kind === "unreadable") {
					if (signal.aborted) break;
					return { success: false, status: 502 };
				}
				const status = answer.data;
				if (
					!isHqObject(status) ||
					status.success !== true ||
					status.processing_id !== processingId ||
					typeof status.complete !== "boolean" ||
					typeof status.matched_count !== "number" ||
					finiteIntOrNull(status.matched_count) === null ||
					finiteIntOrNull(status.unmatched_count) === null ||
					!Array.isArray(status.errors) ||
					!status.errors.every((error) => typeof error === "string") ||
					!Array.isArray(status.unmatched_files) ||
					status.unmatched_files.length !== status.unmatched_count
				)
					return { success: false, status: 502 };
				const unmatchedFiles: UnmatchedMediaFileReport[] = [];
				for (const file of status.unmatched_files) {
					if (
						!isHqObject(file) ||
						typeof file.path !== "string" ||
						!file.path ||
						typeof file.reason !== "string"
					)
						return { success: false, status: 502 };
					unmatchedFiles.push({ path: file.path, reason: file.reason });
				}
				if (status.complete) {
					const matchedFiles = matchedMediaFiles(status.matched_files);
					if (matchedFiles === null)
						log.warn("[commcare] media bundle report names no matched ids", {
							processingId,
						});
					return {
						matched: status.matched_count,
						unmatched: unmatchedFiles.length,
						unmatchedFiles,
						matchedFiles,
						errors: status.errors,
						timedOut: false,
					};
				}
			} else {
				// Release even refused response bodies before another status request.
				await response.discard();
			}
			const remaining = deadline - Date.now();
			if (signal.aborted || remaining <= 0) break;
			await delay(Math.min(MEDIA_BUNDLE_POLL_INTERVAL_MS, remaining));
		}
		return {
			matched: 0,
			unmatched: 0,
			unmatchedFiles: [],
			matchedFiles: null,
			errors: [],
			timedOut: true,
		};
	}, watchMs);
}

// ── Reading what CommCare HQ has done with an app ──────────────────
//
// Nova imports an app and then watches. Building and releasing are not
// things an API key can do: `views/releases.py::save_copy` and
// `views/releases.py::release_build` both sit behind
// `require_can_edit_apps`, which is
// `require_permission(HqPermissions.edit_apps)` with the default
// `login_and_domain_required` — a browser session and nothing else. The
// three reads below are what an API key CAN see, and together they answer
// "has somebody built it, released it, and can a device install it".

/** What CommCare HQ currently holds of one app. */
export interface HqAppVersions {
	/** The working app's own version number. */
	readonly currentVersion: number;
	/** The newest build's version, or `null` when nothing has been built. */
	readonly latestBuildVersion: number | null;
	/** The newest RELEASED build's version, or `null` when none is released. */
	readonly latestReleasedVersion: number | null;
}

function finiteIntOrNull(value: unknown): number | null {
	return isHqCount(value) ? value : null;
}

/**
 * Read an app's current, latest-built, and latest-released versions.
 *
 * `GET /a/{domain}/apps/view/{app_id}/current_version/`, which carries
 * `@login_or_api_key` (`views/releases.py::current_app_version`) and so is
 * reachable with the stored key. It answers with version NUMBERS, not
 * build ids; the application resource (`hq/application.ts::readHqApplication`)
 * is what supplies an id.
 *
 * A 404 here means CommCare HQ has no such working app in the domain —
 * either it was deleted, or the id names a build rather than the app
 * (`current_app_version` raises `Http404` on `NoResultFound` for exactly
 * that case).
 */
export async function readAppVersions(
	creds: CommCareCredentials,
	domain: string,
	hqAppId: string,
	options: { readonly cancel?: AbortSignal } = {},
): Promise<HqAppVersions | CommCareApiError> {
	if (!isValidDomainSlug(domain) || !/^[\w-]+$/.test(hqAppId))
		return { success: false, status: 400 };
	const url = `${baseUrl(creds)}/a/${domain}/apps/view/${encodeURIComponent(hqAppId)}/current_version/`;
	const result = await readHqJson(creds, url, "app versions", {
		maxBytes: HQ_APP_VERSIONS_MAX_BYTES,
		cancel: options.cancel,
	});
	if ("success" in result) return result;
	const data = result.data;
	if (typeof data !== "object" || data === null || Array.isArray(data))
		return HQ_MALFORMED_ANSWER;
	const record = data as Record<string, unknown>;
	const currentVersion = finiteIntOrNull(record.currentVersion);
	if (
		currentVersion === null ||
		(record.latestBuild !== null &&
			finiteIntOrNull(record.latestBuild) === null) ||
		(record.latestReleasedBuild !== null &&
			finiteIntOrNull(record.latestReleasedBuild) === null)
	)
		return HQ_MALFORMED_ANSWER;
	return {
		currentVersion,
		latestBuildVersion: finiteIntOrNull(record.latestBuild),
		latestReleasedVersion: finiteIntOrNull(record.latestReleasedBuild),
	};
}

/**
 * Ask CommCare HQ for the profile a device installs one BUILD from.
 *
 * This is the strongest honest proof that a released build can be run: it
 * is the first request a real device makes. A successful response must contain
 * a valid profile naming the exact selected build's remote suite.
 *
 * **It is a device install request, not a pure read, and the difference is
 * worth stating plainly.** Despite the URL, this does NOT reach
 * `views/download.py::download_odk_profile`: `urls.py` registers the
 * catch-all `^download/(?P<app_id>[\w-]+)/(?P<path>.*)$` → `download_file`
 * BEFORE the `download_urls` include (its own comment says "the order of
 * these download urls is important"), so `download_file` handles it. That
 * view generates a build's files and calls `request.app.save()` when they
 * are missing, and patches in an ODK profile the same way on its
 * `ResourceNotFound` arm. That is CommCare HQ repairing a build on a
 * device's behalf, which happens for every real install too, and it cannot
 * change the version or what is released: `ApplicationBase::save` only
 * increments a version when `copy_of` is unset, and a build has it set.
 *
 * **It must still always name a BUILD id.** With one, `download_file`'s
 * `assert request.app.copy_of` holds and the request stays on that build.
 * With the working app's id the assert fails, the except arm falls through
 * to `resolve_path` → `download_odk_profile` → `autogenerate_build`, and
 * CommCare HQ starts building a NEW version. Never pass the working app id,
 * and never `?latest=true`, which resolves to one whenever nothing is
 * released.
 *
 * A redirect is "could not check", never "not installable":
 * `decorators.py::check_access_and_redirect` answers 302 for any domain
 * carrying a `redirect_url`, and `::safe_cached_download` 302s to the app
 * page on an editing/case error. Reporting either as a broken build would
 * accuse a healthy deployment.
 */
export async function probeBuildProfile(
	creds: CommCareCredentials,
	domain: string,
	buildId: string,
): Promise<
	| { readonly ok: true }
	| { readonly ok: false; readonly reason: "unavailable" | "not-installable" }
> {
	const result = await readBuildXml(creds, domain, buildId, "profile.ccpr");
	if ("success" in result) {
		// A missing profile is a verdict on this build. A redirect, denied
		// request, interrupted body or timeout means we could not check it.
		return {
			ok: false,
			reason: result.status === 404 ? "not-installable" : "unavailable",
		};
	}
	return profileReferencesBuildSuite(result.xml, {
		server: creds.server,
		domain,
		buildId,
	})
		? { ok: true }
		: { ok: false, reason: "unavailable" };
}

/** Read an exact BUILD resource. Never resolves working apps or follows redirects. */
export async function readBuildXml(
	creds: CommCareCredentials,
	domain: string,
	buildId: string,
	resource: "profile.ccpr" | "suite.xml",
): Promise<{ readonly xml: string } | CommCareApiError> {
	if (!isValidDomainSlug(domain) || !/^[\w-]+$/.test(buildId))
		return { success: false, status: 400 };
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 30_000);
	const send = () =>
		sendHq(
			creds,
			`${baseUrl(creds)}/a/${domain}/apps/download/${encodeURIComponent(buildId)}/${resource}`,
			{ accept: "application/xml", noStore: true, signal: controller.signal },
		);
	try {
		const response = await getResendingUnanswered(
			send,
			controller.signal,
			`build ${resource}`,
			domain,
		);
		if (!response.ok) {
			await response.discard();
			return { success: false, status: response.status };
		}
		// Fetch has already decompressed the HTTP body; the bound counts the
		// stream, and no Content-Length bounds anything.
		const body = await response.read(HQ_BUILD_RESOURCE_MAX_BYTES, "text");
		if (body.kind === "too-long") return { success: false, status: 502 };
		if (body.kind === "unavailable") return { success: false, status: 503 };
		const xml = new TextDecoder().decode(body.bytes);
		// The caller validates resource syntax and identity.
		return xml.trim() ? { xml } : { success: false, status: 502 };
	} catch {
		return { success: false, status: 503 };
	} finally {
		clearTimeout(timer);
	}
}
