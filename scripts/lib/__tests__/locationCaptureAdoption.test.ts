import { expect, it } from "vitest";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import {
	convert,
	locationDecision,
} from "../../migrations/step7-location-capture.mjs";

it("adopts agreed location, distinguishes unknown targets from conflict, and keeps private genesis independent", () => {
	const doc = buildDoc({ modules: [] });
	const target = (domain: string, previous: boolean | null) => ({
		domain,
		server: "test",
		deploymentId: domain,
		remoteId: "app",
		digest: previous === null ? null : domain,
		previous,
	});
	const yes = target("north", true),
		no = target("south", false),
		unknown = target("west", null);
	const coordinates = { appId: doc.appId, projectId: "project" };
	const settings = (targets: readonly (typeof yes)[]) => ({
		locationCapture: {
			decisions: [{ ...coordinates, ...locationDecision(targets), targets }],
		},
	});
	expect(locationDecision([]).standing).toBe("no-target");
	expect(locationDecision([unknown]).standing).toBe("unobserved");
	expect(locationDecision([yes, no, unknown])).toEqual({
		standing: "disagreement",
		captureLocation: false,
	});
	expect(locationDecision([no, unknown]).standing).toBe("agreed-off");
	expect(
		convert(doc, settings([yes, unknown]), coordinates).appSettings
			.captureLocation,
	).toBe(true);
	expect(convert(doc, settings([yes, no, unknown]), coordinates)).toBe(doc);
	expect(
		convert(doc, settings([yes]), {
			...coordinates,
			purpose: "private-genesis",
		}),
	).toBe(doc);
	expect(() =>
		convert(doc, settings([]), { ...coordinates, projectId: "other" }),
	).toThrow("no unique standing");
});

it("converts an earlier baseline that omitted app settings", () => {
	const baseline = { appId: "app", connectType: null };
	const coordinate = { appId: baseline.appId, projectId: "project" };
	const settings = (previous: boolean | null) => {
		const targets = [{ previous }];
		return {
			locationCapture: {
				decisions: [{ ...coordinate, ...locationDecision(targets), targets }],
			},
		};
	};

	expect(convert(baseline, settings(null), coordinate)).toBe(baseline);
	expect(convert(baseline, settings(true), coordinate)).toEqual({
		...baseline,
		appSettings: { captureLocation: true },
	});
	expect(
		convert(baseline, {}, { ...coordinate, purpose: "private-genesis" }),
	).toBe(baseline);
});
