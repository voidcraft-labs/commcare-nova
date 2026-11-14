/**
 * What Settings says for each failed check of a key: every kind at both
 * moments, and every answer Settings could meet held to the sentence it
 * printed before the ladder chose by kind.
 *
 * An edge's 401 losing the key sentence, or a redirect gaining the
 * unavailable one, is what these cases would catch.
 */

import { describe, expect, it } from "vitest";
import {
	classifyHqFailure,
	HQ_FAILURE_KINDS,
	type HqFailure,
	type HqFailureKind,
} from "@/lib/commcare/hq/failure";
import type { CommCareApiError } from "@/lib/commcare/hq/http";
import { settingsFailureMessage } from "../hqFailureMessage";

const VERIFY = { moment: "verify", server: "eu" } as const;
const REFRESH = { moment: "refresh" } as const;

const KEY =
	"CommCare HQ (EU: eu.commcarehq.org) rejected this API key. Check that you copied it correctly, and that EU is the server where your account lives, a key only works on the server that issued it.";
const REVOKED =
	"CommCare HQ no longer accepts your stored API key, it may have been revoked or expired. Disconnect and reconnect with a new key.";
const RATE = "Rate limited by CommCare HQ. Wait a moment and try again.";
const UNAVAILABLE = "CommCare HQ is unavailable. Try again later.";
const status = (code: number) =>
	`CommCare HQ returned an error (HTTP ${code}).`;

function failureOf(kind: HqFailureKind, code: number): HqFailure {
	return kind === "permission"
		? { kind, request: "app-list", status: code, permission: "edit-apps" }
		: { kind, request: "app-list", status: code };
}

describe("settingsFailureMessage, by kind", () => {
	const expected: Record<
		Exclude<HqFailureKind, "gateway-refused" | "browser-only">,
		readonly [code: number, verify: string, refresh: string]
	> = {
		"key-not-accepted": [401, KEY, REVOKED],
		"plan-lacks-api-access": [401, KEY, REVOKED],
		"api-cut-off": [401, KEY, REVOKED],
		"rate-limited": [429, RATE, RATE],
		"hq-unavailable": [503, UNAVAILABLE, UNAVAILABLE],
		"timed-out": [503, UNAVAILABLE, UNAVAILABLE],
		"too-large": [502, UNAVAILABLE, UNAVAILABLE],
		"answer-unreadable": [502, UNAVAILABLE, UNAVAILABLE],
		"not-a-member": [403, status(403), status(403)],
		permission: [403, status(403), status(403)],
		"not-found": [404, status(404), status(404)],
		refused: [400, status(400), status(400)],
	};

	it("covers every kind", () => {
		expect(
			[...Object.keys(expected), "gateway-refused", "browser-only"].sort(),
		).toEqual([...HQ_FAILURE_KINDS].sort());
	});

	it.each(Object.entries(expected))(
		"words %s at both moments",
		(kind, [code, verify, refresh]) => {
			const failure = failureOf(kind as HqFailureKind, code);
			expect(settingsFailureMessage(failure, VERIFY)).toBe(verify);
			expect(settingsFailureMessage(failure, REFRESH)).toBe(refresh);
		},
	);

	it.each(["gateway-refused", "browser-only"] as const)(
		"words %s by its status",
		(kind) => {
			const rows: readonly [number, string, string][] = [
				[401, KEY, REVOKED],
				[429, RATE, RATE],
				[500, UNAVAILABLE, UNAVAILABLE],
				[504, UNAVAILABLE, UNAVAILABLE],
				[302, status(302), status(302)],
				[403, status(403), status(403)],
			];
			for (const [code, verify, refresh] of rows) {
				const failure = failureOf(kind, code);
				expect(settingsFailureMessage(failure, VERIFY)).toBe(verify);
				expect(settingsFailureMessage(failure, REFRESH)).toBe(refresh);
			}
		},
	);
});

/** The sentence each moment printed for a status before the ladder chose by kind. */
function printedBefore(
	error: CommCareApiError,
	moment: "verify" | "refresh",
): string {
	if (error.status === 401) return moment === "verify" ? KEY : REVOKED;
	if (error.status === 429) return RATE;
	if (error.status >= 500) return UNAVAILABLE;
	return status(error.status);
}

describe("settingsFailureMessage, over the answers Settings meets", () => {
	const edge = (code: number): CommCareApiError => ({
		success: false,
		status: code,
		edgeRefusal: true,
	});
	const hq = (code: number): CommCareApiError => ({
		success: false,
		status: code,
		edgeRefusal: false,
	});
	const answers: readonly [string, CommCareApiError][] = [
		...[401, 429, 503, 302, 403].flatMap(
			(code): [string, CommCareApiError][] => [
				[`HQ's ${code}`, hq(code)],
				[`the edge's ${code}`, edge(code)],
			],
		),
		["no answer", { success: false, status: 503, cause: "network" }],
		["the deadline", { success: false, status: 503, cause: "timeout" }],
		[
			"a body over the bound",
			{ success: false, status: 502, cause: "too-large" },
		],
		[
			"a page for a browser",
			{ success: false, status: 502, cause: "browser-page" },
		],
		[
			"an unreadable answer",
			{ success: false, status: 502, cause: "malformed" },
		],
		[
			"a cursor that never ends",
			{ success: false, status: 508, cause: "malformed" },
		],
	];

	it.each(answers)("prints for %s what it printed before", (_name, error) => {
		const failure = classifyHqFailure(error, "app-list");
		expect(settingsFailureMessage(failure, VERIFY)).toBe(
			printedBefore(error, "verify"),
		);
		expect(settingsFailureMessage(failure, REFRESH)).toBe(
			printedBefore(error, "refresh"),
		);
	});
});
