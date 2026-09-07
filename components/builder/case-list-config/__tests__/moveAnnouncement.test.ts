import { describe, expect, it } from "vitest";
import {
	atBoundaryAnnouncement,
	movedAnnouncement,
	refusedAnnouncement,
} from "../moveAnnouncement";

describe("accessible move text projection", () => {
	it("reports the landed position, one-based, with the screen", () => {
		expect(
			movedAnnouncement("Client name", "Results", { index: 1, total: 5 }),
		).toBe("Client name moved, now 2 of 5 in Results.");
	});

	it("names the edge when the row is already against it", () => {
		expect(atBoundaryAnnouncement("Client name", "Results", "beginning")).toBe(
			"Client name is already at the beginning of Results.",
		);
		expect(atBoundaryAnnouncement("Phone", "Search", "end")).toBe(
			"Phone is already at the end of Search.",
		);
	});

	it("carries the refusal reason, because a keyboard author has no drop zone", () => {
		expect(
			refusedAnnouncement(
				"Phone",
				"Results",
				"Another collaborator removed that field.",
			),
		).toBe(
			"Phone was not moved in Results. Another collaborator removed that field.",
		);
	});

	it("keeps a single-row sequence readable", () => {
		expect(
			movedAnnouncement("Only field", "Details", { index: 0, total: 1 }),
		).toBe("Only field moved, now 1 of 1 in Details.");
	});
});
