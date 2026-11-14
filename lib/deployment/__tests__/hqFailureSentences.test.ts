/**
 * The sentences a publish prints for a failed answer of CommCare HQ: the
 * import's, the source read's and the table list's, each chosen by the
 * failure's kind.
 *
 * A sentence changed by choosing by kind, and the two deliberate changes (an
 * edge's 401 or 403 no longer sending a person to ask for a permission they
 * may hold) landing on an answer they were not meant for, are what these
 * cases would catch.
 */

import { describe, expect, it } from "vitest";
import {
	classifyHqFailure,
	HQ_FAILURE_KINDS,
	type HqFailure,
	type HqFailureKind,
} from "@/lib/commcare/hq/failure";
import {
	type CommCareApiError,
	HQ_API_ACCESS_REFUSAL,
	HQ_API_CUT_OFF_REFUSAL,
} from "@/lib/commcare/hq/http";
import {
	buildProfileLanguageFailure,
	hqAppSourceReadFailure,
	lookupTableListFailureDetail,
} from "../preflight";
import { importRejectionMessage } from "../service";

const DOMAIN = "clinic";

const GATEWAY =
	"A security gateway in front of CommCare HQ turned this upload away before CommCare HQ received it, so it doesn't reflect your permissions or anything in your app. Nova can't clear this one from here. Dimagi support (support@dimagi.com) can exclude the app import endpoint from the rule that matched.";
const KEY =
	"CommCare HQ didn't accept your API key. Update it in Settings, then publish again.";
const EDIT_APPS =
	"Your CommCare HQ account can't create apps in this project space. Ask an administrator there for the Edit Apps permission.";
const RATE =
	"CommCare HQ is rate limiting requests right now. Wait a moment and publish again.";
const UNAVAILABLE =
	"CommCare HQ is unavailable right now. Try publishing again in a few minutes.";
const refusedApp = (status: number) =>
	`CommCare HQ refused the app (HTTP ${status}).`;

function failureOf(kind: HqFailureKind, status: number): HqFailure {
	return kind === "permission"
		? { kind, request: "app-import", status, permission: "edit-apps" }
		: { kind, request: "app-import", status };
}

const error = (
	status: number,
	extra: Omit<Partial<CommCareApiError>, "success" | "status"> = {},
): CommCareApiError => ({ success: false, status, ...extra });
const hq = (status: number) => error(status, { edgeRefusal: false });
const edge = (status: number) => error(status, { edgeRefusal: true });
const refusedWith = (sentence: string) =>
	error(401, {
		edgeRefusal: false,
		refusedBody: JSON.stringify({ error: sentence }),
	});

describe("the import's sentence", () => {
	const byKind: Record<
		Exclude<HqFailureKind, "browser-only">,
		readonly [status: number, sentence: string]
	> = {
		"gateway-refused": [403, GATEWAY],
		"key-not-accepted": [401, KEY],
		"plan-lacks-api-access": [401, KEY],
		"api-cut-off": [401, KEY],
		permission: [403, EDIT_APPS],
		"not-a-member": [403, EDIT_APPS],
		"rate-limited": [429, RATE],
		"hq-unavailable": [503, UNAVAILABLE],
		"timed-out": [503, UNAVAILABLE],
		"too-large": [502, UNAVAILABLE],
		"answer-unreadable": [502, UNAVAILABLE],
		"not-found": [404, refusedApp(404)],
		refused: [400, refusedApp(400)],
	};

	it("covers every kind", () => {
		expect([...Object.keys(byKind), "browser-only"].sort()).toEqual(
			[...HQ_FAILURE_KINDS].sort(),
		);
	});

	it.each(Object.entries(byKind))("words %s", (kind, [status, sentence]) => {
		expect(
			importRejectionMessage(failureOf(kind as HqFailureKind, status)),
		).toBe(sentence);
	});

	it("words a page for a browser by its status", () => {
		expect(importRejectionMessage(failureOf("browser-only", 502))).toBe(
			UNAVAILABLE,
		);
		expect(importRejectionMessage(failureOf("browser-only", 302))).toBe(
			refusedApp(302),
		);
	});

	/** The sentence the import printed for an answer before it chose by kind. */
	function printedBefore(answer: CommCareApiError): string {
		if (answer.edgeRefusal) return GATEWAY;
		if (answer.status === 401) return KEY;
		if (answer.status === 403) return EDIT_APPS;
		if (answer.status === 429) return RATE;
		if (answer.status >= 500) return UNAVAILABLE;
		return refusedApp(answer.status);
	}

	const answers: readonly [string, CommCareApiError][] = [
		...[401, 403, 404, 400, 429, 500, 502, 503, 504, 302].flatMap(
			(status): [string, CommCareApiError][] => [
				[`HQ's ${status}`, hq(status)],
				[`the edge's ${status}`, edge(status)],
			],
		),
		["the plan refusal", refusedWith(HQ_API_ACCESS_REFUSAL)],
		["the cut-off", refusedWith(HQ_API_CUT_OFF_REFUSAL)],
		["no answer", error(503, { cause: "network" })],
		["the deadline", error(503, { cause: "timeout" })],
		["a body over the bound", error(502, { cause: "too-large" })],
		["a page for a browser", error(502, { cause: "browser-page" })],
		["an unreadable answer", error(502, { cause: "malformed" })],
	];

	it.each(answers)("prints for %s what it printed before", (_name, answer) => {
		expect(
			importRejectionMessage(classifyHqFailure(answer, "app-import")),
		).toBe(printedBefore(answer));
	});
});

describe("the source read's sentence", () => {
	const PERMISSION = `Nova couldn't read the current app on “${DOMAIN}”, so it left that app unchanged. Reading it needs permission to edit apps in CommCare HQ. Check the connected account, then publish again.`;
	const UNSAFE = `Nova couldn't safely read the current app on “${DOMAIN}”, so it left that app unchanged. Check that the app still opens in CommCare HQ, then publish again.`;

	const answers: readonly [HqFailureKind, CommCareApiError, string][] = [
		["gateway-refused", edge(403), UNSAFE],
		["key-not-accepted", hq(401), PERMISSION],
		["plan-lacks-api-access", refusedWith(HQ_API_ACCESS_REFUSAL), PERMISSION],
		["api-cut-off", refusedWith(HQ_API_CUT_OFF_REFUSAL), PERMISSION],
		["permission", hq(403), PERMISSION],
		["not-found", hq(404), UNSAFE],
		["rate-limited", hq(429), UNSAFE],
		["hq-unavailable", error(503, { cause: "network" }), UNSAFE],
		["timed-out", error(503, { cause: "timeout" }), UNSAFE],
		["too-large", error(502, { cause: "too-large" }), UNSAFE],
		["browser-only", error(502, { cause: "browser-page" }), UNSAFE],
		["answer-unreadable", error(502, { cause: "malformed" }), UNSAFE],
		["refused", hq(400), UNSAFE],
	];

	it.each(answers)("words %s", (kind, answer, sentence) => {
		expect(classifyHqFailure(answer, "app-source").kind).toBe(kind);
		expect(hqAppSourceReadFailure(answer, DOMAIN, false).message).toBe(
			sentence,
		);
	});

	it.each([401, 403])(
		"reads an edge's %s as a read Nova couldn't make safely, on a new app and an existing one",
		(status) => {
			expect(hqAppSourceReadFailure(edge(status), DOMAIN, false).message).toBe(
				UNSAFE,
			);
			expect(
				hqAppSourceReadFailure(edge(status), DOMAIN, true).message,
			).toContain("Nova couldn't safely read the app");
			expect(
				hqAppSourceReadFailure(hq(status), DOMAIN, true).message,
			).toContain("Reading it needs permission to edit apps");
		},
	);
});

describe("the table list's sentence", () => {
	const NEEDS = `Nova can't see which lookup tables “${DOMAIN}” already has, so it won't push over them. Reading them needs API access on that project space and the Access APIs permission on your CommCare HQ account; ask a CommCare HQ administrator for both.`;
	const COULD_NOT_ASK = `Nova couldn't ask “${DOMAIN}” which lookup tables it already has, so it stopped rather than push over them. Try publishing again in a moment.`;
	const ACCOUNT: ReadonlySet<HqFailureKind> = new Set([
		"key-not-accepted",
		"plan-lacks-api-access",
		"api-cut-off",
		"not-a-member",
		"permission",
	]);

	it.each(HQ_FAILURE_KINDS)("words %s", (kind) => {
		const failure: HqFailure =
			kind === "permission"
				? {
						kind,
						request: "lookup-tables",
						status: 403,
						permission: "access-apis",
					}
				: { kind, request: "lookup-tables", status: 401 };
		expect(lookupTableListFailureDetail(failure, DOMAIN)).toBe(
			ACCOUNT.has(kind) ? NEEDS : COULD_NOT_ASK,
		);
	});

	it.each([
		["HQ's 401", hq(401), NEEDS],
		["HQ's 403", hq(403), NEEDS],
		["the plan refusal", refusedWith(HQ_API_ACCESS_REFUSAL), NEEDS],
		["the edge's 401", edge(401), COULD_NOT_ASK],
		["the edge's 403", edge(403), COULD_NOT_ASK],
		[
			"a definition HQ served malformed",
			error(502, { cause: "malformed" }),
			COULD_NOT_ASK,
		],
	])("prints for %s its sentence", (_name, answer, sentence) => {
		expect(
			lookupTableListFailureDetail(
				classifyHqFailure(answer, "lookup-tables"),
				DOMAIN,
			),
		).toBe(sentence);
	});
});

describe("the build profile refusal", () => {
	const SEVERAL =
		"Application profiles of the app on “clinic” include languages this app no longer has, so Nova stopped before sending anything. Nova can't change application profiles in CommCare HQ. You can take those languages out of each profile listed below, or remove the profile, on the Application Profiles tab of the app's Releases page there, then publish again. Left as they are, CommCare HQ would build those profiles with languages that have no text of their own, or couldn't build them at all.";

	it("names each profile on a line, a nameless one included, and says when a profile is left with none of the app's languages", () => {
		expect(
			buildProfileLanguageFailure(
				DOMAIN,
				[
					{
						id: "north",
						name: "North",
						missing: ["fra", "hau"],
						emptied: false,
					},
					{ id: "one", name: "", missing: ["fra"], emptied: true },
					{
						id: "both",
						name: "Both",
						missing: ["fra", "cmn-hant"],
						emptied: true,
					},
				],
				false,
			),
		).toEqual({
			code: "hq_build_profile_language_missing",
			message: SEVERAL,
			details: [
				"“North”: French (fra), Hausa (hau)",
				"A profile with no name: French (fra), the only language it has",
				"“Both”: French (fra), cmn-hant, the only languages it has",
			],
		});
	});

	it("takes the several-language sentence for one profile missing two", () => {
		expect(
			buildProfileLanguageFailure(
				DOMAIN,
				[{ id: "n", name: "North", missing: ["fra", "hau"], emptied: false }],
				false,
			).message,
		).toBe(SEVERAL);
	});

	it("says what was sent where the second read found it", () => {
		expect(
			buildProfileLanguageFailure(
				DOMAIN,
				[{ id: "n", name: "North", missing: ["fra"], emptied: false }],
				true,
			).message,
		).toBe(
			"An application profile of the app on “clinic” includes a language this app no longer has, which Nova found after it published this app's lookup tables and places, so it stopped before sending the app's content. Nova can't change application profiles in CommCare HQ. You can take that language out of the profile, or remove the profile, on the Application Profiles tab of the app's Releases page there, then publish again. Left as it is, CommCare HQ would build the profile with a language that has no text of its own, or couldn't build it at all.",
		);
	});
});
