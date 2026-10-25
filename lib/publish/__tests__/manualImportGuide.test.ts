/** Pure: which steps the manual-import guide holds, and the header that carries them. */
import { describe, expect, it } from "vitest";
import {
	temporalSearchFixture,
	temporalSearchScenarios,
} from "@/lib/commcare/__tests__/compilerNavigationFixture";
import { searchPromptFixture } from "@/lib/commcare/__tests__/searchPromptFixture";
import { hqImportFileGuide } from "@/lib/commcare/multimedia/hqJsonExportArchive";
import {
	HQ_PRIVATE_FEATURE_FLAG_SYMBOLS,
	requiredProjectSpaceCapabilities,
} from "@/lib/commcare/projectSpaceCompatibility";
import { domainFeatureFlag } from "@/lib/commcare/surface/gates";
import {
	decodeManualImportGuide,
	encodeManualImportGuide,
	MANUAL_IMPORT_GUIDE_HEADER_LIMIT,
	MANUAL_IMPORT_STEP_IN_README,
	type ManualImportGuideInput,
	manualImportGuide,
	renderManualImportGuide,
} from "../manualImportGuide";
import { PLAN_FEATURES } from "../planFeatures";
import { PROJECT_SPACE_COMPATIBILITY_SUPPORT_EMAIL } from "../projectSpaceCompatibility";

const BARE: ManualImportGuideInput = {
	appFileName: "Tracker",
	lookupTags: [],
	hasMedia: false,
	versionFloor: "2.57",
	capabilities: [],
	planFeatures: [],
	logo: null,
	runsInWebApps: true,
	readsLocations: false,
	sendsToConnect: false,
	formEntrySync: false,
	distanceSearches: [],
};

const kinds = (input: ManualImportGuideInput) =>
	manualImportGuide(input).map((step) => step.kind);

describe("manualImportGuide", () => {
	it("holds the import and the CommCare version for an app with no companions", () => {
		expect(kinds(BARE)).toEqual(["import-app", "commcare-version"]);
	});

	it("adds each other step exactly when its input does, in the order a person takes them", () => {
		expect(kinds({ ...BARE, lookupTags: ["clinics"] })).toEqual([
			"lookup-tables",
			"import-app",
			"commcare-version",
		]);
		expect(kinds({ ...BARE, hasMedia: true })).toEqual([
			"import-app",
			"commcare-version",
			"media",
		]);
		expect(
			kinds({
				...BARE,
				lookupTags: ["clinics"],
				hasMedia: true,
				capabilities: [{ label: "Case search", reasons: ["It searches."] }],
			}),
		).toEqual([
			"lookup-tables",
			"import-app",
			"commcare-version",
			"media",
			"capabilities",
		]);
	});

	it("names the floor it was given and the file it imports", () => {
		const [importApp, version] = manualImportGuide({
			...BARE,
			versionFloor: "2.61",
		});
		expect(importApp.lines).toContain(
			'On the next screen, upload "Tracker.json", name the app, and import.',
		);
		expect(version).toEqual({
			kind: "commcare-version",
			title: "Check the app's CommCare version",
			lines: [
				"This app needs CommCare 2.61 or later.",
				"",
				"In CommCare HQ, the app's settings show its CommCare version. If the",
				"version there is lower, you can raise it to 2.61 or later and",
				"save.",
				"",
				"After that, phones on an older CommCare can no longer install or update",
				"the app.",
			],
		});
	});

	it("lists one line per capability and the support address, and no HQ flag", () => {
		const doc = temporalSearchFixture(temporalSearchScenarios[0]);
		const capabilities = requiredProjectSpaceCapabilities(doc);
		expect(capabilities.length).toBeGreaterThan(0);
		const steps = hqImportFileGuide({
			appName: "Tracker",
			doc,
			assets: new Map(),
			lookupWorkbook: undefined,
			attachmentTarget: null,
		});
		const step = steps.find((s) => s.kind === "capabilities");
		if (!step) throw new Error("The guide left out the capabilities step");
		expect(step.lines.filter((line) => line.startsWith("  - "))).toEqual(
			capabilities.map(
				(capability) =>
					`  - ${capability.label}: ${capability.reasons.join(" ")}`,
			),
		);
		expect(step.lines.join("\n")).toContain(
			PROJECT_SPACE_COMPATIBILITY_SUPPORT_EMAIL,
		);
		const text = renderManualImportGuide(steps);
		for (const symbol of Object.values(HQ_PRIVATE_FEATURE_FLAG_SYMBOLS)) {
			expect(text).not.toContain(symbol);
			expect(text).not.toContain(domainFeatureFlag(symbol).slug);
		}
	});

	it("holds the plan features, the logo, the location list, Connect forwarding and sync on form entry exactly when their inputs do, last", () => {
		const all: ManualImportGuideInput = {
			...BARE,
			capabilities: [{ label: "Case search", reasons: ["It searches."] }],
			planFeatures: [
				{
					label: PLAN_FEATURES["lookup-tables"].label,
					plans: PLAN_FEATURES["lookup-tables"].plans,
					consequence: PLAN_FEATURES["lookup-tables"].consequence,
				},
			],
			logo: { fileName: "logo.png" },
			readsLocations: true,
			sendsToConnect: true,
			formEntrySync: true,
		};
		expect(kinds(all)).toEqual([
			"import-app",
			"commcare-version",
			"capabilities",
			"plan-features",
			"logo",
			"flat-location-fixture",
			"connect-forwarding",
			"form-entry-sync-off",
		]);
		for (const [key, kind] of [
			["planFeatures", "plan-features"],
			["logo", "logo"],
			["readsLocations", "flat-location-fixture"],
			["sendsToConnect", "connect-forwarding"],
			["formEntrySync", "form-entry-sync-off"],
		] as const) {
			const without = { ...all, [key]: BARE[key] };
			expect(kinds(without)).not.toContain(kind);
		}
		const steps = manualImportGuide(all);
		const step = (kind: string) => steps.find((item) => item.kind === kind);
		expect(step("plan-features")).toEqual({
			kind: "plan-features",
			title: "Check the project space's plan",
			lines: [
				"This app uses features that come with some CommCare HQ plans and not others:",
				"",
				`  - Lookup Tables: Standard, Pro, Advanced and Enterprise. ${PLAN_FEATURES["lookup-tables"].consequence}`,
				"",
				"It helps to check that the project space's plan includes each one, on its Current Subscription page in CommCare HQ.",
			],
		});
		expect(step("logo")?.title).toBe("Your app's logo");
		expect(step("logo")?.lines[0]).toBe(
			'The ZIP holds your logo as "logo.png"; it isn\'t part of the app file.',
		);
		expect(step("flat-location-fixture")).toEqual({
			kind: "flat-location-fixture",
			title: "The location list",
			lines: [
				"This app reads the places in your organization, on phones and in Web Apps, and its forms that do can't work without them.",
				"It helps to check that the project space still sends its location list to workers. It does unless someone turned that off on its Location Fixture page. Phones and Web Apps both follow that setting.",
			],
		});
		expect(step("connect-forwarding")).toEqual({
			kind: "connect-forwarding",
			title: "Check that the app's forms reach CommCare Connect",
			lines: [
				"This app's forms reach CommCare Connect only through CommCare HQ's data forwarding.",
				"It helps to check that the project space's plan includes Data Forwarding and that it has a forwarder set up as Forward Form Metadata to Commcare Connect.",
			],
		});
		expect(step("form-entry-sync-off")).toEqual({
			kind: "form-entry-sync-off",
			title: "Sync Cases On Form Entry",
			lines: [
				"This app's forms that work on a case chosen in a menu with Search open on Android phones only while the project space has Sync Cases On Form Entry turned off.",
				"It helps to check that it's off on the project space's Case Search page in CommCare HQ. It's off unless someone turned it on.",
			],
		});
	});

	it("tells a person to turn Web Apps off for an Android-only app, after the logo, and says nothing of it for an app that runs in Web Apps", () => {
		const android: ManualImportGuideInput = {
			...BARE,
			logo: { fileName: "logo.png" },
			runsInWebApps: false,
			readsLocations: true,
		};
		expect(kinds(android)).toEqual([
			"import-app",
			"commcare-version",
			"logo",
			"web-apps",
			"flat-location-fixture",
		]);
		expect(
			manualImportGuide(android).find((step) => step.kind === "web-apps"),
		).toEqual({
			kind: "web-apps",
			title: "Web Apps",
			lines: [
				"This app runs on Android only.",
				"CommCare HQ turns Web Apps on for an imported app wherever the project space's plan includes it. It helps to open the imported app's settings in CommCare HQ and turn “Web App” off, so workers don't meet it in Web Apps.",
			],
		});
		expect(kinds({ ...android, runsInWebApps: true })).not.toContain(
			"web-apps",
		);
	});

	it("closes with the Data Dictionary step for each property a search measures distance on", () => {
		const doc = searchPromptFixture("prompt-dataflow");
		const steps = hqImportFileGuide({
			appName: "Tracker",
			doc,
			assets: new Map(),
			lookupWorkbook: undefined,
			attachmentTarget: null,
		});
		expect(steps.at(-1)?.kind).toBe("distance-search");
		const step = steps.at(-1);
		const menu = doc.modules[doc.moduleOrder[0]]?.name;
		expect(step?.title).toBe("Finding cases by distance");
		expect(step?.lines.filter((line) => line.startsWith("  - "))).toEqual([
			`  - In the “patient” case type, set the data type of “home_location” to GPS. The search in “${menu}” measures distance on it.`,
			`  - In the “patient” case type, set the data type of “work_location” to GPS. The search in “${menu}” measures distance on it.`,
		]);
		expect(step?.lines).toContain(
			"  https://www.commcarehq.org/a/<your-project>/data_dictionary/",
		);
		expect(step?.lines[0]).toContain("in your project space");
		expect(
			kinds({
				...BARE,
				sendsToConnect: true,
				formEntrySync: true,
				distanceSearches: [
					{ caseType: "patient", property: "home", moduleNames: ["Find"] },
				],
			}).slice(-3),
		).toEqual(["connect-forwarding", "form-entry-sync-off", "distance-search"]);
		expect(
			hqImportFileGuide({
				appName: "Tracker",
				doc: searchPromptFixture("prompt-guards"),
				assets: new Map(),
				lookupWorkbook: undefined,
				attachmentTarget: null,
			}).map((item) => item.kind),
		).not.toContain("distance-search");
	});

	it("renders every step, numbered, as the README holds it", () => {
		const steps = manualImportGuide({ ...BARE, hasMedia: true });
		const text = renderManualImportGuide(steps);
		expect(text).toContain("=== 1. Import the app ===");
		expect(text).toContain("=== 2. Check the app's CommCare version ===");
		expect(text).toContain("=== 3. Import the media ===");
		for (const step of steps)
			for (const line of step.lines) expect(text).toContain(line);
	});
});

describe("the guide's header", () => {
	it("gives the steps back, a non-Latin lookup tag included", () => {
		const steps = manualImportGuide({
			...BARE,
			lookupTags: ["诊所", "clinics"],
			hasMedia: true,
		});
		expect(decodeManualImportGuide(encodeManualImportGuide(steps))).toEqual(
			steps,
		);
	});

	it("stays within its limit for a guide that runs long, keeping every title and pointing to the README for the longest text", () => {
		const steps = manualImportGuide({
			...BARE,
			lookupTags: Array.from({ length: 400 }, (_, i) => `诊所_${i}`),
			hasMedia: true,
		});
		const encoded = encodeManualImportGuide(steps);
		expect(encoded.length).toBeLessThanOrEqual(
			MANUAL_IMPORT_GUIDE_HEADER_LIMIT,
		);
		const carried = decodeManualImportGuide(encoded);
		expect(carried.map((step) => step.title)).toEqual(
			steps.map((step) => step.title),
		);
		expect(carried.map((step) => step.lines)).toEqual(
			steps.map((step) =>
				step.kind === "lookup-tables"
					? [MANUAL_IMPORT_STEP_IN_README]
					: step.lines,
			),
		);
	});

	it("reads a missing, truncated or foreign header as no steps", () => {
		const encoded = encodeManualImportGuide(manualImportGuide(BARE));
		expect(decodeManualImportGuide(null)).toEqual([]);
		expect(decodeManualImportGuide("")).toEqual([]);
		expect(
			decodeManualImportGuide(encoded.slice(0, encoded.length / 2)),
		).toEqual([]);
		expect(
			decodeManualImportGuide(
				encodeURIComponent(
					JSON.stringify([{ kind: "other", title: "x", lines: [] }]),
				),
			),
		).toEqual([]);
		expect(
			decodeManualImportGuide(
				encodeURIComponent(JSON.stringify({ steps: [] })),
			),
		).toEqual([]);
	});
});
