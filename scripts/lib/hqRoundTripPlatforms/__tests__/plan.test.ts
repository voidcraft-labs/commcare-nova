/**
 * The plan and its digest (part 09 §6), pure, over a fleet source the test
 * builds.
 *
 * Contract: the digest covers everything the writer would write, so it is
 * the same over the same fleet and moves with any base sequence, source,
 * target, change, blocker, media format or baseline's held setting; the scan,
 * which classifies no media, plans no media and no removal.
 */

import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { planFleet } from "../plan";
import type { MediaPlan } from "../types";
import {
	classification,
	type FleetApp,
	featureDoc,
	fleetOf,
	mediaApp,
	splitApp,
	withSearchFirst,
} from "./fixtures";

function baselineRow(webApps: boolean) {
	const text = Buffer.from(JSON.stringify({ cloudcare_enabled: webApps }));
	return {
		origin: "push",
		sourceGzip: gzipSync(text),
		sourceDigest: createHash("sha256").update(text).digest("hex"),
	};
}

/* Built once: a fixture mints the identities it leaves out from a counter,
 * so two builds are two different documents. */
const DOCS = {
	media: mediaApp(),
	split: splitApp(),
	android: featureDoc("datetime-question"),
	neither: withSearchFirst(featureDoc("case-list-here")),
};

function apps(options: { webApps?: boolean } = {}): FleetApp[] {
	return [
		{ appId: "app-a-media", doc: DOCS.media },
		{ appId: "app-b-split", doc: DOCS.split },
		{
			appId: "app-c-android",
			doc: DOCS.android,
			deployments: [
				{
					deploymentId: "01992000-0000-7000-8000-000000000011",
					server: "production",
					domain: "field-ops",
					baseline: baselineRow(options.webApps ?? true),
				},
			],
		},
		{ appId: "app-d-neither", doc: DOCS.neither },
	];
}

const digestOf = (fleet: FleetApp[], media = classification()) =>
	planFleet(fleetOf(fleet), media).plan.digest;

describe("the plan's digest", () => {
	it("is the same over the same fleet", () => {
		expect(digestOf(apps())).toBe(digestOf(apps()));
		expect(digestOf(apps())).toMatch(/^[0-9a-f]{64}$/);
	});

	it("moves with a base sequence, a source, a target and a change", () => {
		const base = digestOf(apps());
		const moved = (edit: (fleet: FleetApp[]) => FleetApp[]) =>
			digestOf(edit(apps()));
		expect(
			moved((fleet) =>
				fleet.map((app) =>
					app.appId === "app-c-android" ? { ...app, baseSeq: 5 } : app,
				),
			),
		).not.toBe(base);
		/* A renamed app: its base digest, its target and its notice all move. */
		expect(
			moved((fleet) =>
				fleet.map((app) =>
					app.appId === "app-b-split"
						? {
								...app,
								doc: produce(app.doc, (draft) => {
									draft.appName = "Visit times, renamed";
								}),
							}
						: app,
				),
			),
		).not.toBe(base);
		/* An app that no longer needs a change: its target and changes move. */
		expect(
			moved((fleet) =>
				fleet.map((app) =>
					app.appId === "app-c-android"
						? {
								...app,
								doc: produce(app.doc, (draft) => {
									draft.appSettings.runsOnlyOn = "android";
								}),
							}
						: app,
				),
			),
		).not.toBe(base);
	});

	it("moves with a blocker, a media format and a baseline's held setting", () => {
		const base = digestOf(apps());
		expect(
			digestOf(apps().filter((app) => app.appId !== "app-d-neither")),
		).not.toBe(base);
		const media = classification();
		const reformatted = {
			...media,
			plans: media.plans.map(
				(plan): MediaPlan =>
					plan.format === "mp4-h264-high"
						? { ...plan, format: "mp4-h264-main" }
						: plan,
			),
		};
		expect(digestOf(apps(), reformatted)).not.toBe(base);
		expect(digestOf(apps({ webApps: false }))).not.toBe(base);
	});

	it("lists every app in code-point order with its declaration, target and blockers", () => {
		const { plan, targets } = planFleet(fleetOf(apps()), classification());
		expect(
			plan.apps.map((app) => [
				app.appId,
				app.declaration,
				app.targetDigest !== null,
				app.blockers.map((blocker) => blocker.code),
			]),
		).toEqual([
			["app-a-media", "both", true, []],
			["app-b-split", "web-apps", true, []],
			["app-c-android", "android", true, []],
			["app-d-neither", null, false, ["runs-on-neither"]],
		]);
		expect([...targets.keys()].sort()).toEqual([
			"app-a-media",
			"app-b-split",
			"app-c-android",
		]);
		expect(plan.media.map((media) => media.assetId)).toEqual(
			[...plan.media.map((media) => media.assetId)].sort(),
		);
	});

	it("plans no media and removes nothing in the scan", () => {
		const fleet = planFleet(fleetOf(apps()), null);
		expect(fleet.classified).toBe(false);
		expect(fleet.plan.media).toEqual([]);
		expect(
			fleet.plan.apps.flatMap((app) =>
				app.changes.filter((change) => change.step === "remove-unplayed-media"),
			),
		).toEqual([]);
		expect(
			fleet.plan.apps.find((app) => app.appId === "app-a-media")?.targetDigest,
		).toBeNull();
	});
});
