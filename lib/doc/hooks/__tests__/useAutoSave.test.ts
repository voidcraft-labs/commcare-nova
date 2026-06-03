/**
 * Regression guard for `projectSaveSlice` — the auto-save change-detection
 * watermark.
 *
 * The subscription fires only when a key in this slice changes reference, so
 * a persisted, user-editable field missing from the slice is set in memory
 * but never saved. This holds the slice's keys against the persisted
 * blueprint schema so an added field can't be dropped from saves unnoticed.
 */

import { describe, expect, it } from "vitest";
import { blueprintDocSchema } from "@/lib/domain";
import { projectSaveSlice } from "../useAutoSave";

describe("projectSaveSlice", () => {
	it("covers every persisted, user-editable top-level field", () => {
		// Every field the blueprint persists EXCEPT `appId` — that one is
		// bookkeeping set once on load, never a user edit, so it's
		// deliberately not a save trigger. (`fieldParent` isn't in the
		// persisted schema at all — it's derived on load.)
		const expected = Object.keys(blueprintDocSchema.shape)
			.filter((key) => key !== "appId")
			.sort();

		// The projection returns a fixed key set regardless of values, so an
		// empty stand-in is enough to read its shape.
		const sliceKeys = Object.keys(projectSaveSlice({} as never)).sort();

		expect(sliceKeys).toEqual(expected);
	});
});
