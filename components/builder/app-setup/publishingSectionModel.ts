/**
 * Pure derivations for the Publishing section and the Publish dialog's
 * compact target rows.
 *
 * The record fold lives here because two surfaces hold deployment records
 * now — the dialog's per-open store and the section's durable one — and
 * they must agree on what "the same target" means. Both key a record on
 * `(server, domain)`: CommCare HQ's US, India, and EU installations can
 * hold unrelated project spaces of the same name, so the domain alone is
 * not an identity.
 */

import {
	type CommCareServer,
	DEPLOYMENT_PROGRESS_STATES,
	type DeploymentProgressState,
	deploymentDisplaysAsReached,
} from "@/lib/deployment";
import type { DeploymentView } from "@/lib/deployment/actions";
import type { ProjectSpaceConfirmationChecks } from "@/lib/deployment/confirmations";
import {
	activeRemoteApp,
	type NextPublishAction,
	nextPublishAction,
} from "@/lib/deployment/resources";
import type {
	DeploymentConfirmation,
	DeploymentConfirmationKey,
	DeploymentConfirmationKind,
	DeploymentConfirmationNeeded,
} from "@/lib/deployment/types";
import {
	type AppDeploymentNoticeEntry,
	type DeploymentNoticeEntry,
	orderNoticeEntries,
} from "@/lib/notices/migrationNotice";
import {
	CONNECT_FORWARDER,
	FLAT_LOCATION_FIXTURE,
	isPlanFeatureId,
	PLAN_FEATURE_IDS,
	PLAN_FEATURES,
} from "@/lib/publish/planFeatures";

/**
 * What each rung means, in the author's words. One home for the ladder,
 * the compact rows, and anything else that names a deployment state, so
 * two surfaces cannot describe the same record differently.
 */
export const DEPLOYMENT_STATE_LABELS: Readonly<
	Record<DeploymentProgressState, string>
> = {
	preflight: "Checked",
	resources: "Tables in place",
	uploaded: "On CommCare HQ",
	built: "Version made",
	released: "Released",
	runnable: "Ready for workers",
};

/** One record per `(server, domain)` — the fold's identity. */
export function deploymentViewKey(view: DeploymentView): string {
	const record = view.deployment.deployment;
	return `${record.server}\u0000${record.domain}`;
}

/**
 * Fold one fresh record into a held list: replace the record for the same
 * target, or put a new target first (the freshest answer is what somebody
 * just acted on). This is the ONE upsert both the dialog and the section
 * apply, so a record can never render twice with disagreeing contents.
 */
export function upsertDeploymentViews(
	views: readonly DeploymentView[],
	next: DeploymentView,
): readonly DeploymentView[] {
	const key = deploymentViewKey(next);
	const index = views.findIndex((view) => deploymentViewKey(view) === key);
	return index === -1
		? [next, ...views]
		: views.map((view, at) => (at === index ? next : view));
}

// ── The section's record load ─────────────────────────────────────────────

/**
 * The section's held records plus the load in flight. `views` is the last
 * good answer and survives a failed reload, so a network blip degrades to
 * a warning beside real data rather than a blank screen; `null` means no
 * load has ever succeeded. `generation` is the stale-response guard: only
 * the answer to the LATEST load may settle the state, because a slow first
 * read landing after a fast retry would silently reinstate old records.
 */
export interface PublishingRecords {
	readonly generation: number;
	readonly pending: boolean;
	readonly views: readonly DeploymentView[] | null;
	/** Why the latest load failed, or null. A warning when `views` holds data. */
	readonly failure: string | null;
}

export const INITIAL_PUBLISHING_RECORDS: PublishingRecords = {
	generation: 0,
	pending: false,
	views: null,
	failure: null,
};

/** Open a load under `generation`. Held records stay on screen meanwhile. */
export function beginRecordsLoad(
	state: PublishingRecords,
	generation: number,
): PublishingRecords {
	return { ...state, generation, pending: true, failure: null };
}

/**
 * Settle a load's answer. An answer for a superseded generation changes
 * nothing — a retry already owns the state it would overwrite.
 */
export function resolveRecordsLoad(
	state: PublishingRecords,
	generation: number,
	outcome:
		| { readonly ok: true; readonly views: readonly DeploymentView[] }
		| { readonly ok: false; readonly message: string },
): PublishingRecords {
	if (generation !== state.generation) return state;
	return outcome.ok
		? { ...state, pending: false, views: outcome.views, failure: null }
		: { ...state, pending: false, failure: outcome.message };
}

/**
 * Fold a refresh, publish, or provisioning answer into the held records.
 *
 * The upsert takes over the state under a FRESH `generation` (the caller
 * bumps its counter and passes the new value), because the answer it
 * carries is newer than anything a load in flight will return: without
 * that, a slow reload resolving after a Check status would wholesale-
 * replace the views and quietly wind the refreshed record back. The
 * superseded load's answer then mismatches and is ignored, so `pending`
 * has to settle here — a load that can no longer settle it would leave
 * the section refreshing forever.
 */
export function applyRecordUpsert(
	state: PublishingRecords,
	view: DeploymentView,
	generation: number,
): PublishingRecords {
	return {
		...state,
		generation,
		pending: false,
		views: upsertDeploymentViews(state.views ?? [], view),
	};
}

/**
 * Whether this app is published to some project space: a record holds a
 * live app mapping. `null` is records no load has answered yet, which
 * answers false, so a note that depends on it never shows on a guess.
 */
export function publishedAnywhere(
	views: readonly DeploymentView[] | null,
): boolean {
	return (
		views?.some((view) => activeRemoteApp(view.deployment) !== null) ?? false
	);
}

/**
 * Whether a note that warns what a change does once the app is published
 * shows. A held record answers it, a stale one included when a refresh
 * failed. With no record held, a failed load can't rule publishing out, so
 * the warning shows rather than hide behind the failure; a load still on its
 * way shows nothing yet.
 */
export function mayBePublished(records: PublishingRecords): boolean {
	return records.views !== null
		? publishedAnywhere(records.views)
		: records.failure !== null;
}

// ── The dialog's compact target rows ──────────────────────────────────────

/** One line per target for the dialog: where the app already is, in brief. */
export interface CompactTargetRow {
	readonly key: string;
	readonly domain: string;
	/** Which CommCare HQ installation holds the record. */
	readonly server: CommCareServer;
	/** The furthest rung the record honestly shows, or the stopped notice. */
	readonly statusLabel: string;
	/** True when the record is a refused publish rather than a reached rung. */
	readonly stopped: boolean;
	/**
	 * What publishing again does there: create an app, fill the empty one an
	 * earlier try made, or update the app that is there.
	 */
	readonly nextPublish: NextPublishAction;
	/**
	 * Whether the connected key can publish here at all. False when the
	 * record lives on a different CommCare HQ installation than the key
	 * authenticates against — US, India, and EU share no accounts — so the
	 * dialog must not describe what publishing again "will do" to it.
	 */
	readonly reachable: boolean;
}

export function compactTargetRows(
	views: readonly DeploymentView[],
	connectionServer: CommCareServer | null,
): readonly CompactTargetRow[] {
	return views.map((view) => {
		const record = view.deployment.deployment;
		const stopped = record.state === "incomplete";
		return {
			key: deploymentViewKey(view),
			domain: record.domain,
			server: record.server,
			statusLabel: stopped
				? "Publish stopped partway"
				: (furthestReachedLabel(view) ?? "Not on this project space yet"),
			stopped,
			nextPublish: nextPublishAction(view.deployment),
			reachable: record.server === connectionServer,
		};
	});
}

function furthestReachedLabel(view: DeploymentView): string | null {
	const record = view.deployment.deployment;
	let furthest: DeploymentProgressState | null = null;
	for (const state of DEPLOYMENT_PROGRESS_STATES) {
		if (deploymentDisplaysAsReached(record, state)) furthest = state;
	}
	return furthest === null ? null : DEPLOYMENT_STATE_LABELS[furthest];
}

// ── Publish again ─────────────────────────────────────────────────────────

/**
 * The domain a "Publish again" on this record should preseed, or null when
 * the connected CommCare HQ key cannot upload there — a button that opens
 * the dialog onto an empty select promises something the connection cannot
 * do, so the affordance is withheld instead.
 *
 * "Cannot upload there" has two halves, and the server half comes first: a
 * key authenticates against exactly one CommCare HQ installation, so a
 * record on another server is out of reach even when the key's own server
 * happens to hold a project space of the same name — preseeding that
 * same-named space would aim the publish at a stranger's.
 */
export function publishAgainDomain(
	view: DeploymentView,
	connection: {
		readonly server: CommCareServer | null;
		readonly availableDomains: readonly { name: string }[];
	},
): string | null {
	const record = view.deployment.deployment;
	if (record.server !== connection.server) return null;
	return connection.availableDomains.some(
		(candidate) => candidate.name === record.domain,
	)
		? record.domain
		: null;
}

/**
 * What the dialog's Project space select opens on: the requested target
 * when the key reaches it, else the sole space of a single-space key, else
 * nothing chosen. The requested arm never invents a choice — a domain the
 * key cannot upload to falls through to the ordinary defaults.
 */
export function preseededDomainSelection(
	requestedDomain: string | undefined,
	availableDomains: readonly { name: string }[],
): string {
	if (
		requestedDomain !== undefined &&
		availableDomains.some((domain) => domain.name === requestedDomain)
	) {
		return requestedDomain;
	}
	return availableDomains.length === 1 ? availableDomains[0].name : "";
}

// ── Migration notice lines ────────────────────────────────────────────────

/**
 * The migration notice entries one card still shows, in the order of
 * `DEPLOYMENT_NOTICE_REASONS`. An entry stays until a publish has happened
 * there since its notice was written: the deployment's live `app` mapping
 * was pushed later than the notice's `createdAt`. A deployment with no live
 * `app` mapping, or one never pushed, keeps them.
 */
export function publishingCardNoticeEntries(
	entries: readonly AppDeploymentNoticeEntry[],
	view: Pick<DeploymentView, "deployment">,
): readonly DeploymentNoticeEntry[] {
	const deploymentId = view.deployment.deployment.id;
	const pushedAt =
		view.deployment.active.find((resource) => resource.kind === "app")
			?.pushedAt ?? null;
	const kept = entries.filter(
		(item) =>
			item.entry.deployment.deploymentId === deploymentId &&
			(pushedAt === null || Date.parse(pushedAt) <= Date.parse(item.createdAt)),
	);
	return orderNoticeEntries(kept.map((item) => item.entry)).filter(
		(entry): entry is DeploymentNoticeEntry => entry.kind === "deployment",
	);
}

// ── What a publish asks a person to confirm ───────────────────────────────

/**
 * One thing the Publish dialog asks a person to confirm about the selected
 * project space: the words to ask it in, and the key that names it back.
 */
export interface ConfirmationRequest {
	readonly key: DeploymentConfirmationKey;
	readonly kind: DeploymentConfirmationKind;
	readonly label: string;
	/** The current plans that include it; empty for a setting no plan decides. */
	readonly plans: string;
	readonly consequence: string;
	readonly reasons: readonly string[];
	/** What a person can do where the project space lacks it, or null where Nova has nothing to offer. */
	readonly whereMissing: string | null;
}

/** The key a caller names back for one need, or null for one Nova no longer knows. */
function requestKey(
	kind: DeploymentConfirmationKind,
	subject: string,
): DeploymentConfirmationKey | null {
	switch (kind) {
		case "plan-feature":
			return isPlanFeatureId(subject) ? { kind, subject } : null;
		case "flat-location-fixture":
		case "connect-forwarder":
			return { kind };
	}
}

/** Whether two keys name the same thing. */
export function sameConfirmationKey(
	a: DeploymentConfirmationKey,
	b: DeploymentConfirmationKey,
): boolean {
	return (
		a.kind === b.kind &&
		(a.kind !== "plan-feature" ||
			(b.kind === "plan-feature" && a.subject === b.subject))
	);
}

/** Every surface's order: the plan features as `PLAN_FEATURES` lists them, then the flat location list, then the Connect forwarder. */
function requestOrder(key: DeploymentConfirmationKey): number {
	switch (key.kind) {
		case "plan-feature":
			return PLAN_FEATURE_IDS.indexOf(key.subject);
		case "flat-location-fixture":
			return PLAN_FEATURE_IDS.length;
		case "connect-forwarder":
			return PLAN_FEATURE_IDS.length + 1;
	}
}

/** A check row as a request: the check's own words, its `where_missing` among them. */
function fromCheck(
	row: {
		readonly label: string;
		readonly consequence: string;
		readonly reasons: readonly string[];
		readonly where_missing: string | null;
	},
	plans: string,
): Omit<ConfirmationRequest, "key" | "kind"> {
	return {
		label: row.label,
		plans,
		consequence: row.consequence,
		reasons: row.reasons,
		whereMissing: row.where_missing,
	};
}

/**
 * What the Publish dialog asks a person to confirm before a publish to the
 * selected project space: every need the pre-publish check reports with no
 * confirmation on record there, and every need a refusal just named, each
 * once. A refusal is the newer word, so its wording wins where both name a
 * need. Nothing confirmed on record is asked again.
 */
export function confirmationRequests(
	checks: ProjectSpaceConfirmationChecks | null,
	refused: readonly DeploymentConfirmationNeeded[],
): readonly ConfirmationRequest[] {
	const requests: ConfirmationRequest[] = [];
	const add = (
		kind: DeploymentConfirmationKind,
		subject: string,
		need: Omit<ConfirmationRequest, "key" | "kind">,
	) => {
		const key = requestKey(kind, subject);
		if (key === null) return;
		if (requests.some((request) => sameConfirmationKey(request.key, key))) {
			return;
		}
		requests.push({ key, kind, ...need });
	};
	for (const need of refused) add(need.kind, need.subject, need);
	if (checks !== null) {
		for (const feature of checks.plan_features) {
			if (feature.state === "needs_confirmation") {
				add("plan-feature", feature.id, fromCheck(feature, feature.plans));
			}
		}
		if (checks.flat_location_fixture?.state === "needs_confirmation") {
			add(
				"flat-location-fixture",
				"flat-location-fixture",
				fromCheck(checks.flat_location_fixture, ""),
			);
		}
		if (checks.connect_forwarder?.state === "needs_confirmation") {
			add(
				"connect-forwarder",
				"connect-forwarder",
				fromCheck(checks.connect_forwarder, ""),
			);
		}
	}
	return requests.sort((a, b) => requestOrder(a.key) - requestOrder(b.key));
}

/**
 * The pre-publish check's rows once a publish there has landed. The check
 * was read before the publish, so a row it reported as needing confirmation
 * may now be answered by what the publish stored; each such row reads as
 * the deployment holds it, with who confirmed it and when, so a republish
 * from the same dialog asks only what is still unanswered.
 */
export function withLandedConfirmations(
	checks: ProjectSpaceConfirmationChecks,
	live: readonly DeploymentConfirmation[],
): ProjectSpaceConfirmationChecks {
	const answer = <Row extends { readonly state: string }>(
		row: Row,
		kind: DeploymentConfirmationKind,
		subject: string,
	): Row => {
		const held = live.find(
			(confirmation) =>
				confirmation.kind === kind && confirmation.subject === subject,
		);
		return held === undefined
			? row
			: {
					...row,
					state: "confirmed",
					confirmed_by: held.confirmedByName,
					confirmed_at: held.confirmedAt,
				};
	};
	return {
		plan_features: checks.plan_features.map((feature) =>
			answer(feature, "plan-feature", feature.id),
		),
		flat_location_fixture:
			checks.flat_location_fixture === null
				? null
				: answer(
						checks.flat_location_fixture,
						"flat-location-fixture",
						"flat-location-fixture",
					),
		connect_forwarder:
			checks.connect_forwarder === null
				? null
				: answer(
						checks.connect_forwarder,
						"connect-forwarder",
						"connect-forwarder",
					),
	};
}

/** Whether every request has been ticked, so a publish can go ahead. */
export function everyConfirmationGiven(
	requests: readonly ConfirmationRequest[],
	given: readonly DeploymentConfirmationKey[],
): boolean {
	return requests.every((request) =>
		given.some((key) => sameConfirmationKey(key, request.key)),
	);
}

/** One confirmation on record, as the deployment card lists it. */
export interface LiveConfirmationRow {
	readonly key: DeploymentConfirmationKey;
	/** What the dialog row that asked for it was called. */
	readonly label: string;
	/** The member's display name, or "A former member". */
	readonly confirmedBy: string;
	readonly confirmedAt: string;
}

/**
 * What a person confirmed about this card's project space and has not
 * withdrawn, in every surface's order. A plan feature Nova no longer knows
 * is left out: nothing asks for it, so there is nothing to withdraw.
 */
export function liveConfirmationRows(
	confirmations: readonly DeploymentConfirmation[],
): readonly LiveConfirmationRow[] {
	return confirmations
		.flatMap((confirmation): LiveConfirmationRow[] => {
			const key = requestKey(confirmation.kind, confirmation.subject);
			if (key === null) return [];
			return [
				{
					key,
					label:
						key.kind === "plan-feature"
							? PLAN_FEATURES[key.subject].label
							: key.kind === "flat-location-fixture"
								? FLAT_LOCATION_FIXTURE.label
								: CONNECT_FORWARDER.label,
					confirmedBy: confirmation.confirmedByName,
					confirmedAt: confirmation.confirmedAt,
				},
			];
		})
		.sort((a, b) => requestOrder(a.key) - requestOrder(b.key));
}
