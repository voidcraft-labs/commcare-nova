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
	it("reports a table still wearing the name a rename moved away from", () => {
		const left = leftBehindResources(
			view([resource({})]),
			new Map([[TABLE, "areas"]]),
		);
		expect(left.map((entry) => entry.pushedIdentity)).toEqual(["districts"]);
	});

	it("reports nothing when the table was recreated under the same name", () => {
		/* Deleted on CommCare HQ, re-pushed: the mapping is superseded
		 * because the remote id changed, but the old table is gone and the
		 * new one carries the same name. Nothing is sitting there. */
		const left = leftBehindResources(
			view([resource({})]),
			new Map([[TABLE, "districts"]]),
		);
		expect(left).toEqual([]);
	});

	it("reports a table whose Nova side is gone entirely", () => {
		/* Deleted in Project data, or simply no longer referenced by this
		 * app. Whatever was pushed under that name is certainly still there,
		 * and nothing in Nova names it any more. */
		const left = leftBehindResources(view([resource({})]), new Map());
		expect(left).toHaveLength(1);
	});

	it("always reports a superseded app, which has no name to compare", () => {
		/* An app's remote id IS how CommCare HQ names it, so a superseded app
		 * mapping is unambiguously an app sitting there. */
		const left = leftBehindResources(
			view([
				resource({
					kind: "app",
					novaResourceId: "app-1",
					remoteId: "hq-old-app",
					pushedIdentity: null,
				}),
			]),
			new Map(),
		);
		expect(left.map((entry) => entry.remoteId)).toEqual(["hq-old-app"]);
	});

	it("says nothing about a non-app mapping that never recorded a name", () => {
		/* A row from before pushed identities existed. Nova cannot say what
		 * it is called over there, and guessing would send somebody looking
		 * for a table by a name that may not be its name. */
		const left = leftBehindResources(
			view([resource({ pushedIdentity: null })]),
			new Map(),
		);
		expect(left).toEqual([]);
	});
});
