import { describe, expect, it } from "vitest";
import type {
	DeploymentPhaseOutcomes,
	DeploymentRecord,
	DeploymentResource,
	DeploymentState,
} from "@/lib/deployment";
import type { DeploymentView } from "@/lib/deployment/actions";
import type { DeploymentConfirmation } from "@/lib/deployment/types";
import { asUuid } from "@/lib/domain/uuid";
import type { AppDeploymentNoticeEntry } from "@/lib/notices/migrationNotice";
import {
	PUBLISHING_STOPPED_ROW,
	STOP_PUBLISHING_FAILED,
	STOP_PUBLISHING_UNANSWERED,
} from "@/lib/publish/bringInCopy";
import type { FirstPublishView } from "@/lib/publish/firstPublishChangeIds";
import {
	COMMTRACK_OFF,
	CONNECT_FORWARDER,
	FLAT_LOCATION_FIXTURE,
	FORM_ENTRY_SYNC_OFF,
	PLAN_FEATURES,
	PROJECT_SPACE_SETTINGS,
} from "@/lib/publish/planFeatures";
import {
	endedLine,
	PUBLISH_PLAN_CREATES_BESIDE,
} from "@/lib/publish/stopPublishing";
import {
	applyRecordUpsert,
	beginRecordsLoad,
	broughtInElsewhere,
	broughtInOf,
	cardKind,
	checkStatusOffered,
	compactTargetRows,
	confirmationRequests,
	deploymentViewKey,
	endedCardOf,
	everyConfirmationGiven,
	INITIAL_PUBLISHING_RECORDS,
	liveConfirmationRows,
	mayBePublished,
	preseededDomainSelection,
	publishAgainDomain,
	publishedAnywhere,
	publishingCardNoticeEntries,
	readNotPublishedSince,
	resolveRecordsLoad,
	stopFailureSentence,
	stopPublishingOffered,
	upsertDeploymentViews,
	withLandedConfirmations,
} from "../publishingSectionModel";

const NO_PHASES: DeploymentPhaseOutcomes = {
	preflight: null,
	resources: null,
	upload: null,
	build: null,
	release: null,
	probe: null,
};

function view(overrides: {
	server?: DeploymentRecord["server"];
	domain?: string;
	state?: DeploymentState;
	resumePhase?: DeploymentRecord["resumePhase"];
	phases?: Partial<DeploymentPhaseOutcomes>;
	active?: readonly DeploymentResource[];
	superseded?: readonly DeploymentResource[];
	confirmations?: readonly DeploymentConfirmation[];
	firstPublish?: FirstPublishView | null;
}): DeploymentView {
	const record: DeploymentRecord = {
		id: "dep-1",
		appId: "app-1",
		projectId: "project-1",
		server: overrides.server ?? "production",
		domain: overrides.domain ?? "clinic-network",
		state: overrides.state ?? "uploaded",
		resumePhase: overrides.resumePhase ?? null,
		phases: { ...NO_PHASES, ...overrides.phases },
		createdBy: "user-1",
		createdAt: "2026-08-01T00:00:00Z",
		updatedAt: "2026-08-01T00:00:00Z",
		lastObservedAt: null,
		offeredLogoContentHash: null,
		targetEmptyCaseListText: null,
		endings: 0,
	};
	return {
		deployment: {
			deployment: record,
			active: overrides.active ?? [],
			superseded: overrides.superseded ?? [],
			confirmations: overrides.confirmations ?? [],
		},
		artifact: {
			server: record.server,
			domain: record.domain,
			hqAppId: null,
			sections: [],
		},
		leftBehind: [],
		kept: null,
		firstPublish: overrides.firstPublish ?? null,
	};
}

function appResource(
	pushedAt: string | null = "2026-08-01T00:00:00Z",
): DeploymentResource {
	return {
		deploymentId: "dep-1",
		kind: "app",
		novaResourceId: "app-1",
		remoteId: "hq-app-1",
		ownership: "nova-created",
		pushedIdentity: null,
		adoptedAt: null,
		adoptedBy: null,
		pushedRevision: 3,
		pushToken: "01992000-0000-7000-8000-000000000001",
		pushedAt,
		remoteRevision: null,
		remoteObservedAt: null,
		supersededAt: null,
		remoteMissingAt: null,
		adoptedByName: null,
		releasedAt: null,
		endedReason: null,
		endedByName: null,
		heldByAnotherApp: false,
	};
}

describe("upsertDeploymentViews", () => {
	it("keys a record on server plus domain, not domain alone", () => {
		const us = view({ server: "production", domain: "shared-name" });
		const india = view({ server: "india", domain: "shared-name" });
		const held = upsertDeploymentViews([us], india);
		expect(held).toHaveLength(2);
		expect(deploymentViewKey(us)).not.toBe(deploymentViewKey(india));
	});

	it("replaces the same target in place, preserving its position", () => {
		const first = view({ domain: "alpha" });
		const second = view({ domain: "beta" });
		const fresher = view({ domain: "beta", state: "released" });
		const held = upsertDeploymentViews([first, second], fresher);
		expect(held).toHaveLength(2);
		expect(held[1]).toBe(fresher);
		expect(held[0]).toBe(first);
	});

	it("puts a brand-new target first", () => {
		const held = upsertDeploymentViews(
			[view({ domain: "alpha" })],
			view({ domain: "beta" }),
		);
		expect(held.map((v) => v.deployment.deployment.domain)).toEqual([
			"beta",
			"alpha",
		]);
	});
});

describe("the section's record load", () => {
	it("keeps held records on screen while a reload is pending", () => {
		const loaded = resolveRecordsLoad(
			beginRecordsLoad(INITIAL_PUBLISHING_RECORDS, 1),
			1,
			{ ok: true, views: [view({})] },
		);
		const reloading = beginRecordsLoad(loaded, 2);
		expect(reloading.pending).toBe(true);
		expect(reloading.views).toHaveLength(1);
		expect(reloading.failure).toBeNull();
	});

	it("ignores an answer for a superseded generation", () => {
		const state = beginRecordsLoad(INITIAL_PUBLISHING_RECORDS, 2);
		const settled = resolveRecordsLoad(state, 1, {
			ok: true,
			views: [view({})],
		});
		expect(settled).toBe(state);
	});

	it("ignores a superseded refusal without hiding the newer successful records", () => {
		const latest = resolveRecordsLoad(
			beginRecordsLoad(INITIAL_PUBLISHING_RECORDS, 2),
			2,
			{ ok: true, views: [view({ state: "released" })] },
		);
		expect(
			resolveRecordsLoad(latest, 1, {
				ok: false,
				message: "Old request failed",
			}),
		).toBe(latest);
	});

	it("degrades a failed reload to a failure beside the held records", () => {
		const loaded = resolveRecordsLoad(
			beginRecordsLoad(INITIAL_PUBLISHING_RECORDS, 1),
			1,
			{ ok: true, views: [view({})] },
		);
		const failed = resolveRecordsLoad(beginRecordsLoad(loaded, 2), 2, {
			ok: false,
			message: "The network dropped",
		});
		expect(failed.views).toHaveLength(1);
		expect(failed.failure).toBe("The network dropped");
		expect(failed.pending).toBe(false);
	});

	it("folds a refresh answer into the held records", () => {
		const loaded = resolveRecordsLoad(
			beginRecordsLoad(INITIAL_PUBLISHING_RECORDS, 1),
			1,
			{ ok: true, views: [view({ state: "uploaded" })] },
		);
		const refreshed = applyRecordUpsert(loaded, view({ state: "released" }), 2);
		expect(refreshed.views).toHaveLength(1);
		expect(refreshed.views?.[0].deployment.deployment.state).toBe("released");
	});

	it("accepts an upsert before any load has succeeded", () => {
		const state = applyRecordUpsert(INITIAL_PUBLISHING_RECORDS, view({}), 1);
		expect(state.views).toHaveLength(1);
	});

	it("supersedes a load in flight, so its stale answer cannot wind back", () => {
		const loading = beginRecordsLoad(
			resolveRecordsLoad(beginRecordsLoad(INITIAL_PUBLISHING_RECORDS, 1), 1, {
				ok: true,
				views: [view({ state: "uploaded" })],
			}),
			2,
		);
		// A Check status answers while the reload is still on the wire.
		const refreshed = applyRecordUpsert(
			loading,
			view({ state: "released" }),
			3,
		);
		expect(refreshed.pending).toBe(false);
		// The reload finally answers with the older record; it must be ignored.
		const settled = resolveRecordsLoad(refreshed, 2, {
			ok: true,
			views: [view({ state: "uploaded" })],
		});
		expect(settled).toBe(refreshed);
		expect(settled.views?.[0].deployment.deployment.state).toBe("released");
	});
});

describe("compactTargetRows", () => {
	it("labels a reached record with its furthest rung", () => {
		const rows = compactTargetRows([view({ state: "released" })], "production");
		expect(rows[0].statusLabel).toBe("Released");
		expect(rows[0].stopped).toBe(false);
	});

	it("labels a refused record as stopped partway, whatever it reached", () => {
		const rows = compactTargetRows(
			[
				view({
					state: "incomplete",
					resumePhase: "upload",
					phases: {
						preflight: { status: "succeeded", at: "2026-08-01T00:00:00Z" },
						resources: { status: "succeeded", at: "2026-08-01T00:00:00Z" },
					},
				}),
			],
			"production",
		);
		expect(rows[0].statusLabel).toBe("Publish stopped partway");
		expect(rows[0].stopped).toBe(true);
	});

	it("says what the next publish does: update the app there, fill the empty one, or create", () => {
		const rows = compactTargetRows(
			[
				view({ domain: "updates", active: [appResource()] }),
				view({
					domain: "shell",
					active: [{ ...appResource(null), pushedRevision: null }],
				}),
				view({
					domain: "gone",
					active: [
						{ ...appResource(), remoteMissingAt: "2026-08-02T00:00:00Z" },
					],
				}),
				view({ domain: "fresh" }),
			],
			"production",
		);
		expect(rows.map((row) => [row.domain, row.nextPublish])).toEqual([
			["updates", "updates"],
			["shell", "fills-shell"],
			["gone", "creates"],
			["fresh", "creates"],
		]);
	});

	it("marks a record on another CommCare HQ installation unreachable", () => {
		const rows = compactTargetRows(
			[view({ server: "india" }), view({ server: "production" })],
			"production",
		);
		expect(rows[0].reachable).toBe(false);
		expect(rows[0].server).toBe("india");
		expect(rows[1].reachable).toBe(true);
	});
});

describe("publishAgainDomain", () => {
	it("offers the record's own domain when the connection reaches it", () => {
		const target = view({ domain: "clinic-network" });
		expect(
			publishAgainDomain(target, {
				server: "production",
				availableDomains: [{ name: "clinic-network" }],
			}),
		).toBe("clinic-network");
	});

	it("withholds the affordance when the key cannot upload there", () => {
		const target = view({ domain: "clinic-network" });
		expect(
			publishAgainDomain(target, {
				server: "production",
				availableDomains: [{ name: "another-space" }],
			}),
		).toBeNull();
		expect(
			publishAgainDomain(target, {
				server: "production",
				availableDomains: [],
			}),
		).toBeNull();
	});

	it("withholds it for a same-named space on a different server", () => {
		const target = view({ server: "india", domain: "clinic-network" });
		expect(
			publishAgainDomain(target, {
				server: "production",
				availableDomains: [{ name: "clinic-network" }],
			}),
		).toBeNull();
		expect(
			publishAgainDomain(target, {
				server: null,
				availableDomains: [{ name: "clinic-network" }],
			}),
		).toBeNull();
	});
});

describe("preseededDomainSelection", () => {
	const reachable = [{ name: "alpha" }, { name: "beta" }];

	it("opens on the requested target when the key reaches it", () => {
		expect(preseededDomainSelection("beta", reachable)).toBe("beta");
	});

	it("never invents a choice for an unreachable request", () => {
		expect(preseededDomainSelection("gamma", reachable)).toBe("");
	});

	it("falls back to the sole space of a single-space key", () => {
		expect(preseededDomainSelection(undefined, [{ name: "only" }])).toBe(
			"only",
		);
		expect(preseededDomainSelection("gamma", [{ name: "only" }])).toBe("only");
	});

	it("leaves a multi-space key unchosen with no request", () => {
		expect(preseededDomainSelection(undefined, reachable)).toBe("");
	});
});

describe("publishingCardNoticeEntries", () => {
	const NOTICE_AT = "2026-10-06T09:00:00.000Z";
	const entry = (deploymentId: string): AppDeploymentNoticeEntry => ({
		noticeId: "01992000-0000-7000-8000-0000000000aa",
		createdAt: NOTICE_AT,
		entry: {
			kind: "deployment",
			reason: "deep-links-need-republish",
			deployment: {
				deploymentId: asUuid(deploymentId),
				server: "production",
				domain: "clinic-network",
			},
		},
	});
	const DEPLOYMENT = "01992000-0000-7000-8000-000000000011";
	const OTHER = "01992000-0000-7000-8000-000000000022";
	const card = (active: readonly DeploymentResource[]) => {
		const base = view({ active });
		return {
			...base,
			deployment: {
				...base.deployment,
				deployment: { ...base.deployment.deployment, id: DEPLOYMENT },
			},
		};
	};

	it("shows only this card's project space", () => {
		const kept = publishingCardNoticeEntries(
			[entry(DEPLOYMENT), entry(OTHER)],
			card([]),
		);
		expect(kept.map((item) => item.deployment.deploymentId)).toEqual([
			DEPLOYMENT,
		]);
	});

	it("keeps the lines while the deployment has no live app mapping or was never pushed", () => {
		expect(
			publishingCardNoticeEntries([entry(DEPLOYMENT)], card([])),
		).toHaveLength(1);
		expect(
			publishingCardNoticeEntries(
				[entry(DEPLOYMENT)],
				card([appResource(null)]),
			),
		).toHaveLength(1);
	});

	it("keeps the lines while the last push is not later than the notice", () => {
		expect(
			publishingCardNoticeEntries(
				[entry(DEPLOYMENT)],
				card([appResource("2026-10-01T00:00:00.000Z")]),
			),
		).toHaveLength(1);
		expect(
			publishingCardNoticeEntries(
				[entry(DEPLOYMENT)],
				card([appResource(NOTICE_AT)]),
			),
		).toHaveLength(1);
	});

	it("hides the lines once a publish there is later than the notice", () => {
		expect(
			publishingCardNoticeEntries(
				[entry(DEPLOYMENT)],
				card([appResource("2026-10-06T09:00:00.001Z")]),
			),
		).toEqual([]);
	});
});

describe("publishedAnywhere", () => {
	it("answers true when a record holds a live app mapping", () => {
		expect(
			publishedAnywhere([
				view({ domain: "first" }),
				view({ domain: "second", active: [appResource()] }),
			]),
		).toBe(true);
	});

	it("answers false for an app never published, a mapping that was superseded, and before any load has answered", () => {
		expect(publishedAnywhere([])).toBe(false);
		expect(publishedAnywhere([view({ state: "preflight" })])).toBe(false);
		const superseded = view({});
		expect(
			publishedAnywhere([
				{
					...superseded,
					deployment: {
						...superseded.deployment,
						superseded: [appResource()],
					},
				},
			]),
		).toBe(false);
		expect(publishedAnywhere(null)).toBe(false);
	});
});

describe("mayBePublished", () => {
	const published = [view({ active: [appResource()] })];

	it("answers from the held records, a stale copy after a failed refresh included", () => {
		const loaded = resolveRecordsLoad(
			beginRecordsLoad(INITIAL_PUBLISHING_RECORDS, 1),
			1,
			{ ok: true, views: published },
		);
		expect(mayBePublished(loaded)).toBe(true);
		const stale = resolveRecordsLoad(beginRecordsLoad(loaded, 2), 2, {
			ok: false,
			message: "Nova couldn't load it.",
		});
		expect(mayBePublished(stale)).toBe(true);
		expect(
			mayBePublished(
				resolveRecordsLoad(beginRecordsLoad(INITIAL_PUBLISHING_RECORDS, 1), 1, {
					ok: true,
					views: [],
				}),
			),
		).toBe(false);
	});

	it("shows the warning when a load failed with nothing held, and nothing while the first load is on its way", () => {
		const pending = beginRecordsLoad(INITIAL_PUBLISHING_RECORDS, 1);
		expect(mayBePublished(pending)).toBe(false);
		expect(
			mayBePublished(
				resolveRecordsLoad(pending, 1, {
					ok: false,
					message: "Nova couldn't load it.",
				}),
			),
		).toBe(true);
	});
});

describe("what a publish asks a person to confirm", () => {
	/* Each carries what a person can do where the project space lacks it,
	 * under the check's key and the refusal's alike. */
	const LOOKUP = {
		...PLAN_FEATURES["lookup-tables"],
		reasons: ["The app reads data from a lookup table."],
		where_missing: null,
		whereMissing: null,
	};
	const WORKER = {
		...PLAN_FEATURES["worker-records"],
		reasons: ["Intake reads worker information."],
		where_missing: null,
		whereMissing: null,
	};
	const FIXTURE = {
		label: FLAT_LOCATION_FIXTURE.label,
		consequence: FLAT_LOCATION_FIXTURE.consequence,
		reasons: ["Intake sets a case's owner from a place in your organization."],
		where_missing: FLAT_LOCATION_FIXTURE.whereMissing,
		whereMissing: FLAT_LOCATION_FIXTURE.whereMissing,
	};
	const SYNC = {
		label: PROJECT_SPACE_SETTINGS["form-entry-sync-off"].label,
		consequence: PROJECT_SPACE_SETTINGS["form-entry-sync-off"].consequence,
		reasons: [
			"Visit works on a case chosen in Find patients, a menu with Search.",
		],
		where_missing: FORM_ENTRY_SYNC_OFF.whereMissing,
		whereMissing: FORM_ENTRY_SYNC_OFF.whereMissing,
	};

	it("asks for each need the check reports with nothing on record, and not for one confirmed there", () => {
		const requests = confirmationRequests(
			{
				plan_features: [
					{ ...WORKER, state: "needs_confirmation" },
					{
						...LOOKUP,
						state: "confirmed",
						confirmed_by: "Ada",
						confirmed_at: "2026-10-01T00:00:00Z",
					},
				],
				flat_location_fixture: { ...FIXTURE, state: "needs_confirmation" },
				connect_forwarder: null,
				form_entry_sync_off: null,
				commtrack_off: null,
				placement_moves: null,
			},
			[],
		);
		expect(requests.map((request) => request.key)).toStrictEqual([
			{ kind: "plan-feature", subject: "worker-records" },
			{ kind: "flat-location-fixture" },
		]);
		expect(requests[1]).toMatchObject({
			plans: "",
			reasons: FIXTURE.reasons,
			whereMissing: FLAT_LOCATION_FIXTURE.whereMissing,
		});
		expect(requests[0]?.whereMissing).toBeNull();
	});

	it("adds what a refusal named, once, in every surface's order", () => {
		const requests = confirmationRequests(
			{
				plan_features: [{ ...WORKER, state: "needs_confirmation" }],
				flat_location_fixture: null,
				connect_forwarder: null,
				form_entry_sync_off: null,
				commtrack_off: null,
				placement_moves: null,
			},
			[
				{
					kind: "connect-forwarder",
					subject: "connect-forwarder",
					label: CONNECT_FORWARDER.label,
					plans: "",
					consequence: CONNECT_FORWARDER.consequence,
					reasons: ["Lesson sends a learn module to CommCare Connect."],
					whereMissing: CONNECT_FORWARDER.whereMissing,
				},
				{ kind: "plan-feature", subject: "lookup-tables", ...LOOKUP },
				{ kind: "plan-feature", subject: "worker-records", ...WORKER },
			],
		);
		expect(requests.map((request) => request.label)).toStrictEqual([
			WORKER.label,
			LOOKUP.label,
			CONNECT_FORWARDER.label,
		]);
	});

	it("asks for sync on form entry last, after the Connect forwarder, with its label from the setting's record", () => {
		const requests = confirmationRequests(
			{
				plan_features: [{ ...WORKER, state: "needs_confirmation" }],
				flat_location_fixture: null,
				connect_forwarder: null,
				form_entry_sync_off: { ...SYNC, state: "needs_confirmation" },
				commtrack_off: null,
				placement_moves: null,
			},
			[
				{
					kind: "connect-forwarder",
					subject: "connect-forwarder",
					label: CONNECT_FORWARDER.label,
					plans: "",
					consequence: CONNECT_FORWARDER.consequence,
					reasons: ["Lesson sends a learn module to CommCare Connect."],
					whereMissing: CONNECT_FORWARDER.whereMissing,
				},
			],
		);
		expect(requests.map((request) => request.key)).toStrictEqual([
			{ kind: "plan-feature", subject: "worker-records" },
			{ kind: "connect-forwarder" },
			{ kind: "form-entry-sync-off" },
		]);
		expect(requests[2]).toMatchObject({
			kind: "form-entry-sync-off",
			label: FORM_ENTRY_SYNC_OFF.label,
			plans: "",
			reasons: SYNC.reasons,
			whereMissing: FORM_ENTRY_SYNC_OFF.whereMissing,
		});
		const landed = withLandedConfirmations(
			{
				plan_features: [],
				flat_location_fixture: null,
				connect_forwarder: null,
				form_entry_sync_off: { ...SYNC, state: "needs_confirmation" },
				commtrack_off: null,
				placement_moves: null,
			},
			[
				{
					kind: "form-entry-sync-off",
					subject: "form-entry-sync-off",
					confirmedByName: "Ada",
					confirmedAt: "2026-10-16T00:00:00Z",
				},
			],
		);
		expect(landed.form_entry_sync_off).toMatchObject({
			state: "confirmed",
			confirmed_by: "Ada",
		});
		expect(confirmationRequests(landed, [])).toStrictEqual([]);
	});

	it("asks whether CommCare Supply is off after sync on form entry, and not again once a landed publish stored it", () => {
		const SUPPLY = {
			label: COMMTRACK_OFF.label,
			consequence: COMMTRACK_OFF.consequence,
			reasons: [
				"Visits shows its case list as its own menu item, in a menu CommCare HQ builds as advanced.",
			],
			where_missing: COMMTRACK_OFF.whereMissing,
			whereMissing: COMMTRACK_OFF.whereMissing,
		};
		const checked = {
			plan_features: [{ ...WORKER, state: "needs_confirmation" as const }],
			flat_location_fixture: null,
			connect_forwarder: null,
			form_entry_sync_off: { ...SYNC, state: "needs_confirmation" as const },
			commtrack_off: { ...SUPPLY, state: "needs_confirmation" as const },
			placement_moves: null,
		};
		const requests = confirmationRequests(checked, []);
		expect(requests.map((request) => request.key)).toStrictEqual([
			{ kind: "plan-feature", subject: "worker-records" },
			{ kind: "form-entry-sync-off" },
			{ kind: "commtrack-off" },
		]);
		expect(requests[2]).toMatchObject({
			kind: "commtrack-off",
			label: COMMTRACK_OFF.label,
			plans: "",
			consequence: COMMTRACK_OFF.consequence,
			reasons: SUPPLY.reasons,
			whereMissing: COMMTRACK_OFF.whereMissing,
		});
		const landed = withLandedConfirmations(checked, [
			{
				kind: "commtrack-off",
				subject: "commtrack-off",
				confirmedByName: "Ada",
				confirmedAt: "2026-11-10T00:00:00Z",
			},
		]);
		expect(landed.commtrack_off).toMatchObject({
			state: "confirmed",
			confirmed_by: "Ada",
			confirmed_at: "2026-11-10T00:00:00Z",
		});
		expect(
			confirmationRequests(landed, []).map((request) => request.key),
		).toStrictEqual([
			{ kind: "plan-feature", subject: "worker-records" },
			{ kind: "form-entry-sync-off" },
		]);
	});

	it("holds the publish until every request is ticked", () => {
		const requests = confirmationRequests(null, [
			{ kind: "plan-feature", subject: "worker-records", ...WORKER },
			{
				kind: "flat-location-fixture",
				subject: "flat-location-fixture",
				plans: "",
				...FIXTURE,
			},
		]);
		expect(
			everyConfirmationGiven(requests, [
				{ kind: "plan-feature", subject: "worker-records" },
			]),
		).toBe(false);
		expect(
			everyConfirmationGiven(requests, [
				{ kind: "flat-location-fixture" },
				{ kind: "plan-feature", subject: "worker-records" },
			]),
		).toBe(true);
		expect(everyConfirmationGiven([], [])).toBe(true);
	});

	it("asks nothing again on a republish from the same dialog once the landed publish stored what was ticked", () => {
		const checked = {
			plan_features: [
				{ ...WORKER, state: "needs_confirmation" as const },
				{ ...LOOKUP, state: "needs_confirmation" as const },
			],
			flat_location_fixture: {
				...FIXTURE,
				state: "needs_confirmation" as const,
			},
			connect_forwarder: null,
			form_entry_sync_off: null,
			commtrack_off: null,
			placement_moves: null,
		};
		const live: DeploymentConfirmation[] = [
			{
				kind: "plan-feature",
				subject: "worker-records",
				confirmedByName: "Ada",
				confirmedAt: "2026-10-16T00:00:00Z",
			},
			{
				kind: "flat-location-fixture",
				subject: "flat-location-fixture",
				confirmedByName: "Ada",
				confirmedAt: "2026-10-16T00:00:00Z",
			},
		];
		const landed = withLandedConfirmations(checked, live);
		expect(landed.plan_features[0]).toMatchObject({
			state: "confirmed",
			confirmed_by: "Ada",
			confirmed_at: "2026-10-16T00:00:00Z",
		});
		expect(landed.flat_location_fixture?.state).toBe("confirmed");
		/* What the landed publish did not store is still asked. */
		expect(
			confirmationRequests(landed, []).map((request) => request.key),
		).toStrictEqual([{ kind: "plan-feature", subject: "lookup-tables" }]);
		expect(everyConfirmationGiven(confirmationRequests(landed, []), [])).toBe(
			false,
		);
		const all = withLandedConfirmations(checked, [
			...live,
			{
				kind: "plan-feature",
				subject: "lookup-tables",
				confirmedByName: "Ada",
				confirmedAt: "2026-10-16T00:00:00Z",
			},
		]);
		expect(everyConfirmationGiven(confirmationRequests(all, []), [])).toBe(
			true,
		);
	});
});

describe("the confirmations a card lists", () => {
	const confirmed = (
		kind: DeploymentConfirmation["kind"],
		subject: string,
	): DeploymentConfirmation => ({
		kind,
		subject,
		confirmedByName: "Ada",
		confirmedAt: "2026-10-01T00:00:00Z",
	});

	it("names each by the row that asked for it, in every surface's order", () => {
		expect(
			liveConfirmationRows([
				confirmed("commtrack-off", "commtrack-off"),
				confirmed("form-entry-sync-off", "form-entry-sync-off"),
				confirmed("connect-forwarder", "connect-forwarder"),
				confirmed("plan-feature", "data-forwarding"),
				confirmed("flat-location-fixture", "flat-location-fixture"),
			]).map((row) => row.label),
		).toStrictEqual([
			PLAN_FEATURES["data-forwarding"].label,
			PROJECT_SPACE_SETTINGS["flat-location-fixture"].label,
			PROJECT_SPACE_SETTINGS["connect-forwarder"].label,
			PROJECT_SPACE_SETTINGS["form-entry-sync-off"].label,
			PROJECT_SPACE_SETTINGS["commtrack-off"].label,
		]);
	});

	it("leaves out a plan feature Nova no longer knows, which nothing asks for", () => {
		expect(
			liveConfirmationRows([confirmed("plan-feature", "retired-feature")]),
		).toStrictEqual([]);
	});

	it("drops a withdrawn confirmation once the withdrawal's record is folded in", () => {
		// Withdrawing answers with the record as it now stands; the one upsert
		// both surfaces apply replaces the card's record, so the row goes.
		const before = view({
			confirmations: [confirmed("plan-feature", "worker-records")],
		});
		const after = view({ confirmations: [] });
		const held = upsertDeploymentViews([before], after);
		expect(held).toHaveLength(1);
		expect(
			liveConfirmationRows(held[0].deployment.confirmations),
		).toStrictEqual([]);
	});
});

/** A live app mapping a bring-in recorded: `adopted`, with who and when. */
function adoptedApp(): DeploymentResource {
	return {
		...appResource(),
		ownership: "adopted",
		adoptedAt: "2026-09-10T09:30:00Z",
		adoptedBy: "user-7",
		adoptedByName: "Ada Lovelace",
	};
}

/** The app mapping a stop superseded, with who ended it and why. */
function endedApp(
	reason: "stopped" | "claimed-elsewhere" = "stopped",
): DeploymentResource {
	return {
		...appResource(),
		supersededAt: "2026-09-20T15:00:00Z",
		endedReason: reason,
		endedByName: "Grace Hopper",
	};
}

const FIRST_PUBLISH: FirstPublishView = {
	ids: ["forms-and-settings-rewritten"],
	touchesWorkers: false,
	of: "first-publish",
};

describe("where a card's app came from", () => {
	it("names who brought the app in and when, from the live adopted mapping", () => {
		expect(broughtInOf(view({ active: [adoptedApp()] }))).toStrictEqual({
			at: "2026-09-10T09:30:00Z",
			byName: "Ada Lovelace",
		});
	});

	it("says nothing of an app Nova made there, or of a deployment with no live app mapping", () => {
		expect(broughtInOf(view({ active: [appResource()] }))).toBeNull();
		expect(broughtInOf(view({ superseded: [endedApp()] }))).toBeNull();
	});

	it("dates the not-yet-published rung only while the first-publish list stands", () => {
		const broughtIn = view({ active: [adoptedApp()] });
		expect(
			readNotPublishedSince({ ...broughtIn, firstPublish: FIRST_PUBLISH }),
		).toBe("2026-09-10T09:30:00Z");
		/* A first publish ended the list. */
		expect(readNotPublishedSince(broughtIn)).toBeNull();
		/* A list of what the next publish changes is no first publish. */
		expect(
			readNotPublishedSince({
				...broughtIn,
				firstPublish: { ...FIRST_PUBLISH, of: "next-publish" },
			}),
		).toBeNull();
	});
});

describe("an ended deployment", () => {
	it("is ended while the ending stands, whatever the state moved to", () => {
		expect(cardKind(view({ superseded: [endedApp()], state: "ended" }))).toBe(
			"ended",
		);
		/* A publish after the ending passed preflight, then stopped before it
		 * made the new app: the state moved on and refused, the ending stands. */
		expect(
			cardKind(
				view({
					superseded: [endedApp()],
					state: "incomplete",
					resumePhase: "resources",
					phases: {
						preflight: { status: "succeeded", at: "2026-09-21T00:00:00Z" },
					},
				}),
			),
		).toBe("ended");
		expect(
			cardKind(view({ superseded: [endedApp()], state: "preflight" })),
		).toBe("ended");
	});

	it("is an ordinary record once a publish records a new app", () => {
		expect(
			cardKind(
				view({
					active: [{ ...appResource(), remoteId: "hq-app-2" }],
					superseded: [endedApp()],
				}),
			),
		).toBe("record");
		expect(cardKind(view({ active: [appResource()] }))).toBe("record");
	});

	it("reads in the dialog's row as publishing stopped, with the new app beside it as its line", () => {
		const [row] = compactTargetRows(
			[
				view({
					superseded: [endedApp()],
					state: "incomplete",
					resumePhase: "resources",
				}),
			],
			"production",
		);
		expect(row.statusLabel).toBe(PUBLISHING_STOPPED_ROW);
		expect(row.stopped).toBe(false);
		expect(row.nextPublish).toBe("creates-beside");
		expect(row.line).toBe(PUBLISH_PLAN_CREATES_BESIDE);
	});

	it("keeps each other row's line", () => {
		const rows = compactTargetRows(
			[
				view({ domain: "fresh" }),
				view({ domain: "updates", active: [appResource()] }),
				view({ domain: "far", server: "india" }),
			],
			"production",
		);
		expect(rows.map((row) => row.line)).toStrictEqual([
			"Publishing again creates a fresh app here",
			null,
			"On CommCare HQ's India server, which this connection doesn't reach",
		]);
	});
});

describe("what a card offers", () => {
	it("offers Check status for a live mapping checking can answer", () => {
		expect(checkStatusOffered(view({ active: [appResource()] }))).toBe(true);
		/* HQ reported it gone: its own undo is how it comes back. */
		expect(
			checkStatusOffered(
				view({
					state: "incomplete",
					resumePhase: "upload",
					active: [
						{ ...appResource(), remoteMissingAt: "2026-08-02T00:00:00Z" },
					],
				}),
			),
		).toBe(true);
	});

	it("withholds Check status from a mapping another Nova app took, from no mapping, and from a publish refused before its content arrived", () => {
		expect(
			checkStatusOffered(
				view({
					active: [{ ...appResource(), releasedAt: "2026-09-01T00:00:00Z" }],
				}),
			),
		).toBe(false);
		expect(checkStatusOffered(view({}))).toBe(false);
		expect(checkStatusOffered(view({ superseded: [endedApp()] }))).toBe(false);
		expect(
			checkStatusOffered(
				view({
					state: "incomplete",
					resumePhase: "upload",
					active: [appResource()],
				}),
			),
		).toBe(false);
	});

	it("offers Stop publishing here to a member who may delete, while a live app mapping stands", () => {
		const live = view({ active: [appResource()] });
		expect(stopPublishingOffered(live, true)).toBe(true);
		expect(stopPublishingOffered(live, false)).toBe(false);
		expect(
			stopPublishingOffered(view({ superseded: [endedApp()] }), true),
		).toBe(false);
		expect(stopPublishingOffered(view({}), true)).toBe(false);
	});
});

describe("a stop's answer", () => {
	it("shows a refusal's own sentence where it says who may or that there is nothing to stop, and Nova's own line otherwise", () => {
		expect(
			stopFailureSentence({
				code: "not_permitted",
				message: "An admin or owner can stop publishing here.",
			}),
		).toBe("An admin or owner can stop publishing here.");
		expect(
			stopFailureSentence({
				code: "invalid_input",
				message: "There is nothing to stop here.",
			}),
		).toBe("There is nothing to stop here.");
		for (const code of [
			"unauthenticated",
			"not_found",
			"unavailable",
		] as const) {
			expect(stopFailureSentence({ code, message: "internal" })).toBe(
				STOP_PUBLISHING_FAILED,
			);
		}
	});

	/* A request whose answer never came may follow a stop that landed, so it
	 * cannot say nothing changed. */
	it("says Nova is checking, not that nothing changed, where no answer arrived", () => {
		expect(stopFailureSentence(null)).toBe(STOP_PUBLISHING_UNANSWERED);
		expect(STOP_PUBLISHING_UNANSWERED).not.toContain("Nothing was changed");
	});
});

describe("endedCardOf", () => {
	it("is null for a card that is not ended", () => {
		expect(endedCardOf(view({ active: [appResource()] }))).toBeNull();
	});

	it("links to the HQ app the deployment stopped at", () => {
		expect(
			endedCardOf(view({ superseded: [endedApp()], state: "ended" })),
		).toMatchObject({
			ending: { reason: "stopped", heldByAnotherApp: false },
			linksToHqApp: true,
		});
	});

	/* A teammate brought the stopped HQ app in as another Nova app: the way to
	 * it is that app's now, so the ended card offers none. */
	it("offers no link where another Nova app publishes to that HQ app now", () => {
		for (const reason of ["stopped", "claimed-elsewhere"] as const) {
			expect(
				endedCardOf(
					view({
						superseded: [{ ...endedApp(reason), heldByAnotherApp: true }],
						state: "ended",
					}),
				),
			).toMatchObject({
				ending: { reason, heldByAnotherApp: true },
				linksToHqApp: false,
			});
		}
	});

	/* The app that took the HQ app in a restore has since stopped there or
	 * been deleted, so nobody holds it: the card links back to it again, and
	 * its line says what happened on that day and nothing of now, which would
	 * contradict the link beside it. */
	it("links back where the app that took it holds it no longer, and its line names no holder now", () => {
		const card = endedCardOf(
			view({ superseded: [endedApp("claimed-elsewhere")], state: "ended" }),
		);
		expect(card).toMatchObject({
			ending: { reason: "claimed-elsewhere", heldByAnotherApp: false },
			linksToHqApp: true,
		});
		if (card === null) throw new Error("Expected an ended card");
		const line = endedLine(card.ending, "20 September 2026");
		expect(line).toBe(
			"Nova stopped publishing here on 20 September 2026, because another Nova app had taken over that CommCare HQ app. Publishing here again makes a new app beside it.",
		);
		expect(line).not.toContain("now");
		expect(
			endedLine(
				{ ...card.ending, heldByAnotherApp: true },
				"20 September 2026",
			),
		).toContain("publishes to that CommCare HQ app now");
	});
});

describe("broughtInElsewhere", () => {
	it("answers true where another project space's live mapping was brought in", () => {
		const records = [
			view({ domain: "origin", active: [adoptedApp()] }),
			view({ domain: "second", active: [appResource()] }),
		];
		expect(
			broughtInElsewhere(records, { server: "production", domain: "second" }),
		).toBe(true);
		expect(
			broughtInElsewhere(records, { server: "production", domain: "third" }),
		).toBe(true);
	});

	it("answers false for the project space the app came from, for apps Nova made, and for a stopped bring-in", () => {
		expect(
			broughtInElsewhere([view({ domain: "origin", active: [adoptedApp()] })], {
				server: "production",
				domain: "origin",
			}),
		).toBe(false);
		expect(
			broughtInElsewhere(
				[view({ domain: "origin", active: [appResource()] })],
				{
					server: "production",
					domain: "second",
				},
			),
		).toBe(false);
		expect(
			broughtInElsewhere(
				[
					view({
						domain: "origin",
						superseded: [
							{
								...adoptedApp(),
								supersededAt: "2026-09-20T15:00:00Z",
								endedReason: "stopped",
								endedByName: "Grace Hopper",
							},
						],
					}),
				],
				{ server: "production", domain: "second" },
			),
		).toBe(false);
	});

	it("tells a same-named project space on another server apart from the target", () => {
		expect(
			broughtInElsewhere(
				[view({ server: "india", domain: "shared", active: [adoptedApp()] })],
				{ server: "production", domain: "shared" },
			),
		).toBe(true);
	});
});
