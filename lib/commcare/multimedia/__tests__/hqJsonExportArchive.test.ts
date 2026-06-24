/**
 * Security regression for `buildHqJsonExportArchive`.
 *
 * The app name becomes a ZIP member name (`<app>.json`), and `appName` is an
 * owner-controlled, schema-unconstrained string. The HTTP export route
 * sanitized it before calling, but the MCP `compile_app` path forwarded the
 * stored `app_name` RAW — so a name carrying `/`, `\`, `:`, or CR/LF could
 * become the archive entry path a downstream extractor trusts. The builder now
 * sanitizes at its own boundary; these prove no member name can carry a path
 * separator, drive colon, or CR/LF regardless of caller.
 */

import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import type { HqApplication } from "../../types";
import type { AssetManifest } from "../assetWirePath";
import { buildHqJsonExportArchive } from "../hqJsonExportArchive";

const HQ = { _id: "app" } as unknown as HqApplication;
const NO_MEDIA: AssetManifest = new Map();

function memberNames(buf: Buffer): string[] {
	return new AdmZip(buf).getEntries().map((e) => e.entryName);
}

describe("buildHqJsonExportArchive member-name sanitization", () => {
	it.each([
		"../../etc/passwd",
		"C:\\Windows\\system32\\app",
		"name\r\nSet-Cookie: x",
		"..\\..\\..\\x",
		"a/b/c",
	])("emits only safe leaf member names for %j", (evil) => {
		const names = memberNames(buildHqJsonExportArchive(evil, HQ, NO_MEDIA));
		// No member may contain a path separator, drive colon, or CR/LF.
		for (const name of names) {
			expect(name).not.toMatch(/[\\/:\r\n]/);
		}
		// The app JSON is still present, as a sanitized leaf, alongside the
		// fixed members.
		expect(names.some((n) => n.endsWith(".json"))).toBe(true);
		expect(names).toContain("multimedia.zip");
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
