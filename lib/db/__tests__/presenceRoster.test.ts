import { describe, expect, it } from "vitest";
import {
	type PresenceRosterRow,
	projectPresenceRoster,
} from "@/lib/db/presenceRoster";

function row(
	sessionId: string,
	location: unknown = { kind: "home" },
): PresenceRosterRow {
	return {
		user_id: "user-1",
		session_id: sessionId,
		name: "Collaborator",
		image: null,
		email: "collaborator@dimagi.com",
		color: "#123456",
		location,
		updated_at: new Date(1_700_000_000_000),
	};
}

describe("projectPresenceRoster", () => {
	it("projects one exact complete current page", () => {
		expect(projectPresenceRoster([row("session-1")])).toEqual([
			{
				userId: "user-1",
				sessionId: "session-1",
				name: "Collaborator",
				image: null,
				email: "collaborator@dimagi.com",
				color: "#123456",
				location: { kind: "home" },
				updatedAt: 1_700_000_000_000,
			},
		]);
	});

	it("rejects the whole page when any stored row is malformed", () => {
		expect(() =>
			projectPresenceRoster([
				row("valid"),
				row("malformed", { kind: "not-a-location" }),
			]),
		).toThrow();
	});
});
