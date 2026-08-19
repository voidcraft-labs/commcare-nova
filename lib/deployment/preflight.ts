import "server-only";

import type { CommCareCredentials } from "@/lib/commcare/client";
import {
	featureFlagReportForPrepublish,
	requiredHqFeatureFlags,
} from "@/lib/commcare/featureFlags";
import { COMMCARE_SERVERS, type CommCareServer } from "@/lib/commcare/servers";
import { getCredentialsForUpload } from "@/lib/db/settings";
import { userFacingError } from "@/lib/doc/userFacingErrors";
import type { BlueprintDoc } from "@/lib/domain";
import {
	ownRecordValue,
	personasOf,
	userPropertiesOf,
	userTypesOf,
} from "@/lib/domain";
import type { PreparedExportBoundary } from "@/lib/export/boundaryValidation";
import { prepareExportBoundary } from "@/lib/export/boundaryValidation";
import type { HqFeatureFlagReport } from "@/lib/publish/hqFeatureFlags";
import { attachmentUrlTarget } from "./attachmentTarget";
import type { DeploymentFailure } from "./types";

/**
 * The dependency graph Nova checks before anything externally visible
 * happens.
 *
 * It is a graph rather than a list, and the edges are of two kinds.
 * A **blocking** check is a real prerequisite: without it the publish
 * cannot happen at all, and a failure leaves the deployment `incomplete`
 * rather than succeeding with a warning attached. An **attention** check
 * is something the target needs that Nova cannot do from here, so it
 * becomes a line in the setup artifact instead of a refusal.
 *
 * The split is not a softening of the contract. It is what keeps the
 * contract truthful: refusing to publish an app because a persona has no
 * value for a required worker property would refuse a publish that would
 * have worked, since Nova creates no workers yet.
 */
export const PREFLIGHT_CHECK_IDS = [
	"hq-connection",
	"app-readiness",
	"feature-flags",
	"required-worker-data",
] as const;
export type PreflightCheckId = (typeof PREFLIGHT_CHECK_IDS)[number];

export type PreflightCheckStatus =
	/** Nothing to do. */
	| "passed"
	/** A real prerequisite is missing; the publish does not happen. */
	| "blocked"
	/** Somebody must do something on the target; the publish still happens. */
	| "attention"
	/** Nova could not find out, and says so rather than guessing. */
	| "unavailable";

export interface PreflightCheck {
	readonly id: PreflightCheckId;
	readonly title: string;
	readonly status: PreflightCheckStatus;
	/** One sentence a person can act on. */
	readonly detail: string;
	/** The specific things, when there are specific things. */
	readonly items: readonly string[];
}

/**
 * The two shapes a preflight run resolves to, discriminated on `ready` so
 * a refusal PROVES its failed outcome: the caller that reports "why this
 * attempt stopped" reads the failure straight off the type instead of
 * re-checking a status the control flow already decided.
 */
export type PreflightResult =
	| {
			readonly checks: readonly PreflightCheck[];
			/** The phase outcome the state machine folds in. */
			readonly outcome: { readonly status: "succeeded"; readonly at: string };
			/**
			 * The exact prepared generation the upload must consume, so the
			 * bytes that were validated are the bytes that go out.
			 */
			readonly ready: {
				readonly creds: CommCareCredentials;
				readonly domain: string;
				readonly prepared: PreparedExportBoundary;
			};
			readonly featureFlags: HqFeatureFlagReport | null;
	  }
	| {
			readonly checks: readonly PreflightCheck[];
			readonly outcome: {
				readonly status: "failed";
				readonly at: string;
				readonly failure: DeploymentFailure;
			};
			readonly ready: null;
			readonly featureFlags: null;
	  };

export interface PreflightInput {
	readonly doc: BlueprintDoc;
	readonly compiledAtSeq: number;
	readonly access: {
		readonly projectId: string;
		readonly role: string;
		readonly actorUserId: string;
	};
	readonly server: CommCareServer;
	readonly domain: string;
	readonly now: string;
}

function blockedOutcome(
	now: string,
	code: "hq_not_connected" | "domain_not_authorized" | "app_not_ready",
	message: string,
	details: readonly string[] = [],
): {
	readonly status: "failed";
	readonly at: string;
	readonly failure: DeploymentFailure;
} {
	return { status: "failed", at: now, failure: { code, message, details } };
}

/**
 * Which personas have no value for a worker property CommCare HQ marks
 * required.
 *
 * A persona inherits its user type's defaults and may override them, so a
 * value counts when either supplies a non-blank one. This is deliberately
 * not a document finding: whether a property is required is a fact about
 * the target's user-data schema, and gating the app on it would make
 * marking an existing property required impossible.
 */
export function personasMissingRequiredWorkerData(
	doc: BlueprintDoc,
): readonly string[] {
	const properties = Object.values(userPropertiesOf(doc)).filter(
		(property) => property.required === true,
	);
	if (properties.length === 0) return [];
	const types = userTypesOf(doc);
	const gaps: string[] = [];
	for (const persona of Object.values(personasOf(doc))) {
		const roleValues =
			persona.userTypeUuid === undefined
				? undefined
				: ownRecordValue(types, persona.userTypeUuid)?.values;
		const missing = properties
			.filter((property) => {
				const own = ownRecordValue(persona.values ?? {}, property.uuid);
				if (own !== undefined && own.trim() !== "") return false;
				const inherited = ownRecordValue(roleValues ?? {}, property.uuid);
				return inherited === undefined || inherited.trim() === "";
			})
			.map((property) => property.label);
		if (missing.length > 0) {
			gaps.push(`${persona.name}: ${missing.join(", ")}`);
		}
	}
	return gaps;
}

/**
 * Run the graph.
 *
 * Order matters and is the graph's whole point: the connection is proved
 * before the app is compiled, and the app is proved ready before anything
 * is sent. Nothing below the first blocked edge runs, because a check that
 * depends on a missing prerequisite can only produce a misleading answer.
 */
export async function runDeploymentPreflight(
	input: PreflightInput,
): Promise<PreflightResult> {
	const checks: PreflightCheck[] = [];

	// ── 1. Can we reach that project space at all? ──────────────────
	const credResult = await getCredentialsForUpload(
		input.access.actorUserId,
		input.domain,
	);
	if (!credResult.ok) {
		if (credResult.error === "not_configured") {
			const detail =
				"CommCare HQ isn't connected yet. Add your API key in Settings, picking the server your account lives on.";
			checks.push({
				id: "hq-connection",
				title: "CommCare HQ connection",
				status: "blocked",
				detail,
				items: [],
			});
			return {
				checks,
				outcome: blockedOutcome(input.now, "hq_not_connected", detail),
				ready: null,
				featureFlags: null,
			};
		}
		const reachable = credResult.available.map((space) => space.name);
		const detail =
			credResult.error === "not_authorized"
				? `Your API key can't reach the project space “${input.domain}”. Pick one it does reach, or ask a CommCare HQ administrator to add you to that space.`
				: "No project space was chosen for this deployment.";
		checks.push({
			id: "hq-connection",
			title: "CommCare HQ connection",
			status: "blocked",
			detail,
			items: reachable,
		});
		return {
			checks,
			outcome: blockedOutcome(
				input.now,
				"domain_not_authorized",
				detail,
				reachable,
			),
			ready: null,
			featureFlags: null,
		};
	}
	const { creds } = credResult;
	const domain = credResult.domain.name;
	/* The caller resolved the target server from the stored key moments
	 * ago, but the key can change between that read and this one: another
	 * tab saving a key for a different CommCare installation. The import
	 * would then land on the server the NEW key belongs to while the
	 * durable record named the old one, and every later check would read
	 * the wrong installation. The two reads have to agree before anything
	 * is sent. */
	if (creds.server !== input.server) {
		const detail = `Your CommCare HQ connection changed while this publish was being prepared: it now points at the ${COMMCARE_SERVERS[creds.server].label} CommCare server, and this publish targeted ${COMMCARE_SERVERS[input.server].label}. Close the publish dialog and try again.`;
		checks.push({
			id: "hq-connection",
			title: "CommCare HQ connection",
			status: "blocked",
			detail,
			items: [],
		});
		return {
			checks,
			outcome: blockedOutcome(input.now, "hq_not_connected", detail),
			ready: null,
			featureFlags: null,
		};
	}
	checks.push({
		id: "hq-connection",
		title: "CommCare HQ connection",
		status: "passed",
		detail: `Your API key reaches “${credResult.domain.displayName}” on the ${COMMCARE_SERVERS[input.server].label} CommCare server.`,
		items: [],
	});

	// ── 2. Is the app itself ready to leave Nova? ───────────────────
	// The same zero-tolerance boundary every export path runs, including
	// the guards that stay closed until the push drivers can satisfy
	// them: an app that references a lookup table or a place-based owner
	// cannot go to CommCare HQ until those resources can be pushed there.
	const boundary = await prepareExportBoundary({
		mode: "hq-upload",
		access: input.access,
		doc: input.doc,
		compiledAtSeq: input.compiledAtSeq,
		// A publish knows its target exactly: it IS this server and this
		// project space. So it never consults the deployment record the
		// download paths fall back on — the record describes where the app
		// has been, and this is where it is going.
		attachmentTarget: attachmentUrlTarget({
			server: input.server,
			domain: input.domain,
		}),
	});
	if (!boundary.ok) {
		const details = boundary.violations.map(userFacingError);
		const detail =
			"This app isn't ready to publish yet. Fix the issues below, then try again.";
		checks.push({
			id: "app-readiness",
			title: "App readiness",
			status: "blocked",
			detail,
			items: details,
		});
		return {
			checks,
			outcome: blockedOutcome(input.now, "app_not_ready", detail, details),
			ready: null,
			featureFlags: null,
		};
	}
	checks.push({
		id: "app-readiness",
		title: "App readiness",
		status: "passed",
		detail: "Everything this app needs to compile is in place.",
		items: [],
	});

	// ── 3. Which feature flags does the app need? ───────────────────
	// Requirements only. Preflight deliberately does NOT probe the target:
	// the authoritative check runs against the exact domain CommCare HQ
	// accepted, AFTER the import, and probing here as well would pay for
	// the same paginated round trip twice on the critical path while the
	// answer could still change in between. The publish dialog and MCP's
	// `get_app_hq_feature_flags` already offer a probe before publishing,
	// for authors who want one first.
	//
	// Never a blocker either way, by standing product contract: a flag
	// report is deployment information, and refusing to publish over one
	// would let a target's configuration edit the app.
	const requirements = requiredHqFeatureFlags(boundary.prepared.doc);
	const featureFlags: HqFeatureFlagReport | null =
		requirements.length === 0
			? null
			: featureFlagReportForPrepublish(boundary.prepared.doc);
	checks.push({
		id: "feature-flags",
		title: "Feature flags",
		status: requirements.length === 0 ? "passed" : "attention",
		detail:
			requirements.length === 0
				? "This app doesn't need any CommCare HQ feature flags."
				: `These have to be on for “${domain}”. Publishing works either way; the parts of the app that need them won't until they are. Nova checks the target after the app lands.`,
		items: requirements.map((requirement) => requirement.label),
	});

	// ── 4. Will the workers you create there have what they need? ───
	// Attention rather than blocking: Nova creates no workers yet, so
	// refusing the publish would refuse one that would have worked.
	const workerGaps = personasMissingRequiredWorkerData(boundary.prepared.doc);
	checks.push({
		id: "required-worker-data",
		title: "Required worker information",
		status: workerGaps.length === 0 ? "passed" : "attention",
		detail:
			workerGaps.length === 0
				? "Every persona has a value for the worker information marked required."
				: "CommCare HQ won't let you save a worker without these. Fill them in on the persona, or give the role a default, before you create workers on this project space.",
		items: workerGaps,
	});

	return {
		checks,
		outcome: { status: "succeeded", at: input.now },
		ready: { creds, domain, prepared: boundary.prepared },
		featureFlags,
	};
}
