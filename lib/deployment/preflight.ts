import "server-only";

import type { CommCareCredentials } from "@/lib/commcare/client";
import { probeHqFeatureFlags } from "@/lib/commcare/client";
import { requiredHqFeatureFlags } from "@/lib/commcare/featureFlags";
import type { CommCareServer } from "@/lib/commcare/servers";
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
import { featureFlagReportForUpload } from "@/lib/publish/hqFeatureFlags";
import type { DeploymentPhaseOutcome } from "./types";

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

export interface PreflightResult {
	readonly checks: readonly PreflightCheck[];
	/** The phase outcome the state machine folds in. */
	readonly outcome: DeploymentPhaseOutcome;
	/**
	 * Present only when every blocking check passed. Carries the exact
	 * prepared generation the upload must consume, so the bytes that were
	 * validated are the bytes that go out.
	 */
	readonly ready: {
		readonly creds: CommCareCredentials;
		readonly domain: string;
		readonly prepared: PreparedExportBoundary;
	} | null;
	readonly featureFlags: HqFeatureFlagReport | null;
}

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
): DeploymentPhaseOutcome {
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
	checks.push({
		id: "hq-connection",
		title: "CommCare HQ connection",
		status: "passed",
		detail: `Your API key reaches “${credResult.domain.displayName}” on the ${input.server} server.`,
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

	// ── 3. Does the target carry the feature flags the app needs? ───
	// Never a blocker, by standing product contract: a flag report is
	// deployment information, and refusing to publish over one would let
	// a target's configuration edit the app.
	const requirements = requiredHqFeatureFlags(boundary.prepared.doc);
	let featureFlags: HqFeatureFlagReport | null = null;
	if (requirements.length === 0) {
		checks.push({
			id: "feature-flags",
			title: "Feature flags",
			status: "passed",
			detail: "This app doesn't need any CommCare HQ feature flags.",
			items: [],
		});
	} else {
		const probes = await probeHqFeatureFlags(creds, domain, requirements);
		featureFlags = featureFlagReportForUpload(domain, probes, "prepublish");
		const missing = featureFlags.missing_flags.map((flag) => flag.label);
		const unverified = featureFlags.unverified_flags.map((flag) => flag.label);
		checks.push({
			id: "feature-flags",
			title: "Feature flags",
			status:
				missing.length > 0
					? "attention"
					: unverified.length > 0
						? "unavailable"
						: "passed",
			detail:
				missing.length > 0
					? `Ask support@dimagi.com to enable these for “${domain}”. Publishing still works; the affected parts of the app won't until they're on.`
					: unverified.length > 0
						? "Nova couldn't check whether these are enabled. They're required, but not confirmed missing."
						: "Every flag this app needs is enabled on the target.",
			items: [...missing, ...unverified],
		});
	}

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
