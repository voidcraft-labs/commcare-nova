/**
 * Which HQ app a deployment's record names, and what the next publish
 * does with it.
 *
 * A live `app` mapping no longer means "the app is there": a first publish
 * maps the empty shell it creates before it fills it, and a mapping HQ
 * reported gone stays live until the next publish supersedes it. Each
 * reader of the mapping takes one of these selectors, so every record
 * shape is held here against every selector.
 */

import { describe, expect, it } from "vitest";
import {
	nextPublishAction,
	plannedInPlaceUpdate,
	publishedRemoteApp,
	remoteAppHoldsContent,
	remoteAppReportedGone,
} from "../resources";
import type {
	DeploymentPhaseOutcomes,
	DeploymentResource,
	DeploymentWithResources,
} from "../types";
import { NO_DEPLOYMENT_PHASE_OUTCOMES } from "../types";

const APP = "app-1";
const AT = "2026-10-01T00:00:00.000Z";

function appMapping(over: Partial<DeploymentResource>): DeploymentResource {
	return {
		deploymentId: "dep-1",
		kind: "app",
		novaResourceId: APP,
		remoteId: "hq-app",
		ownership: "nova-created",
		pushedIdentity: null,
		adoptedAt: null,
		adoptedBy: null,
		pushedRevision: 4,
		pushedAt: AT,
		pushToken: "01992000-0000-7000-8000-000000000001",
		remoteRevision: 2,
		remoteObservedAt: AT,
		supersededAt: null,
		remoteMissingAt: null,
		...over,
	};
}

function record(
	active: readonly DeploymentResource[],
	superseded: readonly DeploymentResource[] = [],
	phases: DeploymentPhaseOutcomes = NO_DEPLOYMENT_PHASE_OUTCOMES,
): DeploymentWithResources {
	return {
		deployment: {
			id: "dep-1",
			appId: APP,
			projectId: "proj-1",
			server: "production",
			domain: "acme",
			state: "uploaded",
			resumePhase: null,
			phases,
			createdBy: "u1",
			createdAt: AT,
			updatedAt: AT,
			lastObservedAt: null,
			offeredLogoContentHash: null,
			targetEmptyCaseListText: null,
		},
		active,
		superseded,
		confirmations: [],
	};
}

const withContent = appMapping({});
const shell = appMapping({
	pushedRevision: null,
	pushedAt: null,
	remoteRevision: null,
	remoteObservedAt: null,
});
const goneWithContent = appMapping({ remoteMissingAt: AT });
const goneShell = appMapping({ ...shell, remoteMissingAt: AT });

const SHAPES = [
	{
		shape: "no mapping",
		view: record([]),
		planned: null,
		published: null,
		next: "creates",
		gone: false,
	},
	{
		shape: "live with content",
		view: record([withContent]),
		planned: withContent,
		published: withContent,
		next: "updates",
		gone: false,
	},
	{
		shape: "live shell",
		view: record([shell]),
		planned: shell,
		published: null,
		next: "fills-shell",
		gone: false,
	},
	{
		shape: "gone with content",
		view: record([goneWithContent]),
		planned: null,
		published: null,
		next: "creates",
		gone: true,
	},
	{
		shape: "gone shell",
		view: record([goneShell]),
		planned: null,
		published: null,
		next: "creates",
		gone: true,
	},
	{
		shape: "superseded only",
		view: record([], [appMapping({ supersededAt: AT })]),
		planned: null,
		published: null,
		next: "creates",
		gone: false,
	},
] as const;

describe("the app mapping's selectors", () => {
	it.each(SHAPES)(
		"read a record with $shape",
		({ view, planned, published, next, gone }) => {
			expect(plannedInPlaceUpdate(view)).toEqual(planned);
			expect(publishedRemoteApp(view)).toEqual(published);
			expect(nextPublishAction(view)).toBe(next);
			expect(remoteAppReportedGone(view)).toBe(gone);
		},
	);

	it("hold content only once a publish filled the app", () => {
		expect(remoteAppHoldsContent(withContent)).toBe(true);
		expect(remoteAppHoldsContent(shell)).toBe(false);
	});

	it("creates on a target with no deployment", () => {
		expect(nextPublishAction(null)).toBe("creates");
	});

	it("reads gone from the mapping, after a later failed create overwrote the code", () => {
		const view = record([goneWithContent], [], {
			...NO_DEPLOYMENT_PHASE_OUTCOMES,
			upload: {
				status: "failed",
				at: AT,
				failure: {
					code: "hq_rejected_upload",
					message: "CommCare HQ refused the app (HTTP 400).",
					details: [],
				},
			},
		});
		expect(remoteAppReportedGone(view)).toBe(true);
		expect(nextPublishAction(view)).toBe("creates");
	});

	it("reads a live mapping beside an upload failure as there, since only the mapping says gone", () => {
		const view = record([withContent], [], {
			...NO_DEPLOYMENT_PHASE_OUTCOMES,
			upload: {
				status: "failed",
				at: AT,
				failure: {
					code: "hq_rejected_upload",
					message: "CommCare HQ refused the app (HTTP 400).",
					details: [],
				},
			},
		});
		expect(plannedInPlaceUpdate(view)).toEqual(withContent);
	});
});
