/**
 * Step 4, `deployment-lines` (part 09 §5): which lines each live deployment
 * of an app gets, pure, over app baselines gzipped by the test.
 *
 * Contract: the Web Apps question is named only where a baseline Nova can
 * read and verify (origin `push` or `cutover`) holds a Web App setting other
 * than the target declares; a `create`, `unread`, absent or unverifiable
 * baseline says nothing about what HQ holds. Every deployment of an app that
 * declares Web Apps or holds a form the sync setting stops on Android is told
 * its next publish asks more, and only a changed app with entry points is
 * told its new links wait for a publish.
 */

import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { formEntrySyncReasons } from "@/lib/commcare/planPrivileges";
import { type BlueprintDoc, proseText } from "@/lib/domain";
import { PLATFORM_FEATURE_FIXTURES } from "@/lib/domain/__tests__/platformFeatureFixtures";
import {
	deploymentLines,
	heldWebApps,
	type SourceBaseline,
	type SourceDeployment,
} from "../notice";

const DEPLOYMENT_ID = "01992000-0000-7000-8000-000000000011";

function baseline(
	origin: string,
	source: unknown,
	options: { readonly digest?: string } = {},
): SourceBaseline {
	const text = Buffer.from(JSON.stringify(source), "utf8");
	return {
		origin,
		sourceGzip: gzipSync(text),
		sourceDigest:
			options.digest ?? createHash("sha256").update(text).digest("hex"),
	};
}

function deployment(baselineRow: SourceBaseline | null): SourceDeployment {
	return {
		deploymentId: DEPLOYMENT_ID,
		server: "production",
		domain: "field-ops",
		baseline: baselineRow,
	};
}

const REF = {
	deploymentId: DEPLOYMENT_ID,
	server: "production",
	domain: "field-ops",
} as const;

function survey(): BlueprintDoc {
	return buildDoc({
		appName: "Survey",
		modules: [
			{
				name: "Survey",
				forms: [
					{
						name: "Intake",
						type: "survey",
						fields: [f({ kind: "text", id: "note", label: proseText("Note") })],
					},
				],
			},
		],
	});
}

function androidOnly(doc: BlueprintDoc): BlueprintDoc {
	return produce(doc, (draft) => {
		draft.appSettings.runsOnlyOn = "android";
	});
}

const reasons = (lines: readonly { reason: string }[]) =>
	lines.map((line) => line.reason);

describe("the Web Apps question", () => {
	it.each(["push", "cutover"])(
		"is named where a %s baseline's Web App setting differs, in both directions",
		(origin) => {
			expect(
				deploymentLines(
					androidOnly(survey()),
					[deployment(baseline(origin, { cloudcare_enabled: true }))],
					true,
				).find((line) => line.reason === "next-publish-asks-web-apps"),
			).toEqual({
				kind: "deployment",
				reason: "next-publish-asks-web-apps",
				deployment: REF,
				detail: { to: "off" },
			});
			expect(
				deploymentLines(
					survey(),
					[deployment(baseline(origin, { cloudcare_enabled: false }))],
					false,
				).find((line) => line.reason === "next-publish-asks-web-apps"),
			).toEqual({
				kind: "deployment",
				reason: "next-publish-asks-web-apps",
				deployment: REF,
				detail: { to: "on" },
			});
		},
	);

	it("reads an absent setting as off, as HQ does", () => {
		expect(heldWebApps(baseline("push", {}))).toBe(false);
		expect(
			reasons(
				deploymentLines(survey(), [deployment(baseline("push", {}))], false),
			),
		).toContain("next-publish-asks-web-apps");
	});

	it("is not named where the setting is the declaration's, or where the baseline says nothing", () => {
		const unverified = baseline(
			"push",
			{ cloudcare_enabled: false },
			{ digest: "0".repeat(64) },
		);
		for (const row of [
			baseline("push", { cloudcare_enabled: true }),
			baseline("create", { cloudcare_enabled: false }),
			{ origin: "unread", sourceGzip: null, sourceDigest: null },
			null,
			unverified,
			{
				origin: "push",
				sourceGzip: Buffer.from("not gzip"),
				sourceDigest: "0".repeat(64),
			},
		]) {
			expect(
				reasons(deploymentLines(survey(), [deployment(row)], false)),
			).not.toContain("next-publish-asks-web-apps");
		}
		expect(heldWebApps(unverified)).toBeUndefined();
	});
});

describe("the confirmations the next publish asks", () => {
	it("names the Web Apps plan feature for an app that declares Web Apps", () => {
		expect(deploymentLines(survey(), [deployment(null)], false)).toEqual([
			{
				kind: "deployment",
				reason: "next-publish-asks-more",
				deployment: REF,
				detail: { planFeatures: "web-apps" },
			},
		]);
		expect(
			deploymentLines(androidOnly(survey()), [deployment(null)], false),
		).toEqual([]);
	});

	it("names Sync Cases On Form Entry for an app that runs on Android and holds a form the setting stops", () => {
		const doc = androidOnly(PLATFORM_FEATURE_FIXTURES.search.with());
		expect(formEntrySyncReasons(doc).length).toBeGreaterThan(0);
		expect(deploymentLines(doc, [deployment(null)], false)).toEqual([
			{
				kind: "deployment",
				reason: "next-publish-asks-more",
				deployment: REF,
				detail: { settings: "form-entry-sync-off" },
			},
		]);
	});
});

describe("the links line", () => {
	const withEntryPoint = () =>
		produce(survey(), (draft) => {
			const form = Object.values(draft.forms)[0];
			if (form === undefined) throw new Error("No form.");
			form.entryPoint = {
				uuid: "01992000-0000-7000-8000-0000000000f1",
				id: "intake",
			} as typeof form.entryPoint;
		});

	it("is given to a changed app with entry points, first, and to no unchanged one", () => {
		expect(
			reasons(deploymentLines(withEntryPoint(), [deployment(null)], true)),
		).toEqual(["deep-links-need-republish", "next-publish-asks-more"]);
		expect(
			reasons(deploymentLines(withEntryPoint(), [deployment(null)], false)),
		).toEqual(["next-publish-asks-more"]);
		expect(
			reasons(deploymentLines(survey(), [deployment(null)], true)),
		).toEqual(["next-publish-asks-more"]);
	});
});
