import { describe, expect, it } from "vitest";
import type {
	DeploymentPhaseOutcomes,
	DeploymentRecord,
	DeploymentResource,
	DeploymentState,
} from "@/lib/deployment";
import type { DeploymentView } from "@/lib/deployment/actions";
import { asUuid } from "@/lib/domain/uuid";
import type { AppDeploymentNoticeEntry } from "@/lib/notices/migrationNotice";
import {
	applyRecordUpsert,
	beginRecordsLoad,
	compactTargetRows,
	deploymentViewKey,
	INITIAL_PUBLISHING_RECORDS,
	mayBePublished,
	preseededDomainSelection,
	publishAgainDomain,
	publishedAnywhere,
	publishingCardNoticeEntries,
	resolveRecordsLoad,
	upsertDeploymentViews,
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
		targetWebAppsEnabled: null,
	};
	return {
		deployment: {
			deployment: record,
			active: overrides.active ?? [],
			superseded: [],
			confirmations: [],
		},
		artifact: {
			server: record.server,
			domain: record.domain,
			hqAppId: null,
			sections: [],
		},
		leftBehind: [],
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
