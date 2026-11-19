import { afterEach, describe, expect, it, vi } from "vitest";
import { postHqChangesBringIn } from "@/components/builder/hqChangesClient";
import {
	HQ_CHANGES_NO_EDIT_ACCESS_LINE,
	HQ_CHANGES_SIGNED_OUT_LINE,
} from "@/lib/publish/hqChangesCopy";
import { READING_REFUSAL_COPY } from "@/lib/publish/hqReadingCopy";

const BODY = {
	appId: "app-1",
	server: "production",
	domain: "clinic",
	readingId: "reading-1",
	reviewDigest: "d".repeat(64),
	tableChoices: {},
} as const;

afterEach(() => {
	vi.unstubAllGlobals();
});

/** The bring-in, answered by the route with `response`. */
async function answeredWith(response: Response) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => response),
	);
	return postHqChangesBringIn(BODY, () => undefined);
}

describe("a route's answer that is no stream", () => {
	it("says the member's session ended, which checking again after signing in can help", async () => {
		expect(
			await answeredWith(
				Response.json({ error: "Unauthorized" }, { status: 401 }),
			),
		).toEqual({
			kind: "refused",
			message: HQ_CHANGES_SIGNED_OUT_LINE,
			checkAgain: true,
		});
	});

	it("says the member can no longer edit the app, for a denial and a missing app alike, with nothing to check again", async () => {
		for (const status of [403, 404]) {
			expect(
				await answeredWith(
					Response.json({ error: "App not found" }, { status }),
				),
			).toEqual({
				kind: "refused",
				message: HQ_CHANGES_NO_EDIT_ACCESS_LINE,
				checkAgain: false,
			});
		}
	});

	it("says the route's own sentence for a body it can't read", async () => {
		expect(
			await answeredWith(
				Response.json(
					{ error: READING_REFUSAL_COPY.invalid_input, code: "invalid_input" },
					{ status: 400 },
				),
			),
		).toEqual({
			kind: "refused",
			message: READING_REFUSAL_COPY.invalid_input,
			checkAgain: false,
		});
	});

	it("keeps a failure on Nova's side and a lost answer apart from a refusal", async () => {
		expect(
			await answeredWith(
				Response.json({ error: "Internal server error" }, { status: 500 }),
			),
		).toEqual({ kind: "failed" });
		expect(
			await answeredWith(new Response("<html></html>", { status: 200 })),
		).toEqual({ kind: "lost" });
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new TypeError("Failed to fetch");
			}),
		);
		expect(await postHqChangesBringIn(BODY, () => undefined)).toEqual({
			kind: "lost",
		});
	});
});
