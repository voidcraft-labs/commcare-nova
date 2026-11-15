/**
 * The identity record is an extraction of its own: the comparison it serves
 * holds the reader of CommCare HQ's apps to it, so it must share no
 * classification with that reader. The plausible failure is an import that
 * reaches `lib/commcare/reader` (a helper borrowed for convenience), after
 * which a mistake in the reader would be made on both sides and compare
 * equal. The boundary is the module graph a bundler resolves from the file.
 */
import { build } from "esbuild";
import { expect, test } from "vitest";

const ENTRY = "lib/commcare/hq/sourceIdentity.ts";

test("the identity record's import graph reaches nothing of the reader", async () => {
	const { metafile } = await build({
		entryPoints: [ENTRY],
		bundle: true,
		write: false,
		metafile: true,
		platform: "node",
		format: "esm",
		packages: "external",
		logLevel: "silent",
	});
	const inputs = Object.keys(metafile.inputs);
	// The graph is the file's own: it holds the entry and the XML parser it reads with.
	expect(inputs).toContain(ENTRY);
	expect(inputs).toContain("lib/commcare/xmlParse.ts");
	expect(
		inputs.filter((input) => input.startsWith("lib/commcare/reader/")),
	).toEqual([]);
});
