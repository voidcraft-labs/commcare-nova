/**
 * `buildHqJsonExportArchive`: which members an export carries, and that no
 * member name can be forged through the app name.
 *
 * The app name becomes a ZIP member name (`<app>.json`), and `appName` is an
 * owner-controlled, schema-unconstrained string. The HTTP export route
 * sanitized it before calling, but the MCP `compile_app` path forwarded the
 * stored `app_name` RAW — so a name carrying `/`, `\`, `:`, or CR/LF could
 * become the archive entry path a downstream extractor trusts. The builder now
 * sanitizes at its own boundary; these prove no member name can carry a path
 * separator, drive colon, or CR/LF regardless of caller.
 *
 * The membership tests pin the other half: the file is always a ZIP holding
 * the app JSON and the rendered guide as `README.txt`, and carries a companion
 * only when the app HAS one, because a README step for a file that is not in
 * the archive sends somebody looking for it.
 */

import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import { testMediaAssetId, testUuid } from "@/__tests__/helpers/uuid";
import { localizationWireFixture } from "@/lib/commcare/__tests__/localizationWireFixture";
import {
	mediaIds,
	mediaWireFixture,
} from "@/lib/commcare/__tests__/mediaWireFixtures";
import { expandDoc } from "@/lib/commcare/expander";
import { lookupWireCorpus } from "@/lib/commcare/lookup/__tests__/lookupWireCorpus";
import { lookupWireNaming } from "@/lib/commcare/lookup/naming";
import { buildLookupWorkbook } from "@/lib/commcare/lookup/workbook";
import {
	decodeManualImportGuide,
	encodeManualImportGuide,
	manualImportStepKey,
	renderManualImportGuide,
} from "@/lib/publish/manualImportGuide";
import type { LookupWorkbook } from "../../lookup/workbook";
import type { AssetManifest, ResolvedMediaAsset } from "../assetWirePath";
import {
	buildHqJsonExportArchive,
	hqImportFileGuide,
} from "../hqJsonExportArchive";

const { doc, assets: ONE_ASSET } = mediaWireFixture();
const HQ = expandDoc(doc, { assets: ONE_ASSET });
const NO_MEDIA: AssetManifest = new Map();
const corpus = lookupWireCorpus();
const ONE_TABLE = buildLookupWorkbook(
	lookupWireNaming(corpus.definitions),
	corpus.rowsByTable,
);

/** The archive as both callers build it: with the guide over the same inputs. */
function importFile(
	appName: string,
	assets: AssetManifest,
	lookupWorkbook?: LookupWorkbook,
): Buffer {
	const readme = renderManualImportGuide(
		hqImportFileGuide({
			appName,
			doc,
			assets,
			lookupWorkbook,
			managedLookupWorkbooks: [],
			managedLookupTables: [],
			attachmentTarget: null,
			lookupNaming: undefined,
		}),
	);
	return buildHqJsonExportArchive(
		appName,
		doc,
		HQ,
		assets,
		lookupWorkbook,
		[],
		readme,
	);
}

function memberNames(buf: Buffer): string[] {
	return new AdmZip(buf).getEntries().map((e) => e.entryName);
}

function readme(buf: Buffer): string {
	return new AdmZip(buf).readAsText("README.txt");
}

describe("buildHqJsonExportArchive member-name sanitization", () => {
	it.each([
		"../../etc/passwd",
		"C:\\Windows\\system32\\app",
		"name\r\nSet-Cookie: x",
		"..\\..\\..\\x",
		"a/b/c",
	])("emits only safe leaf member names for %j", (evil) => {
		const names = memberNames(importFile(evil, ONE_ASSET, ONE_TABLE));
		// No member may contain a path separator, drive colon, or CR/LF.
		for (const name of names) {
			expect(name).not.toMatch(/[\\/:\r\n]/);
		}
		// The app JSON is still present, as a sanitized leaf, alongside the
		// fixed members.
		expect(names.some((n) => n.endsWith(".json"))).toBe(true);
		expect(names).toContain("multimedia.zip");
		expect(names).toContain("logo.png");
		expect(names).toContain("lookup-tables.xlsx");
		expect(names).toContain("README.txt");
	});

	it("falls back to 'app.json' when the name sanitizes to empty", () => {
		const names = memberNames(importFile("///", NO_MEDIA));
		expect(names).toContain("app.json");
	});

	it("leaves an already-clean name unchanged (idempotent on the HTTP path)", () => {
		const names = memberNames(importFile("Vaccine Tracker (v2)", NO_MEDIA));
		expect(names).toContain("Vaccine Tracker (v2).json");
	});

	it("carries a lookup workbook without an empty multimedia zip beside it", () => {
		const archive = importFile("Tracker", NO_MEDIA, ONE_TABLE);
		expect(memberNames(archive).sort()).toEqual([
			"README.txt",
			"Tracker.json",
			"lookup-tables.xlsx",
		]);
		const text = readme(archive);
		expect(text).toContain("=== 1. Upload the lookup tables ===");
		expect(text).toContain("=== 2. Import the app ===");
		expect(text).toContain("=== 3. Check the app's CommCare version ===");
		/* No media in this export, so no step about a file that isn't here. */
		expect(text).not.toContain("multimedia.zip");
		/* The tables are named, so a reader can see what replacing will touch. */
		expect(text).toContain("records");
		expect(text).toContain("empty");
	});

	it("carries media alone without a workbook, keeping the app step numbered first", () => {
		const archive = importFile("Tracker", ONE_ASSET);
		expect(memberNames(archive).sort()).toEqual([
			"README.txt",
			"Tracker.json",
			"logo.png",
			"multimedia.zip",
		]);
		const text = readme(archive);
		expect(text).toContain("=== 1. Import the app ===");
		expect(text).toContain("=== 2. Check the app's CommCare version ===");
		expect(text).toContain("=== 3. Import the media ===");
		expect(text).not.toContain("lookup-tables.xlsx");
	});

	it("numbers every step when an app carries both companions", () => {
		const text = readme(importFile("Tracker", ONE_ASSET, ONE_TABLE));
		expect(text).toContain("=== 1. Upload the lookup tables ===");
		expect(text).toContain("=== 2. Import the app ===");
		expect(text).toContain("=== 3. Check the app's CommCare version ===");
		expect(text).toContain("=== 4. Import the media ===");
	});

	it("is a ZIP holding the app JSON and the rendered guide for an app with no companions", () => {
		const archive = importFile("Tracker", NO_MEDIA);
		expect(memberNames(archive).sort()).toEqual(["README.txt", "Tracker.json"]);
		expect(readme(archive)).toBe(
			renderManualImportGuide(
				hqImportFileGuide({
					appName: "Tracker",
					doc,
					assets: NO_MEDIA,
					lookupWorkbook: undefined,
					managedLookupWorkbooks: [],
					managedLookupTables: [],
					attachmentTarget: null,
					lookupNaming: undefined,
				}),
			),
		);
	});

	it("preserves actual app, lookup and deduplicated media payloads through both archive layers", () => {
		const zip = new AdmZip(importFile("Media proof", ONE_ASSET, ONE_TABLE));
		expect(JSON.parse(zip.readAsText("Media proof.json"))).toEqual(HQ);
		expect(zip.readFile("lookup-tables.xlsx")).toEqual(
			Buffer.from(ONE_TABLE.bytes),
		);
		const bytes = zip.readFile("multimedia.zip");
		if (!bytes) throw new Error("Missing media archive");
		const media = new AdmZip(bytes);
		const expected = new Map(
			[...ONE_ASSET.values()].map((asset) => [asset.wirePath, asset.bytes]),
		);
		expect(
			new Map(
				media.getEntries().map((entry) => [entry.entryName, entry.getData()]),
			),
		).toEqual(expected);
		expect(expected.size).toBe(5);
	});

	it("PRESERVES non-Latin / accented names (a ZIP member is UTF-8)", () => {
		// The HTTP-header sanitizer is ASCII-only; the archive member is not, so an
		// international app keeps its identity inside the bundle rather than
		// collapsing to "app".
		expect(memberNames(importFile("调查表", NO_MEDIA))).toContain(
			"调查表.json",
		);
		expect(memberNames(importFile("Café Survey", NO_MEDIA))).toContain(
			"Café Survey.json",
		);
	});
});

/** The entries of the import file's `multimedia.zip`, by wire path. */
function bulkEntries(archive: Buffer): Map<string, Buffer> {
	const bytes = new AdmZip(archive).readFile("multimedia.zip");
	if (!bytes) throw new Error("Missing media archive");
	return new Map(
		new AdmZip(bytes)
			.getEntries()
			.map((entry) => [entry.entryName, entry.getData()]),
	);
}

describe("the logo in the HQ import file", () => {
	it("keeps an image the logo shares with a menu in multimedia.zip and puts the logo beside it", () => {
		const shared = ONE_ASSET.get(mediaIds.icon) as ResolvedMediaAsset;
		const archive = importFile("Media proof", ONE_ASSET);
		expect(bulkEntries(archive).get(shared.wirePath)).toEqual(shared.bytes);
		expect(new AdmZip(archive).readFile("logo.png")).toEqual(shared.bytes);
		expect(
			JSON.parse(new AdmZip(archive).readAsText("Media proof.json")),
		).not.toHaveProperty("logo_refs");
	});

	it("leaves a file only the logo uses out of multimedia.zip and carries it as logo<ext>", () => {
		const logoId = testMediaAssetId("wire-logo-only");
		const icon = ONE_ASSET.get(mediaIds.icon) as ResolvedMediaAsset;
		const bytes = Buffer.from(`${icon.bytes?.toString("base64")}logo`);
		const logoAsset: ResolvedMediaAsset = {
			...icon,
			assetId: logoId,
			bytes,
			extension: ".jpg",
			mimeType: "image/jpeg",
			contentHash: "logo-only",
			wirePath: "commcare/logo-only.jpg",
		};
		const assets: AssetManifest = new Map([...ONE_ASSET, [logoId, logoAsset]]);
		const logoDoc = { ...doc, logo: logoId };
		const readme = renderManualImportGuide(
			hqImportFileGuide({
				appName: "Media proof",
				doc: logoDoc,
				assets,
				lookupWorkbook: undefined,
				managedLookupWorkbooks: [],
				managedLookupTables: [],
				attachmentTarget: null,
				lookupNaming: undefined,
			}),
		);
		const archive = buildHqJsonExportArchive(
			"Media proof",
			logoDoc,
			expandDoc(logoDoc, { assets }),
			assets,
			undefined,
			[],
			readme,
		);
		expect(bulkEntries(archive).has(logoAsset.wirePath)).toBe(false);
		expect(bulkEntries(archive).size).toBe(5);
		expect(new AdmZip(archive).readFile("logo.jpg")).toEqual(bytes);
		expect(memberNames(archive)).not.toContain("logo.png");
	});

	it("holds no logo member for an app without a logo", () => {
		const noLogo = { ...doc, logo: undefined };
		const archive = buildHqJsonExportArchive(
			"Media proof",
			noLogo,
			expandDoc(noLogo, { assets: ONE_ASSET }),
			ONE_ASSET,
			undefined,
			[],
			"",
		);
		expect(
			memberNames(archive).filter((name) => name.startsWith("logo")),
		).toEqual([]);
	});
});

describe("the HQ app file's tables managed in CommCare HQ", () => {
	const SECOND = buildLookupWorkbook(
		lookupWireNaming(corpus.definitions.slice(0, 1)),
		corpus.rowsByTable,
	);
	const HEALTH = {
		tag: "records",
		server: "production",
		domain: "acme-health",
		refreshedAt: "2026-11-03T22:15:00.000Z",
	};
	const NORTH = {
		tag: "clinics",
		server: "production",
		domain: "acme-north",
		refreshedAt: "2026-11-04T08:00:00.000Z",
	};
	const workbookOf = (table: typeof HEALTH) => ({
		server: table.server,
		domain: table.domain,
		workbook: SECOND,
	});

	function guideOf(
		lookupWorkbook: LookupWorkbook | undefined,
		managedLookupTables: readonly (typeof HEALTH)[],
		managedLookupWorkbooks = managedLookupTables.map(workbookOf),
	) {
		return hqImportFileGuide({
			appName: "Tracker",
			doc,
			assets: NO_MEDIA,
			lookupWorkbook,
			managedLookupWorkbooks,
			managedLookupTables,
			attachmentTarget: null,
			lookupNaming: undefined,
		});
	}

	function planFeatureLines(steps: ReturnType<typeof guideOf>): string[] {
		return (
			steps.find((step) => step.kind === "plan-features")?.lines ?? []
		).filter((line) => line.startsWith("  - "));
	}

	function archiveOf(
		lookupWorkbook: LookupWorkbook | undefined,
		managedLookupTables: readonly (typeof HEALTH)[],
		managedLookupWorkbooks = managedLookupTables.map(workbookOf),
	): Buffer {
		return buildHqJsonExportArchive(
			"Tracker",
			doc,
			HQ,
			NO_MEDIA,
			lookupWorkbook,
			managedLookupWorkbooks,
			renderManualImportGuide(
				guideOf(lookupWorkbook, managedLookupTables, managedLookupWorkbooks),
			),
		);
	}

	it("still asks for the plan's lookup tables, and adds the managed step, where every table is managed", () => {
		const steps = guideOf(undefined, [HEALTH]);
		expect(
			planFeatureLines(steps).some((line) =>
				line.startsWith("  - Lookup Tables: "),
			),
		).toBe(true);
		const kinds = steps.map((step) => step.kind);
		expect(kinds).not.toContain("lookup-tables");
		const managed = steps.find((step) => step.kind === "managed-lookup-tables");
		expect(managed?.title).toBe("Lookup tables managed in CommCare HQ");
		/* The guide is made on the server for no one reader: the UTC day. */
		expect(managed?.lines).toContain(
			"  records (in acme-health, copied on 3 November 2026)",
		);
		/* With no workbook to carry, no step asks for the plan's lookup tables. */
		expect(
			planFeatureLines(guideOf(undefined, [])).some((line) =>
				line.startsWith("  - Lookup Tables: "),
			),
		).toBe(false);
	});

	it("writes the first workbook and the managed one under a name that carries its project space", () => {
		const archive = archiveOf(ONE_TABLE, [HEALTH]);
		const zip = new AdmZip(archive);
		expect(memberNames(archive).sort()).toEqual([
			"README.txt",
			"Tracker.json",
			"lookup-tables-managed-in-acme-health.xlsx",
			"lookup-tables.xlsx",
		]);
		expect(zip.readFile("lookup-tables.xlsx")).toEqual(
			Buffer.from(ONE_TABLE.bytes),
		);
		expect(zip.readFile("lookup-tables-managed-in-acme-health.xlsx")).toEqual(
			Buffer.from(SECOND.bytes),
		);
		const text = readme(archive);
		expect(text).toContain("=== 1. Upload the lookup tables ===");
		expect(text).toContain("=== 2. Lookup tables managed in CommCare HQ ===");
		expect(text).toContain('"lookup-tables-managed-in-acme-health.xlsx" out');
	});

	it("writes one managed workbook per project space, each step leaving out its own file there", () => {
		const archive = archiveOf(ONE_TABLE, [HEALTH, NORTH]);
		expect(memberNames(archive).sort()).toEqual([
			"README.txt",
			"Tracker.json",
			"lookup-tables-managed-in-acme-health.xlsx",
			"lookup-tables-managed-in-acme-north.xlsx",
			"lookup-tables.xlsx",
		]);
		const text = readme(archive);
		expect(text).toContain("=== 2. Lookup tables managed in acme-health ===");
		expect(text).toContain("=== 3. Lookup tables managed in acme-north ===");
		expect(text).toContain(
			`If you're importing into acme-health, it already has them, so leave\n"lookup-tables-managed-in-acme-health.xlsx" out.`,
		);
		expect(text).toContain(
			`If you're importing into acme-north, it already has them, so leave\n"lookup-tables-managed-in-acme-north.xlsx" out.`,
		);
		/* Each file's step lists that space's tables and no other's. */
		const steps = guideOf(ONE_TABLE, [HEALTH, NORTH]);
		const managed = steps.filter(
			(step) => step.kind === "managed-lookup-tables",
		);
		expect(managed.map((step) => step.lines.join("\n"))).toEqual([
			expect.not.stringMatching(/clinics/),
			expect.not.stringMatching(/records/),
		]);
	});

	it("names apart two project spaces that share a domain, and two domains that spell alike once made safe", () => {
		const india = { ...HEALTH, tag: "wards", server: "india" };
		const colon = { ...HEALTH, tag: "zones", domain: "acme:health" };
		const archive = archiveOf(undefined, [HEALTH, india]);
		expect(
			memberNames(archive)
				.filter((name) => name.endsWith(".xlsx"))
				.sort(),
		).toEqual([
			"lookup-tables-managed-in-acme-health-india.xlsx",
			"lookup-tables-managed-in-acme-health-us.xlsx",
		]);
		const text = readme(archive);
		expect(text).toContain("Lookup tables managed in acme-health (US)");
		expect(text).toContain("Lookup tables managed in acme-health (India)");

		const alike = memberNames(archiveOf(undefined, [HEALTH, colon])).filter(
			(name) => name.endsWith(".xlsx"),
		);
		expect([...alike].sort()).toEqual([
			"lookup-tables-managed-in-acme-health-2.xlsx",
			"lookup-tables-managed-in-acme-health.xlsx",
		]);
		for (const name of alike) {
			expect(name).toMatch(/^lookup-tables-managed-in-[a-z0-9._-]+\.xlsx$/);
		}
		/* Each step of either guide has a key of its own, which the publish
		 * dialog lists them by. */
		for (const pair of [
			[HEALTH, india],
			[HEALTH, colon],
			[HEALTH, NORTH],
		]) {
			const keys = guideOf(ONE_TABLE, pair).map(manualImportStepKey);
			expect(new Set(keys).size).toBe(keys.length);
		}
		/* The names follow the set of workbooks, not their order. */
		expect(
			memberNames(archiveOf(undefined, [colon, HEALTH]))
				.filter((name) => name.endsWith(".xlsx"))
				.sort(),
		).toEqual([...alike].sort());
	});
});

it("carries per-installation worker setup in the manual-import archive and encoded browser guide", () => {
	const uuid = testUuid("practice-install");
	const other = testUuid("regular-install");
	const base = localizationWireFixture("bilingual");
	const blueprint = {
		...base,
		appSettings: {
			...base.appSettings,
			installationProfiles: {
				[uuid]: {
					uuid,
					name: "Practice visits",
					languages: ["eng"],
					requiresPracticeWorker: true,
				},
				[other]: {
					uuid: other,
					name: "Regular visits",
					languages: ["eng"],
					requiresPracticeWorker: false,
				},
			},
		},
	};
	const guide = hqImportFileGuide({
		appName: "Team",
		doc: blueprint,
		assets: NO_MEDIA,
		lookupWorkbook: undefined,
		managedLookupWorkbooks: [],
		managedLookupTables: [],
		attachmentTarget: null,
		lookupNaming: undefined,
	});
	const setup = guide.find((s) => s.kind === "practice-installations");
	expect(setup?.lines.join(" ")).toMatch(
		/Practice visits.*Application Profile.*CommCare_vN.ccz/,
	);
	expect(setup?.lines.join(" ")).not.toContain("Regular visits");
	expect(decodeManualImportGuide(encodeManualImportGuide(guide))).toEqual(
		guide,
	);
	const exported = expandDoc(blueprint, { assets: NO_MEDIA });
	expect(
		exported.build_profiles?.[uuid.replaceAll("-", "")],
	).not.toHaveProperty("practice_mobile_worker_id");
	const archive = buildHqJsonExportArchive(
		"Team",
		blueprint,
		exported,
		NO_MEDIA,
		undefined,
		[],
		renderManualImportGuide(guide),
	);
	expect(readme(archive)).toContain("Practice visits");
	expect(readme(archive)).toContain("CommCare_vN.ccz");
});
