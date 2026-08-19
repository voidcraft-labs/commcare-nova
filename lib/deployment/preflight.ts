import "server-only";

import type {
	CommCareApiError,
	CommCareCredentials,
} from "@/lib/commcare/client";
import {
	featureFlagReportForPrepublish,
	requiredHqFeatureFlags,
} from "@/lib/commcare/featureFlags";
import {
	listHqLocations,
	listHqLocationTypes,
} from "@/lib/commcare/hq/locations";
import { listHqLookupTables } from "@/lib/commcare/hq/lookupTables";
import type { LookupWorkbook } from "@/lib/commcare/lookup/workbook";
import { COMMCARE_SERVERS, type CommCareServer } from "@/lib/commcare/servers";
import { getCredentialsForUpload } from "@/lib/db/settings";
import { userFacingError } from "@/lib/doc/userFacingErrors";
import type { BlueprintDoc } from "@/lib/domain";
import {
	locationPropertiesOf,
	organizationLevelsOf,
	ownRecordValue,
	personasOf,
	userPropertiesOf,
	userTypesOf,
} from "@/lib/domain";
import type { PreparedExportBoundary } from "@/lib/export/boundaryValidation";
import { prepareExportBoundary } from "@/lib/export/boundaryValidation";
import { readOrganization } from "@/lib/organization/service";
import type { StoredLocation } from "@/lib/organization/types";
import type { HqFeatureFlagReport } from "@/lib/publish/hqFeatureFlags";
import { attachmentUrlTarget } from "./attachmentTarget";
import {
	type PlacePushProblem,
	type PlannedPlacePush,
	planLocationResourcePush,
	plannedPlacesFor,
} from "./locationResourcePlan";
import {
	type PlannedLookupPush,
	planLookupResourcePush,
} from "./lookupResourcePlan";
import type {
	DeploymentFailure,
	DeploymentResource,
	DeploymentResourceConflict,
} from "./types";

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
 *
 * `project-data` and `organization` are the two edges that talk to
 * CommCare HQ here, and both are blocking for the same reason: each is
 * the only thing standing between a publish and quietly writing over a
 * lookup table or a place somebody else made. They appear only when the
 * app actually carries one.
 *
 * `organization` is also where the shapes CommCare HQ will not hold are
 * caught. Places go out in atomic batches of a hundred, one level at a
 * time, so a tree refused on its fourth level has already put three
 * levels of places on somebody's project space. Everything knowable is
 * therefore decided here, before the first batch is sent.
 */
export const PREFLIGHT_CHECK_IDS = [
	"hq-connection",
	"app-readiness",
	"project-data",
	"organization",
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
				/**
				 * What to put on the project space before the app goes out,
				 * and the ownership claim each table travels under. Absent
				 * when the app references no Project data.
				 */
				readonly lookupPush: LookupPushPlan | null;
				/**
				 * The places to put there, in the order CommCare HQ can take
				 * them. Absent when the app has no organization or no live
				 * places in it.
				 */
				readonly locationPush: LocationPushPlan | null;
				/**
				 * The app's places, read once. Handed back so the caller can
				 * build the setup artifact from the same snapshot this ran
				 * against rather than reading the organization a second time.
				 */
				readonly locations: readonly StoredLocation[];
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
			/**
			 * The resources this run refused to write over. Empty for every
			 * refusal that is not a name clash, and the caller passes it
			 * straight to the attempt's refusal so a person can name the ones
			 * they recognize.
			 */
			readonly conflicts: readonly DeploymentResourceConflict[];
	  };

/** The tables to push, and what Nova may claim about each. */
export interface LookupPushPlan {
	readonly workbook: LookupWorkbook;
	readonly pushes: readonly PlannedLookupPush[];
}

/**
 * The places to push, already grouped the way CommCare HQ takes them.
 *
 * Batched rather than a flat list because the batching IS the plan: a
 * child names its parent by the id the parent's own batch returned, and
 * `patch_list` is atomic at a hundred, so the grouping decides both the
 * order and where a partial push can stop.
 */
export interface LocationPushPlan {
	readonly batches: readonly (readonly PlannedPlacePush[])[];
	/** Every place across every batch, for the sentence that describes it. */
	readonly placeCount: number;
}

export interface PreflightInput {
	readonly doc: BlueprintDoc;
	readonly compiledAtSeq: number;
	/**
	 * The deployment's live resource mappings, read before anything is
	 * asked of CommCare HQ. Empty for a project space this app has never
	 * reached, which is exactly right: Nova owns nothing there yet.
	 */
	readonly mappings: readonly DeploymentResource[];
	/**
	 * Nova table ids whose name clash on the target the caller has
	 * explicitly resolved by taking the existing table over. Never
	 * defaulted, never inferred from a previous attempt.
	 */
	readonly adoptResourceIds: readonly string[];
	readonly access: {
		/** The app whose organization this reads. Authorized by the caller. */
		readonly appId: string;
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
	code:
		| "hq_not_connected"
		| "domain_not_authorized"
		| "app_not_ready"
		| "hq_resource_state_unknown"
		| "hq_resource_conflict"
		| "hq_organization_mismatch",
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

/** "1 lookup table" / "3 lookup tables", counted for a sentence. */
function describeTableCount(count: number): string {
	return count === 1 ? "1 lookup table" : `${count} lookup tables`;
}

function describeRowCount(count: number): string {
	return count === 1 ? "1 row" : `${count.toLocaleString("en-US")} rows`;
}

/** "1 place" / "12 places", counted for a sentence. */
function describePlaceCount(count: number): string {
	return count === 1 ? "1 place" : `${count.toLocaleString("en-US")} places`;
}

/**
 * The push, summarized by level rather than listed place by place.
 *
 * A tree runs to thousands of places, so naming each one would bury the
 * sentence above it. The level codes are what a person compares against
 * CommCare HQ's own Organization Levels page anyway.
 */
function describePlacesByLevel(
	places: readonly { readonly levelCode: string }[],
): readonly string[] {
	const counts = new Map<string, number>();
	for (const place of places) {
		counts.set(place.levelCode, (counts.get(place.levelCode) ?? 0) + 1);
	}
	return [...counts.entries()].map(
		([levelCode, count]) => `${levelCode} (${describePlaceCount(count)})`,
	);
}

/**
 * One place CommCare HQ will not take, and what to change about it.
 *
 * Each sentence names the place both ways a person can recognize it, then
 * says what CommCare HQ's rule is rather than quoting the error it would
 * eventually produce.
 */
function describePlaceProblem(problem: PlacePushProblem): string {
	const place = `${problem.name} (${problem.siteCode})`;
	switch (problem.kind) {
		case "level-missing":
			return `${place} stands at the level “${problem.levelCode}”, which isn't one of the levels on this project space.`;
		case "level-not-under-parent":
			return `${place} stands at “${problem.levelCode}” under ${problem.parentName} at “${problem.parentLevelCode}”. CommCare HQ takes a place only at the level directly below its parent's, so the rungs in between have to exist there and be filled in.`;
		case "duplicate-sibling-name":
			return problem.parentName === null
				? `${place} shares its name with another place at the top of the organization, and CommCare HQ needs those to differ.`
				: `${place} shares its name with another place under ${problem.parentName}, and CommCare HQ needs those to differ.`;
		case "cannot-become-root":
			return `${place} is at the top of the organization in Nova and sits under ${problem.remoteParentName} on CommCare HQ. Moving a place back to the top can only be done there.`;
	}
}

/**
 * A clash, named the two ways a person has to recognize it: what they call
 * the table in Nova, and what they will see in CommCare HQ's own list.
 */
function describeConflicts(
	conflicts: readonly DeploymentResourceConflict[],
): readonly string[] {
	return conflicts.map((conflict) => `${conflict.name} (${conflict.identity})`);
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
				conflicts: [],
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
			conflicts: [],
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
			conflicts: [],
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
			conflicts: [],
		};
	}
	checks.push({
		id: "app-readiness",
		title: "App readiness",
		status: "passed",
		detail: "Everything this app needs to compile is in place.",
		items: [],
	});

	// ── 3. Is the data this app reads already on that project space? ─
	// Blocking, and it runs BEFORE anything is sent, because the fixture
	// upload matches tables by tag: pushing without knowing what is there
	// would take over a same-named table somebody else made.
	const workbook = boundary.prepared.lookupWorkbook;
	let lookupPush: LookupPushPlan | null = null;
	if (workbook !== undefined) {
		const hqTables = await listHqLookupTables(creds, domain);
		if ("success" in hqTables) {
			/* Nova cannot tell its own tables from anybody else's without
			 * this answer, so it does not push. Reading the failure as "the
			 * project space has none" is the one interpretation that turns a
			 * permissions problem into somebody's data being overwritten.
			 *
			 * Reading the table list needs the paid API access privilege on
			 * the project space AND the account's own Access APIs
			 * permission, while the upload itself needs neither — so this
			 * refusal is genuinely reachable on a project space that would
			 * have accepted the push. */
			const detail =
				hqTables.status === 401 || hqTables.status === 403
					? `Nova can't see which lookup tables “${domain}” already has, so it won't push over them. Reading them needs API access on that project space and the Access APIs permission on your CommCare HQ account; ask a CommCare HQ administrator for both.`
					: `Nova couldn't ask “${domain}” which lookup tables it already has, so it stopped rather than push over them. Try publishing again in a moment.`;
			checks.push({
				id: "project-data",
				title: "Project data",
				status: "blocked",
				detail,
				items: [],
			});
			return {
				checks,
				outcome: blockedOutcome(input.now, "hq_resource_state_unknown", detail),
				ready: null,
				featureFlags: null,
				conflicts: [],
			};
		}
		const plan = planLookupResourcePush({
			tables: workbook.tables,
			mappings: input.mappings,
			hqTables,
			adoptTableIds: input.adoptResourceIds,
		});
		if (!plan.ok) {
			/* Named twice over: the tag is what CommCare HQ shows, and the
			 * table's own name is what the author will recognize. The
			 * definitions are the generation the boundary validated, so the
			 * name printed here is the name the workbook was built from. */
			const nameByTableId = new Map(
				boundary.prepared.lookupSnapshot.definitions.map(
					(definition) => [definition.id, definition.name] as const,
				),
			);
			const conflicts: readonly DeploymentResourceConflict[] =
				plan.conflicts.map((conflict) => ({
					kind: "lookup-table",
					novaResourceId: conflict.tableId,
					name: nameByTableId.get(conflict.tableId) ?? conflict.tag,
					identity: conflict.tag,
					remoteId: conflict.remoteId,
				}));
			const detail = `“${domain}” already has lookup tables with these names, and Nova didn't make them. Rename the table in Project data, or choose to use the existing one.`;
			checks.push({
				id: "project-data",
				title: "Project data",
				status: "blocked",
				detail,
				items: describeConflicts(conflicts),
			});
			return {
				checks,
				outcome: blockedOutcome(
					input.now,
					"hq_resource_conflict",
					detail,
					describeConflicts(conflicts),
				),
				ready: null,
				featureFlags: null,
				conflicts,
			};
		}
		lookupPush = { workbook, pushes: plan.pushes };
		checks.push({
			id: "project-data",
			title: "Project data",
			status: "passed",
			detail: `Nova will put ${describeTableCount(workbook.tables.length)} on “${domain}” before sending the app.`,
			items: workbook.tables.map(
				(table) => `${table.tag} (${describeRowCount(table.rowCount)})`,
			),
		});
	}

	// ── 4. Can that project space hold this organization? ───────────
	// Blocking, and everything knowable is decided here. A place push is
	// a batch per level and each batch is atomic, so a tree refused
	// partway has already left places behind; and the site code is a
	// domain-unique identity, so pushing blind would take over a place
	// somebody else made.
	let locationPush: LocationPushPlan | null = null;
	let locations: readonly StoredLocation[] = [];
	if (Object.keys(organizationLevelsOf(boundary.prepared.doc)).length > 0) {
		/* Read authoritatively. Everywhere else an unavailable organization
		 * read degrades to no places, because the artifact is still right
		 * without them; here that reading would push nothing and then tell
		 * somebody their organization is on the project space. */
		const snapshot = await readOrganization({
			appId: input.access.appId,
			projectId: input.access.projectId,
			role: input.access.role,
			actorUserId: input.access.actorUserId,
		});
		locations = snapshot.locations;
		const places = plannedPlacesFor(boundary.prepared.doc, locations);
		if (places.length > 0) {
			/* Nova cannot tell its own places from anybody else's without
			 * both answers, so a refusal is never read as "there is nothing
			 * over there". Four separate things produce these statuses and
			 * two of them are the same bodyless 403, so the sentence names
			 * all of them rather than picking one and being confidently
			 * wrong. */
			const organizationUnreadable = (
				error: CommCareApiError,
			): PreflightResult => {
				const detail =
					error.status === 401 || error.status === 403
						? `Nova can't read the organization on “${domain}”, so it won't push places over what's there. That project space needs the Organizations and API access features, and your CommCare HQ account needs the Edit Locations and Access APIs permissions. Ask a CommCare HQ administrator for whichever is missing.`
						: `Nova couldn't ask “${domain}” about its organization, so it stopped rather than push places into it. Try publishing again in a moment.`;
				checks.push({
					id: "organization",
					title: "Organization",
					status: "blocked",
					detail,
					items: [],
				});
				return {
					checks,
					outcome: blockedOutcome(
						input.now,
						"hq_resource_state_unknown",
						detail,
					),
					ready: null,
					featureFlags: null,
					conflicts: [],
				};
			};
			const hqLevels = await listHqLocationTypes(creds, domain);
			if ("success" in hqLevels) return organizationUnreadable(hqLevels);
			const hqPlaces = await listHqLocations(creds, domain);
			if ("success" in hqPlaces) return organizationUnreadable(hqPlaces);

			const plan = planLocationResourcePush({
				places,
				mappings: input.mappings,
				hqLevels,
				hqPlaces,
				appModelsPlaceInformation:
					Object.keys(locationPropertiesOf(boundary.prepared.doc)).length > 0,
				adoptLocationUuids: input.adoptResourceIds,
			});
			if (!plan.ok && plan.reason === "unpushable") {
				const items = plan.problems.map(describePlaceProblem);
				const detail = `CommCare HQ won't take some of these places as they stand. Change them in Organization, or set up the matching levels on “${domain}”, then publish again.`;
				checks.push({
					id: "organization",
					title: "Organization",
					status: "blocked",
					detail,
					items,
				});
				return {
					checks,
					outcome: blockedOutcome(
						input.now,
						"hq_organization_mismatch",
						detail,
						items,
					),
					ready: null,
					featureFlags: null,
					conflicts: [],
				};
			}
			if (!plan.ok) {
				const conflicts: readonly DeploymentResourceConflict[] =
					plan.conflicts.map((conflict) => ({
						kind: "location",
						novaResourceId: conflict.locationUuid,
						name: conflict.name,
						identity: conflict.siteCode,
						remoteId: conflict.remoteId,
					}));
				const items = plan.conflicts.map(
					(conflict) =>
						`${conflict.name} (${conflict.siteCode}), which “${domain}” calls ${conflict.remoteName}`,
				);
				const detail = `“${domain}” already has places with these site codes, and Nova didn't make them. Choose to use the existing places, or remove these from Organization and add them again with codes that are free.`;
				checks.push({
					id: "organization",
					title: "Organization",
					status: "blocked",
					detail,
					items,
				});
				return {
					checks,
					outcome: blockedOutcome(
						input.now,
						"hq_resource_conflict",
						detail,
						items,
					),
					ready: null,
					featureFlags: null,
					conflicts,
				};
			}
			locationPush = { batches: plan.batches, placeCount: places.length };
			checks.push({
				id: "organization",
				title: "Organization",
				status: "passed",
				detail: `Nova will put ${describePlaceCount(places.length)} on “${domain}” before sending the app, parents first.`,
				items: describePlacesByLevel(places),
			});
		}
	}

	// ── 5. Which feature flags does the app need? ───────────────────
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

	// ── 6. Will the workers you create there have what they need? ───
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
		ready: {
			creds,
			domain,
			prepared: boundary.prepared,
			lookupPush,
			locationPush,
			locations,
		},
		featureFlags,
	};
}
