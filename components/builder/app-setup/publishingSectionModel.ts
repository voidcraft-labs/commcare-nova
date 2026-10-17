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
import {
	type NextPublishAction,
	nextPublishAction,
} from "@/lib/deployment/resources";
import {
	type AppDeploymentNoticeEntry,
	type DeploymentNoticeEntry,
	orderNoticeEntries,
} from "@/lib/notices/migrationNotice";

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
