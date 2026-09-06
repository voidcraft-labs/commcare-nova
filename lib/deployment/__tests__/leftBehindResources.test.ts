/**
 * What an earlier publish left sitting on a project space.
 *
 * The rule is easy to get backwards, and both directions cost somebody
 * something. Report too little and an author never learns that a renamed
 * table is still there under its old name, which the deployment contract
 * exists to prevent. Report too much and they make a trip to CommCare HQ
 * to clean up a table that is not there.
 *
 * So the test is the NAME, not the supersession.
 */

import { describe, expect, it } from "vitest";
import { leftBehindResources } from "../resources";
import type { DeploymentResource, DeploymentWithResources } from "../types";
import { NO_DEPLOYMENT_PHASE_OUTCOMES } from "../types";

const TABLE = "018f0000-0000-7000-8000-000000000001";

function resource(over: Partial<DeploymentResource>): DeploymentResource {
	return {
		deploymentId: "dep-1",
		kind: "lookup-table",
		novaResourceId: TABLE,
		remoteId: "hq-districts",
		ownership: "nova-created",
		pushedIdentity: "districts",
		adoptedAt: null,
		adoptedBy: null,
		pushedRevision: null,
		pushedAt: null,
		remoteRevision: null,
		remoteObservedAt: null,
		supersededAt: "2026-08-18T00:00:00.000Z",
		...over,
	};
}

function view(
	superseded: readonly DeploymentResource[],
): DeploymentWithResources {
	return {
		deployment: {
			id: "dep-1",
			appId: "app-1",
			projectId: "proj-1",
			server: "production",
			domain: "acme",
			state: "uploaded",
			resumePhase: null,
			phases: NO_DEPLOYMENT_PHASE_OUTCOMES,
			createdBy: "u1",
			createdAt: "2026-08-18T00:00:00.000Z",
			updatedAt: "2026-08-18T00:00:00.000Z",
			lastObservedAt: null,
		},
		active: [],
		superseded,
	};
}

describe("leftBehindResources", () => {
	it.each([
		{
			label: "renamed table",
			resource: resource({}),
			identities: new Map([[TABLE, "areas"]]),
			report: true,
		},
		{
			label: "recreated table with unchanged name",
			resource: resource({}),
			identities: new Map([[TABLE, "districts"]]),
			report: false,
		},
		{
			label: "removed table",
			resource: resource({}),
			identities: new Map<string, string>(),
			report: true,
		},
		{
			label: "replaced app",
			resource: resource({
				kind: "app",
				novaResourceId: "app-1",
				remoteId: "old-app",
				pushedIdentity: null,
			}),
			identities: new Map<string, string>(),
			report: true,
		},
		{
			label: "archived place",
			resource: resource({ kind: "location", pushedIdentity: "colorado" }),
			identities: new Map<string, string>(),
			report: true,
		},
		{
			label: "place recreated under the same code",
			resource: resource({ kind: "location", pushedIdentity: "colorado" }),
			identities: new Map([[TABLE, "colorado"]]),
			report: false,
		},
		{
			label: "historical unnamed non-app resource",
			resource: resource({ pushedIdentity: null }),
			identities: new Map<string, string>(),
			report: false,
		},
	])(
		"reports $label only when the current identity establishes it is unused",
		({ resource: old, identities, report }) => {
			expect(leftBehindResources(view([old]), identities)).toEqual(
				report ? [old] : [],
			);
		},
	);

	it("excludes reused remote objects and reports each inactive object once using its latest mapping", () => {
		const live = resource({
			kind: "app",
			remoteId: "live-app",
			pushedIdentity: null,
			supersededAt: null,
		});
		const oldLive = { ...live, supersededAt: "2026-08-01T00:00:00.000Z" };
		const old = resource({
			remoteId: "unused-table",
			pushedIdentity: "old-tag",
		});
		const latest = {
			...old,
			pushedIdentity: "latest-tag",
			supersededAt: "2026-09-01T00:00:00.000Z",
		};
		const sameIdOtherKind = resource({
			remoteId: "live-app",
			pushedIdentity: "unrelated-table",
		});
		const deployment = {
			...view([oldLive, old, sameIdOtherKind, latest]),
			active: [live],
		};
		const before = structuredClone(deployment);
		expect(leftBehindResources(deployment, new Map())).toEqual([
			latest,
			sameIdOtherKind,
		]);
		expect(deployment).toEqual(before);
	});

	it("reports only unused apps when resource names could not be loaded", () => {
		const live = resource({
			kind: "app",
			remoteId: "live-app",
			supersededAt: null,
		});
		const unused = resource({
			kind: "app",
			remoteId: "unused-app",
			pushedIdentity: null,
		});
		const deployment = {
			...view([
				{ ...live, supersededAt: "2026-08-01T00:00:00.000Z" },
				unused,
				resource({}),
				unused,
			]),
			active: [live],
		};
		expect(leftBehindResources(deployment, null)).toEqual([unused]);
	});
});
