/**
 * The one flag of a project space a bring-in reads, over CommCare HQ's own
 * answers (`proof/hq-reads/reading/project-spaces*`).
 *
 * A write read as saved only if changed for a project space whose builds
 * save it every time, a lost membership read as the flag being off, and a
 * slow list read as an answer are what these cases would catch.
 */

import type { MockAgent } from "undici";
import { afterEach, expect, it, vi } from "vitest";
import { withHttpPeer } from "@/__tests__/helpers/httpPeer";
import {
	replyRetained,
	retainedBodyJson,
	retainedBodyText,
	retainedReadingRead,
} from "@/__tests__/helpers/retainedHqReads";
import { log } from "@/lib/logger";
import { readHqSaveOnlyEditedAnswers } from "../client";
import { hqPrivateFeatureFlag } from "../projectSpaceCompatibility";

const CREDS = { username: "account", apiKey: "key", server: "india" } as const;
const HOST = "https://india.commcarehq.org";
const ALL = "/api/user_domains/v1/?limit=100";
const FLAGGED = `/api/user_domains/v1/?limit=100&feature_flag=${hqPrivateFeatureFlag("save-only-edited-answers").slug}`;
/** The project space the retained list holds. */
const SPACE = (
	retainedBodyJson(retainedReadingRead("project-spaces")).objects as {
		domain_name: string;
	}[]
)[0].domain_name;

afterEach(() => vi.useRealTimers());

const intercept = (peer: MockAgent, path: string) =>
	peer.get(HOST).intercept({ path, method: "GET" });
const paths = (peer: MockAgent) =>
	(peer.getCallHistory()?.calls() ?? []).map((call) =>
		call.fullUrl.replace(HOST, ""),
	);

it("is applied where the filtered list holds the project space, and not applied where it does not", async () => {
	await withHttpPeer(async (peer) => {
		replyRetained(intercept(peer, ALL), retainedReadingRead("project-spaces"));
		replyRetained(
			intercept(peer, FLAGGED),
			retainedReadingRead("project-spaces-flag-on"),
		);
		expect(await readHqSaveOnlyEditedAnswers(CREDS, SPACE)).toEqual({
			kind: "applied",
		});
		replyRetained(intercept(peer, ALL), retainedReadingRead("project-spaces"));
		replyRetained(
			intercept(peer, FLAGGED),
			retainedReadingRead("project-spaces-flag-off"),
		);
		expect(await readHqSaveOnlyEditedAnswers(CREDS, SPACE)).toEqual({
			kind: "not-applied",
		});
		expect(paths(peer)).toEqual([ALL, FLAGGED, ALL, FLAGGED]);
	});
});

it("is not-a-member where the whole list does not hold the project space, and asks no filtered list", async () => {
	await withHttpPeer(async (peer) => {
		replyRetained(intercept(peer, ALL), retainedReadingRead("project-spaces"));
		expect(await readHqSaveOnlyEditedAnswers(CREDS, "another-space")).toEqual({
			kind: "not-a-member",
		});
		expect(paths(peer)).toEqual([ALL]);
	});
});

it("fails as a key HQ did not accept where either list answers 401", async () => {
	const keyRefused = {
		kind: "failed",
		failure: {
			kind: "key-not-accepted",
			request: "project-spaces",
			status: 401,
		},
	};
	await withHttpPeer(async (peer) => {
		intercept(peer, ALL).reply(401, "");
		expect(await readHqSaveOnlyEditedAnswers(CREDS, SPACE)).toEqual(keyRefused);
		replyRetained(intercept(peer, ALL), retainedReadingRead("project-spaces"));
		intercept(peer, FLAGGED).reply(401, "");
		expect(await readHqSaveOnlyEditedAnswers(CREDS, SPACE)).toEqual(keyRefused);
	});
});

it("fails as refused, logged as Nova's to fix, where HQ no longer knows the flag", async () => {
	await withHttpPeer(async (peer) => {
		replyRetained(intercept(peer, ALL), retainedReadingRead("project-spaces"));
		intercept(peer, FLAGGED).reply(400, "");
		expect(await readHqSaveOnlyEditedAnswers(CREDS, SPACE)).toEqual({
			kind: "failed",
			failure: { kind: "refused", request: "project-spaces", status: 400 },
		});
		expect(log.error).toHaveBeenCalledWith(
			"[commcare] feature flag list refused",
			undefined,
			expect.objectContaining({ status: 400 }),
		);
	});
});

it("gives each list the default thirty seconds, not the publish probe's five", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	await withHttpPeer(async (peer) => {
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const whole = retainedReadingRead("project-spaces");
		intercept(peer, ALL).reply(async () => {
			reached.resolve();
			await release.promise;
			return { statusCode: 200, data: retainedBodyText(whole) };
		});
		const filteredReached = Promise.withResolvers<void>();
		const filteredRelease = Promise.withResolvers<void>();
		intercept(peer, FLAGGED).reply(async () => {
			filteredReached.resolve();
			await filteredRelease.promise;
			return { statusCode: 200, data: "{}" };
		});
		let settled = false;
		const pending = readHqSaveOnlyEditedAnswers(CREDS, SPACE).finally(() => {
			settled = true;
		});
		try {
			await reached.promise;
			await vi.advanceTimersByTimeAsync(29_999);
			release.resolve();
			await filteredReached.promise;
			await vi.advanceTimersByTimeAsync(29_999);
			expect(settled).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			expect(await pending).toEqual({
				kind: "failed",
				failure: { kind: "timed-out", request: "project-spaces", status: 503 },
			});
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			release.resolve();
			filteredRelease.resolve();
			await pending;
		}
	});
});
