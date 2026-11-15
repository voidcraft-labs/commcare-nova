/**
 * Acceptance is pure.
 *
 * Contract: two calls with equal input give deeply equal answers; and the
 * module graph a bundler resolves from `acceptance.ts` holds no canonical
 * form of the reader (`reader/canon.ts`), no logger and no database module:
 * it reaches the export's pure carrier findings (`boundaryFindings.ts`) and
 * never the server-only preparation seam (`boundaryValidation.ts`), and it
 * takes the deployment store's target key as a type alone.
 *
 * Plausible failures: acceptance forgiving a canonical pair, which would
 * pass a reader that returns one member of a pair for CommCare HQ's bytes
 * and the other for Nova's; a clock or a store read inside acceptance, which
 * the proof lane's bundle could not load.
 */

import { build } from "esbuild";
import { expect, it } from "vitest";
import { acceptReading } from "../acceptance";
import {
	acceptanceInput,
	navigationBaseRead,
	readClean,
	readingInput,
} from "./acceptanceInput";

const ENTRY = "lib/deployment/reading/acceptance.ts";

it("gives deeply equal answers to two calls with equal input", async () => {
	const { source, modules } = await navigationBaseRead();
	const reader = readingInput(source, modules);
	const input = acceptanceInput(reader, readClean(reader));
	expect(acceptReading(input)).toEqual(acceptReading(input));
});

it("reaches no canonical form, no logger and no database module", async () => {
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
	expect(inputs).toContain(ENTRY);
	expect(inputs).toContain("lib/export/boundaryFindings.ts");
	expect(inputs).toContain("lib/commcare/reader/index.ts");
	expect(inputs).not.toContain("lib/commcare/reader/canon.ts");
	expect(inputs).not.toContain("lib/export/boundaryValidation.ts");
	expect(inputs).not.toContain("lib/deployment/store.ts");
	expect(inputs).not.toContain("lib/logger.ts");
	expect(
		inputs.filter(
			(input) =>
				input.startsWith("lib/db/") ||
				input.startsWith("lib/case-store/") ||
				input === "lib/lookup/service.ts" ||
				input.startsWith("lib/storage/"),
		),
	).toEqual([]);
});
