/**
 * Unit tests for the media_suite.xml oracle (`validator/mediaSuiteOracle.ts`).
 *
 * Each test pins one invariant against a hand-built media-suite fragment: a
 * minimal clean suite the corresponding check passes, and a mutated copy that
 * trips exactly the check under test. The fragments are deliberately small
 * (not full compiler output) so a failing assertion points at one check, not a
 * tangle.
 *
 * The runtime contract each check mirrors is cited in `mediaSuiteOracle.ts`
 * by `file::symbol`; the test names restate the device-visible symptom.
 */

import { describe, expect, it } from "vitest";
import type { ValidationErrorCode } from "@/lib/commcare/validator/errors";
import { validateMediaSuite } from "@/lib/commcare/validator/mediaSuiteOracle";

/** Pull just the error codes for terse assertions. */
function codes(
	errors: ReturnType<typeof validateMediaSuite>,
): ValidationErrorCode[] {
	return errors.map((e) => e.code);
}

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

/**
 * A minimal clean media-suite — one image resource, local authority, version
 * "1", location pointing at `./commcare/<HASH_A>.png`. Bundled.
 */
const CLEAN_MEDIA_SUITE = `<?xml version="1.0"?>
<suite version="1" descriptor="Media Suite File">
  <media path="../../commcare">
    <resource id="media-${HASH_A}-${HASH_A}.png" version="1">
      <location authority="local">./commcare/${HASH_A}.png</location>
    </resource>
  </media>
</suite>`;

const CLEAN_BUNDLE = new Set([`commcare/${HASH_A}.png`]);

// ── Clean baseline ────────────────────────────────────────────────

describe("media-suite oracle — clean baseline", () => {
	it("a fully-resolved minimal media-suite passes clean (no bundle context)", () => {
		expect(validateMediaSuite(CLEAN_MEDIA_SUITE)).toEqual([]);
	});

	it("a fully-resolved minimal media-suite passes clean (with bundle context)", () => {
		expect(validateMediaSuite(CLEAN_MEDIA_SUITE, CLEAN_BUNDLE)).toEqual([]);
	});

	it("the empty media-OFF placeholder passes clean", () => {
		// Nova emits `<suite version="1"/>` when no media is referenced; the
		// runtime parses it as a Suite with zero media blocks, which is
		// legitimate and useful (the absence-of-media is the explicit signal).
		expect(
			validateMediaSuite('<?xml version="1.0"?>\n<suite version="1"/>'),
		).toEqual([]);
	});
});

// ── Parse-time fatal (Category 1) ─────────────────────────────────

describe("media-suite oracle — Category 1 parse-fatal", () => {
	it("flags malformed XML", () => {
		expect(
			codes(
				validateMediaSuite(
					'<?xml version="1.0"?>\n<suite version="1"><media unterminated>',
				),
			),
		).toContain("MEDIA_SUITE_PARSE_ERROR");
	});

	it("flags a missing <suite> root element", () => {
		expect(
			codes(validateMediaSuite('<?xml version="1.0"?>\n<other/>')),
		).toContain("MEDIA_SUITE_NO_SUITE_ELEMENT");
	});

	it("flags a non-integer suite version", () => {
		const xml = `<?xml version="1.0"?>\n<suite version="abc"/>`;
		expect(codes(validateMediaSuite(xml))).toContain(
			"MEDIA_SUITE_VERSION_NOT_INTEGER",
		);
	});

	it("flags a <media> block missing the path attribute", () => {
		const xml = `<?xml version="1.0"?>
<suite version="1">
  <media>
    <resource id="r" version="1">
      <location authority="local">./commcare/${HASH_A}.png</location>
    </resource>
  </media>
</suite>`;
		expect(codes(validateMediaSuite(xml))).toContain("MEDIA_NO_PATH");
	});

	it("flags a <media> block with no <resource> children", () => {
		const xml = `<?xml version="1.0"?>
<suite version="1">
  <media path="../../commcare"></media>
</suite>`;
		expect(codes(validateMediaSuite(xml))).toContain("MEDIA_NO_RESOURCE");
	});

	it("flags a <resource> missing its id", () => {
		const xml = `<?xml version="1.0"?>
<suite version="1">
  <media path="../../commcare">
    <resource version="1">
      <location authority="local">./commcare/${HASH_A}.png</location>
    </resource>
  </media>
</suite>`;
		expect(codes(validateMediaSuite(xml))).toContain("MEDIA_RESOURCE_NO_ID");
	});

	it("flags a <resource> missing its version", () => {
		const xml = `<?xml version="1.0"?>
<suite version="1">
  <media path="../../commcare">
    <resource id="r">
      <location authority="local">./commcare/${HASH_A}.png</location>
    </resource>
  </media>
</suite>`;
		expect(codes(validateMediaSuite(xml))).toContain(
			"MEDIA_RESOURCE_VERSION_NOT_INTEGER",
		);
	});

	it("flags a <resource> with a non-integer version", () => {
		const xml = `<?xml version="1.0"?>
<suite version="1">
  <media path="../../commcare">
    <resource id="r" version="latest">
      <location authority="local">./commcare/${HASH_A}.png</location>
    </resource>
  </media>
</suite>`;
		expect(codes(validateMediaSuite(xml))).toContain(
			"MEDIA_RESOURCE_VERSION_NOT_INTEGER",
		);
	});

	it("flags a <resource> with no <location> children", () => {
		const xml = `<?xml version="1.0"?>
<suite version="1">
  <media path="../../commcare">
    <resource id="r" version="1"></resource>
  </media>
</suite>`;
		expect(codes(validateMediaSuite(xml))).toContain(
			"MEDIA_RESOURCE_NO_LOCATION",
		);
	});

	it("flags a <location> missing its authority", () => {
		const xml = `<?xml version="1.0"?>
<suite version="1">
  <media path="../../commcare">
    <resource id="r" version="1">
      <location>./commcare/${HASH_A}.png</location>
    </resource>
  </media>
</suite>`;
		expect(codes(validateMediaSuite(xml))).toContain(
			"MEDIA_LOCATION_NO_AUTHORITY",
		);
	});

	it("flags a <location> with no path text", () => {
		const xml = `<?xml version="1.0"?>
<suite version="1">
  <media path="../../commcare">
    <resource id="r" version="1">
      <location authority="local"></location>
    </resource>
  </media>
</suite>`;
		expect(codes(validateMediaSuite(xml))).toContain("MEDIA_LOCATION_NO_PATH");
	});
});

// ── Category 2 — parse-clean, install-fatal ───────────────────────

describe("media-suite oracle — Category 2 install-fatal", () => {
	it("flags a remote authority (BasicInstaller's remote branch refuses)", () => {
		// `ResourceParser::parse` accepts `remote` as a known authority, so the
		// suite parses; `BasicInstaller::install` then returns false on the
		// remote branch, failing the resource install.
		const xml = `<?xml version="1.0"?>
<suite version="1">
  <media path="../../commcare">
    <resource id="r" version="1">
      <location authority="remote">./commcare/${HASH_A}.png</location>
    </resource>
  </media>
</suite>`;
		expect(codes(validateMediaSuite(xml))).toContain(
			"MEDIA_LOCATION_UNKNOWN_AUTHORITY",
		);
	});

	it("flags an unknown authority literal", () => {
		// Anything other than `local` / `remote` defaults to remote in
		// `ResourceParser::parse`, which `BasicInstaller::install` then refuses.
		const xml = `<?xml version="1.0"?>
<suite version="1">
  <media path="../../commcare">
    <resource id="r" version="1">
      <location authority="cloud">./commcare/${HASH_A}.png</location>
    </resource>
  </media>
</suite>`;
		expect(codes(validateMediaSuite(xml))).toContain(
			"MEDIA_LOCATION_UNKNOWN_AUTHORITY",
		);
	});

	it("flags duplicate <resource id> siblings", () => {
		// CommCare keys resources by id in a Hashtable; a duplicate id
		// silently last-writer-wins, leaving the first definition's bytes
		// unreachable.
		const xml = `<?xml version="1.0"?>
<suite version="1">
  <media path="../../commcare">
    <resource id="r" version="1">
      <location authority="local">./commcare/${HASH_A}.png</location>
    </resource>
    <resource id="r" version="1">
      <location authority="local">./commcare/${HASH_B}.png</location>
    </resource>
  </media>
</suite>`;
		expect(codes(validateMediaSuite(xml))).toContain(
			"MEDIA_RESOURCE_DUPLICATE_ID",
		);
	});

	it("flags a <location> path not present in the bundled-file set", () => {
		// The compiler bundles `<HASH_A>.png` but not `<HASH_B>.png`; the
		// suite's reference to the latter is install-fatal.
		const xml = `<?xml version="1.0"?>
<suite version="1">
  <media path="../../commcare">
    <resource id="r-a" version="1">
      <location authority="local">./commcare/${HASH_A}.png</location>
    </resource>
    <resource id="r-b" version="1">
      <location authority="local">./commcare/${HASH_B}.png</location>
    </resource>
  </media>
</suite>`;
		const errors = validateMediaSuite(xml, CLEAN_BUNDLE);
		expect(
			errors.some(
				(e) =>
					e.code === "MEDIA_LOCATION_PATH_NOT_BUNDLED" &&
					e.message.includes(`commcare/${HASH_B}.png`),
			),
		).toBe(true);
		// Only the missing entry is flagged, not the bundled one.
		expect(
			errors.some(
				(e) =>
					e.code === "MEDIA_LOCATION_PATH_NOT_BUNDLED" &&
					e.message.includes(`commcare/${HASH_A}.png`),
			),
		).toBe(false);
	});

	it("skips the bundled-file check when no bundle context is supplied", () => {
		// Without a bundle to resolve against, the install-time path check
		// short-circuits — the parse contract (Category 1) still runs.
		const xml = `<?xml version="1.0"?>
<suite version="1">
  <media path="../../commcare">
    <resource id="r" version="1">
      <location authority="local">./commcare/${HASH_B}.png</location>
    </resource>
  </media>
</suite>`;
		expect(validateMediaSuite(xml)).toEqual([]);
	});
});
