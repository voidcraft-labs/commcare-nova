/**
 * `probeBuildProfile` — what a refusal from CommCare HQ actually means.
 *
 * The whole point of this probe is to answer one question: does the
 * released build serve the profile a device installs from? So the ONE
 * thing it must never do is report "I could not ask" as "the build is
 * broken". A deployment's contract keeps those apart everywhere else,
 * and a misclassification here launders an expired key or a rate limit
 * into a person being told their release does not work.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { probeBuildProfile } from "../client";

const CREDS = { username: "u", apiKey: "k", server: "production" } as const;

function respondWith(status: number) {
	vi.stubGlobal(
		"fetch",
		vi.fn(
			async () => new Response(status === 200 ? "profile" : "", { status }),
		),
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("what the probe treats as a verdict on the build", () => {
	it("calls only a 404 not-installable, because that is CommCare HQ serving no profile", async () => {
		respondWith(404);
		const result = await probeBuildProfile(CREDS as never, "acme", "hq-1");
		expect(result).toEqual({ ok: false, reason: "not-installable" });
	});

	it.each([401, 403, 429, 400, 500, 503])(
		"reports %i as unavailable, because nothing was learned about the build",
		async (status) => {
			respondWith(status);
			const result = await probeBuildProfile(CREDS as never, "acme", "hq-1");
			expect(result).toEqual({ ok: false, reason: "unavailable" });
		},
	);

	it("passes when CommCare HQ serves the profile", async () => {
		respondWith(200);
		const result = await probeBuildProfile(CREDS as never, "acme", "hq-1");
		expect(result).toEqual({ ok: true });
	});
});
