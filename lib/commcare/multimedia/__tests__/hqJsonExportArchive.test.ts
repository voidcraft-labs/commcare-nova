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
 * The membership tests pin the other half: an app carries a companion only
 * when it HAS one, because a README step for a file that is not in the archive
 * sends somebody looking for it.
 */

import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import { mediaWireFixture } from "@/lib/commcare/__tests__/mediaWireFixtures";
import { expandDoc } from "@/lib/commcare/expander";
import { lookupWireCorpus } from "@/lib/commcare/lookup/__tests__/lookupWireCorpus";
import { lookupWireNaming } from "@/lib/commcare/lookup/naming";
import { buildLookupWorkbook } from "@/lib/commcare/lookup/workbook";
import type { AssetManifest } from "../assetWirePath";
import { buildHqJsonExportArchive } from "../hqJsonExportArchive";

const { doc, assets: ONE_ASSET } = mediaWireFixture();
const HQ = expandDoc(doc, { assets: ONE_ASSET });
const NO_MEDIA: AssetManifest = new Map();
const corpus = lookupWireCorpus();
const ONE_TABLE = buildLookupWorkbook(
	lookupWireNaming(corpus.definitions),
	corpus.rowsByTable,
);

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
		const names = memberNames(
			buildHqJsonExportArchive(evil, HQ, ONE_ASSET, ONE_TABLE),
		);
		// No member may contain a path separator, drive colon, or CR/LF.
		for (const name of names) {
			expect(name).not.toMatch(/[\\/:\r\n]/);
		}
		// The app JSON is still present, as a sanitized leaf, alongside the
		// fixed members.
		expect(names.some((n) => n.endsWith(".json"))).toBe(true);
		expect(names).toContain("multimedia.zip");
		expect(names).toContain("lookup-tables.xlsx");
		expect(names).toContain("README.txt");
	});

	it("falls back to 'app.json' when the name sanitizes to empty", () => {
		const names = memberNames(buildHqJsonExportArchive("///", HQ, NO_MEDIA));
		expect(names).toContain("app.json");
	});

	it("leaves an already-clean name unchanged (idempotent on the HTTP path)", () => {
		const names = memberNames(
			buildHqJsonExportArchive("Vaccine Tracker (v2)", HQ, NO_MEDIA),
		);
		expect(names).toContain("Vaccine Tracker (v2).json");
	});

	it("carries a lookup workbook without an empty multimedia zip beside it", () => {
		const archive = buildHqJsonExportArchive(
			"Tracker",
			HQ,
			NO_MEDIA,
			ONE_TABLE,
		);
		expect(memberNames(archive).sort()).toEqual([
			"README.txt",
			"Tracker.json",
			"lookup-tables.xlsx",
		]);
		const text = readme(archive);
		expect(text).toContain("This archive has two files");
		expect(text).toContain("=== 1. Upload the lookup tables ===");
		expect(text).toContain("=== 2. Import the app ===");
		/* No media in this export, so no step about a file that isn't here. */
		expect(text).not.toContain("multimedia.zip");
		/* The tables are named, so a reader can see what replacing will touch. */
		expect(text).toContain("records");
		expect(text).toContain("empty");
	});

	it("carries media alone without a workbook, keeping the app step numbered first", () => {
		const archive = buildHqJsonExportArchive("Tracker", HQ, ONE_ASSET);
		expect(memberNames(archive).sort()).toEqual([
			"README.txt",
			"Tracker.json",
			"multimedia.zip",
		]);
		const text = readme(archive);
		expect(text).toContain("=== 1. Import the app ===");
		expect(text).toContain("=== 2. Import the media ===");
		expect(text).not.toContain("lookup-tables.xlsx");
	});

	it("numbers all three steps when an app carries both companions", () => {
		const text = readme(
			buildHqJsonExportArchive("Tracker", HQ, ONE_ASSET, ONE_TABLE),
		);
		expect(text).toContain("This archive has three files");
		expect(text).toContain("=== 1. Upload the lookup tables ===");
		expect(text).toContain("=== 2. Import the app ===");
		expect(text).toContain("=== 3. Import the media ===");
	});

	it("preserves actual app, lookup and deduplicated media payloads through both archive layers", () => {
		const zip = new AdmZip(
			buildHqJsonExportArchive("Media proof", HQ, ONE_ASSET, ONE_TABLE),
		);
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
		expect(
			memberNames(buildHqJsonExportArchive("调查表", HQ, NO_MEDIA)),
		).toContain("调查表.json");
		expect(
			memberNames(buildHqJsonExportArchive("Café Survey", HQ, NO_MEDIA)),
		).toContain("Café Survey.json");
	});
});
