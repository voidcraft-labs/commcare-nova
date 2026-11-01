/**
 * The cutover's pre-step fixtures and `facts.json`, held to their digests.
 *
 * The fixtures are documents in the shape `main` stored, and `facts.json` is
 * what `main`'s own code derived from them. Once the code that admitted them
 * is gone neither can be produced again, so each file must keep the content
 * `digests.json` records for it, and `digests.json` names exactly the files
 * the directory holds.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";

const PRE_STEP = join(import.meta.dirname, "fixtures", "pre-step");

function readJson(name: string): unknown {
	return JSON.parse(readFileSync(join(PRE_STEP, name), "utf8"));
}

it("holds every pre-step fixture and the facts to the digests recorded for them", () => {
	const digests = readJson("digests.json") as Record<string, string>;
	const present = readdirSync(PRE_STEP)
		.filter((name) => name.endsWith(".json") && name !== "digests.json")
		.sort();
	expect(present).toContain("facts.json");
	expect(Object.keys(digests).sort()).toEqual(present);
	for (const name of present)
		expect(canonicalJsonDigest(readJson(name)), name).toBe(digests[name]);
});
