import { expect, it } from "vitest";
import { deriveRunId } from "../runId";

const now = new Date("2026-04-24T12:00:00Z");
const uuidV4 =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

it.each([0, 60_000, 1_799_999, -1_000])(
	"continues a run after %i ms, including a backwards clock adjustment",
	(elapsed) => {
		expect(
			deriveRunId({
				currentRunId: "existing-run",
				lastActiveMs: now.getTime() - elapsed,
				now,
			}),
		).toBe("existing-run");
	},
);
it.each([1_800_000, 1_800_001, 86_400_000, null])(
	"starts independent runs after %s ms of inactivity or unknown activity",
	(elapsed) => {
		const input = {
			currentRunId: "old-run",
			lastActiveMs: elapsed === null ? null : now.getTime() - elapsed,
			now,
		};
		const first = deriveRunId(input);
		const second = deriveRunId(input);
		expect(first).toMatch(uuidV4);
		expect(second).toMatch(uuidV4);
		expect(first).not.toBe(second);
	},
);
it("creates a run even when an app with no prior run was just written", () => {
	expect(
		deriveRunId({ currentRunId: null, lastActiveMs: now.getTime(), now }),
	).toMatch(uuidV4);
});
