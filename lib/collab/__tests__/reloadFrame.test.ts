/**
 * The `reload` control frame and the notice a landed reload owes. The
 * plausible failures: a bring-in announced in the tab that sent it, a reload
 * of another cause announced as one, a member named from the wrong roster
 * entry or by a blank name, and a malformed frame read as a bring-in.
 */

import { describe, expect, it } from "vitest";
import { presenceFrameSchema } from "@/lib/collab/presenceTypes";
import { parseReloadFrame, reloadNotice } from "@/lib/collab/reloadFrame";
import { hqChangesBroughtInToast } from "@/lib/publish/hqChangesCopy";

const ROSTER = presenceFrameSchema.parse(
	[
		["member-a", "Amara"],
		["member-b", "  "],
		["member-c", "Chen"],
	].map(([userId, name]) => ({
		userId,
		sessionId: `${userId}-session`,
		name,
		image: null,
		email: `${userId}@dimagi.com`,
		color: "#123456",
		location: { kind: "home" },
		updatedAt: 1,
	})),
);

const broughtIn = (batchId: string, actorId: string) => ({
	reason: "hq-changes" as const,
	batchId,
	actorId,
});

describe("parseReloadFrame", () => {
	it("reads each reason the stream sends", () => {
		for (const reason of [
			"replay-unavailable",
			"app-changed",
			"authorization-changed",
		] as const) {
			expect(parseReloadFrame(JSON.stringify({ reason }))).toEqual({ reason });
		}
		expect(
			parseReloadFrame(JSON.stringify(broughtIn("batch-1", "member-a"))),
		).toEqual(broughtIn("batch-1", "member-a"));
	});

	it.each([
		["no data", undefined],
		["not JSON", "reload"],
		["an unknown reason", JSON.stringify({ reason: "elsewhere" })],
		[
			"a bring-in with no batch",
			JSON.stringify({ reason: "hq-changes", actorId: "member-a" }),
		],
		[
			"a bring-in with a blank actor",
			JSON.stringify({ reason: "hq-changes", batchId: "b", actorId: "" }),
		],
		[
			"another reason carrying a batch",
			JSON.stringify({ reason: "app-changed", batchId: "b", actorId: "a" }),
		],
	])("refuses %s", (_label, data) => {
		expect(parseReloadFrame(data as string)).toBeNull();
	});
});

describe("reloadNotice", () => {
	it("names the member who brought the changes in", () => {
		expect(
			reloadNotice(broughtIn("batch-1", "member-c"), new Set(), ROSTER),
		).toBe(hqChangesBroughtInToast("Chen"));
		expect(
			reloadNotice(broughtIn("batch-1", "member-c"), new Set(), ROSTER),
		).toBe(
			"Chen brought in changes from CommCare HQ, so this app now shows the latest. Edits you hadn't saved yet are kept where they still fit.",
		);
	});

	it("falls back where the roster does not hold the member, or holds no name", () => {
		const fallback =
			"Someone in this Project brought in changes from CommCare HQ, so this app now shows the latest. Edits you hadn't saved yet are kept where they still fit.";
		expect(
			reloadNotice(broughtIn("batch-1", "member-z"), new Set(), ROSTER),
		).toBe(fallback);
		expect(
			reloadNotice(broughtIn("batch-1", "member-b"), new Set(), ROSTER),
		).toBe(fallback);
		expect(reloadNotice(broughtIn("batch-1", "member-a"), new Set(), [])).toBe(
			fallback,
		);
	});

	it("says nothing in the tab that sent the batch, or for any other reload", () => {
		expect(
			reloadNotice(
				broughtIn("own-batch", "member-a"),
				new Set(["other-batch", "own-batch"]),
				ROSTER,
			),
		).toBeNull();
		expect(
			reloadNotice({ reason: "app-changed" }, new Set(), ROSTER),
		).toBeNull();
		expect(reloadNotice(null, new Set(), ROSTER)).toBeNull();
	});
});
