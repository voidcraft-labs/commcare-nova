/**
 * The one request Nova makes to CommCare HQ goes to the credentials' own
 * server and nowhere else, whatever path a caller hands it.
 *
 * Contract: `sendHq` takes a path on the credentials' server, composes it
 * with that server's origin, and sends nothing where the result names any
 * other origin or carries a user name or password; it follows no redirect;
 * and a list read never requests a URL CommCare HQ wrote into a page. The
 * plausible failures: a caller's path (or a domain spliced into one) that
 * reaches another host with the stored key in its Authorization header, a
 * redirect followed to another host, and a `meta.next` URL followed.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { type CommCareCredentials, hqDomainPath, sendHq } from "../http";
import { readHqCollection } from "../readCollection";

const creds: CommCareCredentials = {
	username: "worker@example.org",
	apiKey: "secret-key",
	server: "production",
};

interface Recorded {
	readonly url: string;
	readonly authorization: string | null;
	readonly redirect: RequestRedirect | undefined;
}

function recordFetch(answer: (url: string) => Response): Recorded[] {
	const calls: Recorded[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init: RequestInit) => {
			calls.push({
				url,
				authorization: new Headers(init.headers).get("Authorization"),
				redirect: init.redirect,
			});
			return answer(url);
		}),
	);
	return calls;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("sendHq", () => {
	it.each([
		"http://169.254.169.254/computeMetadata/v1/",
		"https://india.commcarehq.org/a/d/",
		"https://www.commcarehq.org@other.example/",
		"https://www.commcarehq.org.other.example/",
		"//other.example/a",
		"/\\other.example/a",
		"a/d/api/",
	])("sends nothing for %s", async (path) => {
		const calls = recordFetch(() => new Response("{}"));
		await expect(
			sendHq(creds, path, { signal: AbortSignal.timeout(5_000) }),
		).rejects.toThrow(/nothing was sent/);
		expect(calls).toEqual([]);
	});

	it("sends a path on the credentials' own server once, following no redirect", async () => {
		const calls = recordFetch(() => new Response("{}"));
		const answer = await sendHq(creds, "/a/demo/api/group/v1/?limit=1", {
			signal: AbortSignal.timeout(5_000),
		});
		await answer.discard();
		expect(calls).toEqual([
			{
				url: "https://www.commcarehq.org/a/demo/api/group/v1/?limit=1",
				authorization: "ApiKey worker@example.org:secret-key",
				redirect: "manual",
			},
		]);
	});

	it("answers a redirect to another host as a refusal, with one request sent", async () => {
		const calls = recordFetch(
			() =>
				new Response(null, {
					status: 302,
					headers: { Location: "https://other.example/steal" },
				}),
		);
		const answer = await sendHq(creds, "/a/demo/api/group/v1/", {
			signal: AbortSignal.timeout(5_000),
		});
		await answer.discard();
		expect(answer.ok).toBe(false);
		expect(calls.map((call) => call.url)).toEqual([
			"https://www.commcarehq.org/a/demo/api/group/v1/",
		]);
	});
});

describe("hqDomainPath", () => {
	it("names a valid project space and refuses one that would name another resource", () => {
		expect(hqDomainPath("demo-space")).toBe("/a/demo-space");
		for (const domain of ["a/../../x?y", "d#x", "..", "d/e"])
			expect(() => hqDomainPath(domain)).toThrow();
	});
});

describe("a list read", () => {
	it("never requests the next page URL CommCare HQ writes, only its own first path with an offset", async () => {
		const calls = recordFetch((url) =>
			Response.json(
				url.includes("offset=")
					? {
							meta: { next: null, total_count: 2, limit: 1, offset: 1 },
							objects: [{ id: "b" }],
						}
					: {
							meta: {
								next: "https://other.example/a/demo/api/group/v1/?offset=1",
								total_count: 2,
								limit: 1,
								offset: 0,
							},
							objects: [{ id: "a" }],
						},
			),
		);
		await readHqCollection(creds, {
			label: "groups",
			firstUrl: "/a/demo/api/group/v1/?limit=1",
			maxBytes: 1_000_000,
			maxRows: 10,
			maxPages: 10,
			row: (raw) => raw as { id: string },
			identity: (row) => row.id,
		});
		expect(calls.length).toBeGreaterThan(1);
		for (const call of calls)
			expect(new URL(call.url).origin).toBe("https://www.commcarehq.org");
		expect(
			calls.every((call) =>
				call.url.startsWith("https://www.commcarehq.org/a/demo/api/group/v1/"),
			),
		).toBe(true);
	});
});
