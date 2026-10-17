/** Pure: which steps the manual-import guide holds, and the header that carries them. */
import { describe, expect, it } from "vitest";
import {
	temporalSearchFixture,
	temporalSearchScenarios,
} from "@/lib/commcare/__tests__/compilerNavigationFixture";
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
import { PROJECT_SPACE_COMPATIBILITY_SUPPORT_EMAIL } from "../projectSpaceCompatibility";

const BARE: ManualImportGuideInput = {
	appFileName: "Tracker",
	lookupTags: [],
	hasMedia: false,
	versionFloor: "2.57",
	capabilities: [],
	planFeatures: [],
	logo: null,
	readsLocations: false,
	sendsToConnect: false,
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
