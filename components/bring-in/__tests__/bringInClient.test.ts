/**
 * The bring-in page's requests over the responses its routes and the network
 * can give, with `fetch` answering as the route would.
 *
 * It would catch: a route's JSON refusal read as a lost request, or a page a
 * proxy or the sign-in redirect served read as a refusal; a JSON body that is
 * no stream read as an answer; a `done` line carrying the other route's answer
 * kind taken as this route's answer; a picker answer of a kind the page cannot
 * draw handed to it; and a network failure that throws into the page.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { BringInInput, ReadingKey } from "@/lib/deployment";
import { fetchHqApps, postCreate, postRead } from "../bringInClient";

const KEY: ReadingKey = {
	projectId: "project",
	server: "production",
	domain: "clinic",
	remoteAppId: "a".repeat(32),
};

const INPUT: BringInInput = {
	...KEY,
	readingId: "019a7f3c-2b1d-7e40-8a9b-0c1d2e3f4a5b",
	reviewDigest: "b".repeat(64),
	appName: "Clinic visits",
	runsOnlyOn: null,
	splitDatetime: false,
	tableChoices: {},
};

function answering(response: () => Response | Promise<Response>) {
	const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
		response(),
	);
	vi.stubGlobal("fetch", fetch);
	return fetch;
}

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function stream(lines: readonly unknown[]): Response {
	return new Response(
		lines.map((line) => `${JSON.stringify(line)}\n`).join(""),
		{
			status: 200,
			headers: { "content-type": "application/x-ndjson" },
		},
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("postRead and postCreate", () => {
	it("answer the route's last line, having handed each stage on as it came", async () => {
		const answer = { kind: "stop", finding: { code: "app-gone" } };
		answering(() =>
			stream([
				{ type: "stage", stage: "connecting" },
				{ type: "done", answer },
			]),
		);
		const events: unknown[] = [];
		const end = await postRead(
			KEY,
			(event) => events.push(event),
			new AbortController().signal,
		);
		expect(end).toEqual({ kind: "done", answer });
		expect(events).toEqual([{ type: "stage", stage: "connecting" }]);
	});

	it("answer failed for the stream's failed line", async () => {
		answering(() => stream([{ type: "failed" }]));
		expect(await postCreate(INPUT, () => {})).toEqual({ kind: "failed" });
	});

	it("answer a JSON body with a known code as that refusal, whatever its status", async () => {
		answering(() =>
			json(403, { error: "No access", code: "no_project_access" }),
		);
		expect(await postRead(KEY, () => {}, new AbortController().signal)).toEqual(
			{ kind: "refused", refusal: "no_project_access" },
		);
		answering(() => json(400, { error: "Bad", code: "invalid_input" }));
		expect(await postCreate(INPUT, () => {})).toEqual({
			kind: "refused",
			refusal: "invalid_input",
		});
	});

	it("answer lost for a page that is no stream and names no refusal of theirs", async () => {
		for (const response of [
			() => new Response("<html>Sign in</html>", { status: 401 }),
			() => json(500, { error: "Something broke", code: "not_a_refusal" }),
			() => json(200, { kind: "review" }),
		]) {
			answering(response);
			expect(
				await postRead(KEY, () => {}, new AbortController().signal),
			).toEqual({ kind: "lost" });
		}
	});

	it("answer lost for a done line whose answer is another route's kind", async () => {
		answering(() =>
			stream([{ type: "done", answer: { kind: "created", receipt: {} } }]),
		);
		expect(await postRead(KEY, () => {}, new AbortController().signal)).toEqual(
			{ kind: "lost" },
		);
		answering(() => stream([{ type: "done", answer: { kind: "review" } }]));
		expect(await postCreate(INPUT, () => {})).toEqual({ kind: "lost" });
	});

	it("answer lost, and throw nothing, where the request never reached the route", async () => {
		answering(() => {
			throw new TypeError("Failed to fetch");
		});
		expect(await postCreate(INPUT, () => {})).toEqual({ kind: "lost" });
	});
});

describe("fetchHqApps", () => {
	it("asks for exactly the project space named and answers the picker", async () => {
		const picker = { kind: "apps", apps: [] };
		const fetch = answering(() => json(200, { picker }));
		expect(
			await fetchHqApps(
				{ domain: "clinic & co" },
				new AbortController().signal,
			),
		).toEqual({ ok: true, value: picker });
		expect(fetch.mock.calls[0]?.[0]).toBe(
			"/api/commcare/hq-apps?domain=clinic+%26+co",
		);
	});

	it("answers a picker of a kind the page does not draw as no answer", async () => {
		answering(() => json(200, { picker: { kind: "elsewhere" } }));
		expect(
			await fetchHqApps({ domain: "clinic" }, new AbortController().signal),
		).toEqual({ ok: false, refusal: null });
	});

	it("answers the route's refusal by its code, and a failed request as none", async () => {
		answering(() => json(400, { error: "Bad", code: "invalid_input" }));
		expect(
			await fetchHqApps({ domain: "clinic" }, new AbortController().signal),
		).toEqual({ ok: false, refusal: "invalid_input" });
		answering(() => {
			throw new TypeError("Failed to fetch");
		});
		expect(
			await fetchHqApps({ domain: "clinic" }, new AbortController().signal),
		).toEqual({ ok: false, refusal: null });
	});
});
