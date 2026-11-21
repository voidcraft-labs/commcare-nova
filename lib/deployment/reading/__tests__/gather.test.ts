/**
 * The word an `unrecognized` finding's log line is titled by. A message
 * titles a Sentry issue, so an app's own names in it would be an app's words
 * in an issue title; this is what the test would catch.
 */

import { describe, expect, it } from "vitest";
import { isDeclaredSurfaceKey } from "@/lib/commcare/surface/revision";
import { WorkCancelled } from "@/lib/commcare/workMeter";
import { editModeTest, Pieces, unrecognizedLogKey } from "../gather";

/** A name an author could write, in characters no word of the closed set holds. */
const PLANTED = "QZ9_W7Q";

function sharesNoCharacter(result: string, planted: string): boolean {
	return [...planted].every((character) => !result.includes(character));
}

describe("unrecognizedLogKey", () => {
	it("returns a surface key the manifest declares whole", () => {
		const declared = "schema:Application.multimedia_map";
		expect(isDeclaredSurfaceKey(declared)).toBe(true);
		expect(unrecognizedLogKey(declared)).toBe(declared);
	});

	it.each([
		[`xform:${PLANTED}`, "xform-element"],
		[`xform:data/${PLANTED}`, "xform-element"],
		[`xform:data/${PLANTED}@${PLANTED}`, "xform-attribute"],
		[`Module.${PLANTED}`, "undeclared-json-key"],
		[`DetailColumn.${PLANTED}`, "undeclared-json-key"],
		[`jr://file/commcare/${PLANTED}.png`, "other"],
		[PLANTED, "other"],
		[`${PLANTED}-${PLANTED}`, "other"],
	])("gives %s the word %s, and none of the planted name", (name, word) => {
		expect(isDeclaredSurfaceKey(name)).toBe(false);
		const result = unrecognizedLogKey(name);
		expect(result).toBe(word);
		expect(sharesNoCharacter(result, PLANTED)).toBe(true);
	});

	it("gives an appearance's value and a table's tag the word other", () => {
		for (const name of ["qz9-w7q", "qz9_w7q", "qz9.w7q"]) {
			const result = unrecognizedLogKey(name);
			expect(result).toBe("other");
			expect(sharesNoCharacter(result, name)).toBe(true);
		}
	});
});

it("propagates cancellation while checking whether to read the edit mode setting", async () => {
	const request = new AbortController();
	const check = editModeTest(new Pieces(request.signal), []);
	request.abort();
	await expect(check).rejects.toBeInstanceOf(WorkCancelled);
});
