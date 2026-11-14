/** The one classification of a failed CommCare HQ answer, and the circumstance each is for a read. */
import { describe, expect, it } from "vitest";
import { withHttpPeer } from "@/__tests__/helpers/httpPeer";
import {
	type RetainedHqAnswer,
	replyRetained,
	retainedPublishRead,
	retainedReadingRead,
} from "@/__tests__/helpers/retainedHqReads";
import { CIRCUMSTANCE_COPY } from "@/lib/publish/hqFindingCopy";
import {
	READ_CIRCUMSTANCES,
	type ReadCircumstance,
} from "@/lib/publish/hqFindings";
import {
	classifyHqFailure,
	HQ_FAILURE_KINDS,
	HQ_REQUEST_KINDS,
	type HqFailure,
	type HqFailureKind,
	type HqPermissionNeed,
	type HqRequestKind,
	hqReadCircumstance,
} from "../hq/failure";
import {
	type CommCareApiError,
	HQ_API_ACCESS_REFUSAL,
	HQ_API_CUT_OFF_REFUSAL,
} from "../hq/http";
import { readHqJson } from "../hq/readJson";

const NEEDS: readonly HqPermissionNeed[] = [
	"edit-apps",
	"access-apis",
	"edit-apps-and-access-apis",
	"locations",
];

const error = (
	status: number,
	rest: Omit<CommCareApiError, "success" | "status"> = {},
): CommCareApiError => ({ success: false, status, ...rest });
const refusal = (sentence: string) =>
	error(401, {
		edgeRefusal: false,
		refusedBody: JSON.stringify({ error: sentence }),
	});

/** Every failure `hqReadCircumstance` can be handed: every kind, request and permission. */
function everyFailure(): HqFailure[] {
	return HQ_REQUEST_KINDS.flatMap((request) =>
		HQ_FAILURE_KINDS.flatMap((kind): HqFailure[] =>
			kind === "permission"
				? NEEDS.map((permission) => ({
						kind,
						request,
						status: 403,
						permission,
					}))
				: [{ kind, request, status: 0 }],
		),
	);
}

describe("classifyHqFailure, first match", () => {
	const rows: readonly [string, CommCareApiError, HqFailureKind][] = [
		[
			"an edge's refusal, whatever its status",
			error(401, { edgeRefusal: true }),
			"gateway-refused",
		],
		["an edge's 504", error(504, { edgeRefusal: true }), "gateway-refused"],
		["the deadline", error(503, { cause: "timeout" }), "timed-out"],
		["no answer", error(503, { cause: "network" }), "hq-unavailable"],
		["a body over the bound", error(502, { cause: "too-large" }), "too-large"],
		[
			"a page for a browser",
			error(502, { cause: "browser-page" }),
			"browser-only",
		],
		["a redirect", error(302, { edgeRefusal: false }), "browser-only"],
		["a 399", error(399), "browser-only"],
		[
			"an answer Nova cannot read",
			error(502, { cause: "malformed" }),
			"answer-unreadable",
		],
		[
			"a cursor that never ends",
			error(508, { cause: "malformed" }),
			"answer-unreadable",
		],
		[
			"the plan sentence",
			refusal(HQ_API_ACCESS_REFUSAL),
			"plan-lacks-api-access",
		],
		["the cut-off sentence", refusal(HQ_API_CUT_OFF_REFUSAL), "api-cut-off"],
		[
			"a 401 with no body kept",
			error(401, { edgeRefusal: false }),
			"key-not-accepted",
		],
		[
			"a 401 with another sentence",
			refusal("Unauthorized"),
			"key-not-accepted",
		],
		[
			"a 401 whose body is not JSON",
			error(401, { refusedBody: "nope" }),
			"key-not-accepted",
		],
		["a 404", error(404, { edgeRefusal: false }), "not-found"],
		["a 429", error(429, { edgeRefusal: false }), "rate-limited"],
		["a 500", error(500, { edgeRefusal: false }), "hq-unavailable"],
		["a 503 HQ answered", error(503, { edgeRefusal: false }), "hq-unavailable"],
		["a 400", error(400, { edgeRefusal: false }), "refused"],
		["a 409", error(409), "refused"],
	];

	it.each(rows)("%s", (_name, answer, kind) => {
		expect(classifyHqFailure(answer, "application")).toEqual({
			kind,
			request: "application",
			status: answer.status,
		});
	});

	it("reads the plan sentence as the plan for a member, and as lost membership where the list refused the key", () => {
		/* A project space that is gone answers the same sentence: its default
		 * plan has no API access, and the plan is checked before the caller. */
		const answer = refusal(HQ_API_ACCESS_REFUSAL);
		expect(
			classifyHqFailure(answer, "application", { member: true }).kind,
		).toBe("plan-lacks-api-access");
		expect(
			classifyHqFailure(answer, "application", { member: false }).kind,
		).toBe("not-a-member");
	});

	it("holds an edge's plan sentence to the edge, never the plan", () => {
		expect(
			classifyHqFailure(
				{ ...refusal(HQ_API_ACCESS_REFUSAL), edgeRefusal: true },
				"application",
			).kind,
		).toBe("gateway-refused");
	});

	const forbidden: Readonly<
		Record<HqRequestKind, readonly [onNonMember: string, onMember: string]>
	> = {
		"project-spaces": ["refused", "refused"],
		"app-list": ["not-a-member", "not-a-member"],
		"app-version": ["not-a-member", "not-a-member"],
		"app-source": ["not-a-member", "permission:edit-apps"],
		"app-import": ["not-a-member", "permission:edit-apps"],
		"api-access": ["not-a-member", "permission:access-apis"],
		application: ["not-a-member", "permission:access-apis"],
		"lookup-tables": ["not-a-member", "permission:access-apis"],
		"lookup-rows": ["not-a-member", "permission:edit-apps-and-access-apis"],
		"location-types": ["not-a-member", "permission:locations"],
		locations: ["not-a-member", "permission:locations"],
		"media-file": ["refused", "refused"],
	};
	const said = (failure: HqFailure) =>
		failure.kind === "permission"
			? `permission:${failure.permission}`
			: failure.kind;

	it.each(HQ_REQUEST_KINDS)(
		"reads a 403 on %s by what was asked",
		(request) => {
			const answer = error(403, { edgeRefusal: false });
			const [onNonMember, onMember] = forbidden[request];
			expect(said(classifyHqFailure(answer, request, { member: false }))).toBe(
				onNonMember,
			);
			expect(said(classifyHqFailure(answer, request, { member: true }))).toBe(
				onMember,
			);
			expect(said(classifyHqFailure(answer, request))).toBe(onMember);
		},
	);

	it("reaches every kind from some answer, and names a permission only on a permission", () => {
		const reached = new Set<HqFailureKind>();
		for (const request of HQ_REQUEST_KINDS)
			for (const member of [true, false])
				for (const [, answer] of rows) {
					const failure = classifyHqFailure(answer, request, { member });
					reached.add(failure.kind);
					expect(failure.permission !== undefined).toBe(
						failure.kind === "permission",
					);
				}
		for (const request of HQ_REQUEST_KINDS)
			for (const member of [true, false])
				reached.add(classifyHqFailure(error(403), request, { member }).kind);
		expect([...reached].sort()).toEqual([...HQ_FAILURE_KINDS].sort());
	});
});

describe("hqReadCircumstance", () => {
	it("is total over every kind, request and permission, and every answer is a circumstance", () => {
		for (const failure of everyFailure())
			expect(READ_CIRCUMSTANCES, JSON.stringify(failure)).toContain(
				hqReadCircumstance(failure),
			);
	});

	it("returns exactly the thirteen codes a failed read can be", () => {
		expect([...new Set(everyFailure().map(hqReadCircumstance))].sort()).toEqual(
			[
				"hq-gateway-refused",
				"key-not-accepted",
				"plan-lacks-api-access",
				"api-cut-off",
				"not-a-member",
				"cannot-edit-apps",
				"cannot-access-apis",
				"cannot-read-organization",
				"app-gone",
				"rate-limited",
				"hq-unavailable",
				"too-large",
				"browser-only",
			].sort(),
		);
	});

	it("words a 404 as a missing app only where the app was asked for", () => {
		for (const request of HQ_REQUEST_KINDS)
			expect(
				hqReadCircumstance({ kind: "not-found", request, status: 404 }),
				request,
			).toBe(
				["application", "app-source", "app-version"].includes(request)
					? "app-gone"
					: "hq-unavailable",
			);
	});

	it("words a body over the bound as the app's size only for the app's own bodies", () => {
		for (const request of HQ_REQUEST_KINDS)
			expect(
				hqReadCircumstance({ kind: "too-large", request, status: 502 }),
				request,
			).toBe(
				["application", "app-source"].includes(request)
					? "too-large"
					: "hq-unavailable",
			);
	});

	it.each([
		["gateway-refused", "lookup-rows", undefined, "hq-gateway-refused"],
		["key-not-accepted", "app-list", undefined, "key-not-accepted"],
		["plan-lacks-api-access", "api-access", undefined, "plan-lacks-api-access"],
		["api-cut-off", "lookup-tables", undefined, "api-cut-off"],
		["not-a-member", "locations", undefined, "not-a-member"],
		["permission", "app-source", "edit-apps", "cannot-edit-apps"],
		["permission", "app-import", "edit-apps", "cannot-edit-apps"],
		["permission", "api-access", "access-apis", "cannot-access-apis"],
		["permission", "application", "access-apis", "cannot-access-apis"],
		["permission", "lookup-tables", "access-apis", "cannot-access-apis"],
		[
			"permission",
			"lookup-rows",
			"edit-apps-and-access-apis",
			"cannot-edit-apps",
		],
		["permission", "location-types", "locations", "cannot-read-organization"],
		["permission", "locations", "locations", "cannot-read-organization"],
		["rate-limited", "lookup-rows", undefined, "rate-limited"],
		["hq-unavailable", "application", undefined, "hq-unavailable"],
		["timed-out", "application", undefined, "hq-unavailable"],
		["browser-only", "app-list", undefined, "browser-only"],
		["answer-unreadable", "application", undefined, "hq-unavailable"],
		["refused", "media-file", undefined, "hq-unavailable"],
	] as const)("%s on %s (%s) is %s", (kind, request, permission, code) => {
		const failure = (
			kind === "permission"
				? { kind, request, status: 403, permission }
				: { kind, request, status: 0 }
		) as HqFailure;
		expect(hqReadCircumstance(failure)).toBe(code);
	});
});

describe("the picker's codes", () => {
	it("name no app, since none has been chosen", () => {
		const codes = new Set<ReadCircumstance>([
			"not-connected",
			"key-cannot-reach-space",
		]);
		for (const request of ["app-list", "api-access"] as const)
			for (const kind of HQ_FAILURE_KINDS) {
				if (kind !== "permission") {
					codes.add(hqReadCircumstance({ kind, request, status: 0 }));
					continue;
				}
				/* The permission a 403 on this request can name. */
				const failure = classifyHqFailure(
					{ success: false, status: 403, edgeRefusal: false },
					request,
					{ member: true },
				);
				if (failure.kind === "permission")
					codes.add(hqReadCircumstance(failure));
			}
		for (const code of codes) {
			const copy = CIRCUMSTANCE_COPY[code];
			for (const template of [copy.title, copy.body, copy.next])
				expect(template, code).not.toContain("{app}");
		}
	});
});

describe("CommCare HQ's retained answers", () => {
	const HOST = "https://india.commcarehq.org";
	const PATH = "/a/clinic/api/application/v1/working-app/";
	const CREDS = {
		username: "account",
		apiKey: "key",
		server: "india",
	} as const;

	/** The failure the production reader returns for the answer, classified. */
	async function classified(
		answer: RetainedHqAnswer,
		request: HqRequestKind,
		member?: boolean,
	): Promise<HqFailure> {
		return withHttpPeer(async (peer) => {
			replyRetained(
				peer.get(HOST).intercept({ path: PATH, method: "GET" }),
				answer,
			);
			const result = await readHqJson(CREDS, HOST + PATH, "application", {
				keepRefusedBody: true,
			});
			if (!("success" in result)) throw new Error("HQ's answer was read");
			return classifyHqFailure(
				result,
				request,
				member === undefined ? {} : { member },
			);
		});
	}

	it.each([
		["application-no-api-access", "application", "plan-lacks-api-access"],
		[
			"application-no-api-access-superuser",
			"application",
			"plan-lacks-api-access",
		],
		["api-access-no-plan", "api-access", "plan-lacks-api-access"],
		["application-api-cut-off", "application", "api-cut-off"],
	] as const)("%s is %s", async (name, request, kind) => {
		expect((await classified(retainedReadingRead(name), request)).kind).toBe(
			kind,
		);
	});

	it("application-no-permission from a member is Access APIs", async () => {
		expect(
			await classified(
				retainedReadingRead("application-no-permission"),
				"application",
				true,
			),
		).toEqual({
			kind: "permission",
			request: "application",
			status: 403,
			permission: "access-apis",
		});
	});

	it("publish/source-missing is not found", async () => {
		expect(
			(await classified(retainedPublishRead("source-missing"), "app-source"))
				.kind,
		).toBe("not-found");
	});
});
