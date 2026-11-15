/**
 * What an earlier publish left sitting on a project space.
 *
 * The rule is easy to get backwards, and both directions cost somebody
 * something. Report too little and an author never learns that a renamed
 * table is still there under its old name, which the deployment contract
 * exists to prevent. Report too much and they make a trip to CommCare HQ
 * to clean up a table that is not there.
 *
 * So the test is the NAME, not the supersession. An app a deployment still
 * stands ended at is not left behind either, while the card's ended line
 * names it; once a later publish records a new app, nothing else does. An
 * app another Nova app publishes to now is never reported: it is that
 * app's live HQ app, not something left behind here.
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
		pushToken: "01992000-0000-7000-8000-000000000001",
		pushedAt: null,
		remoteRevision: null,
		remoteObservedAt: null,
		supersededAt: "2026-08-18T00:00:00.000Z",
		remoteMissingAt: null,
		adoptedByName: null,
		releasedAt: null,
		endedReason: null,
		endedByName: null,
		heldByAnotherApp: false,
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
			offeredLogoContentHash: null,
			targetEmptyCaseListText: null,
			endings: 0,
		},
		active: [],
		superseded,
		confirmations: [],
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
			label: "app a deployment ended at",
			resource: resource({
				kind: "app",
				novaResourceId: "app-1",
				remoteId: "ended-app",
				pushedIdentity: null,
				endedReason: "stopped",
				endedByName: "Ada",
			}),
			identities: new Map<string, string>(),
			report: false,
		},
		{
			label: "app another Nova app now publishes to",
			resource: resource({
				kind: "app",
				novaResourceId: "app-1",
				remoteId: "claimed-app",
				pushedIdentity: null,
				endedReason: "claimed-elsewhere",
				endedByName: "Grace",
			}),
			identities: null,
			report: false,
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

	describe("an app a deployment was ended at", () => {
		const stopped = (remoteId: string, supersededAt: string) =>
			resource({
				kind: "app",
				novaResourceId: "app-1",
				remoteId,
				pushedIdentity: null,
				supersededAt,
				endedReason: "stopped",
				endedByName: "Ada",
			});
		const liveApp = (pushedRevision: number | null) =>
			resource({
				kind: "app",
				novaResourceId: "app-1",
				remoteId: "new-app",
				pushedIdentity: null,
				supersededAt: null,
				pushedRevision,
			});

		/* The ended card names the app only while the ending stands. A
		 * publish that records a new app ends that, whether or not it then
		 * filled the new app, and the stopped app is still in CommCare HQ
		 * beside it. */
		it.each([
			{ label: "a filled new app", pushedRevision: 7 },
			{ label: "an empty new app", pushedRevision: null },
		])(
			"reports it once a later publish records $label",
			({ pushedRevision }) => {
				const old = stopped("stopped-app", "2026-08-18T00:00:00.000Z");
				const deployment = {
					...view([old]),
					active: [liveApp(pushedRevision)],
				};
				expect(leftBehindResources(deployment, new Map())).toEqual([old]);
				expect(leftBehindResources(deployment, null)).toEqual([old]);
			},
		);

		it("reports an earlier ending's app while a later ending stands", () => {
			const first = stopped("first-app", "2026-08-18T00:00:00.000Z");
			const second = stopped("second-app", "2026-09-18T00:00:00.000Z");
			expect(leftBehindResources(view([first, second]), new Map())).toEqual([
				first,
			]);
		});

		/* Stop publishing frees the HQ app at once, and a teammate may bring it
		 * in as a new Nova app; a later publish here then records a new app.
		 * The stopped app is that other app's live HQ app, so naming it for
		 * removal would take it down. */
		it("never reports a stopped app another Nova app now publishes to, beside a new app", () => {
			const held = {
				...stopped("stopped-app", "2026-08-18T00:00:00.000Z"),
				heldByAnotherApp: true,
			};
			const deployment = { ...view([held]), active: [liveApp(7)] };
			expect(leftBehindResources(deployment, new Map())).toEqual([]);
			expect(leftBehindResources(deployment, null)).toEqual([]);
		});

		it("never reports a replaced app another Nova app now publishes to", () => {
			const replaced = resource({
				kind: "app",
				novaResourceId: "app-1",
				remoteId: "restored-app",
				pushedIdentity: null,
				heldByAnotherApp: true,
			});
			expect(
				leftBehindResources(
					{ ...view([replaced]), active: [liveApp(7)] },
					new Map(),
				),
			).toEqual([]);
		});

		it("never reports an app another Nova app took, even after a new app is recorded", () => {
			const claimed = resource({
				kind: "app",
				novaResourceId: "app-1",
				remoteId: "claimed-app",
				pushedIdentity: null,
				endedReason: "claimed-elsewhere",
				endedByName: "Grace",
			});
			expect(
				leftBehindResources(
					{ ...view([claimed]), active: [liveApp(7)] },
					new Map(),
				),
			).toEqual([]);
		});
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
