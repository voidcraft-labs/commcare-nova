/** Pure: which reached deployment a download is made for, and each refusal's copy. */
import { describe, expect, it } from "vitest";
import { targetFactsFromSource } from "@/lib/commcare/targetFacts";
import {
	cczUnavailableLine,
	cczUnavailableRefusal,
	chooseDownloadTarget,
	downloadRefusalLines,
	type ReachedDeploymentTarget,
	workersSentElsewhere,
} from "../runtimeTarget";

const US_ACME: ReachedDeploymentTarget = {
	server: "production",
	domain: "acme",
	hqAppId: "0123456789abcdef0123456789abcdef",
	emptyCaseListText: false,
	earlierHqApps: 0,
	adopted: false,
};
const INDIA_ACME: ReachedDeploymentTarget = {
	server: "india",
	domain: "acme",
	hqAppId: "11111111111111111111111111111111",
	emptyCaseListText: false,
	earlierHqApps: 0,
	adopted: false,
};
const INDIA_FIELD: ReachedDeploymentTarget = {
	server: "india",
	domain: "field-ops",
	hqAppId: "22222222222222222222222222222222",
	emptyCaseListText: false,
	earlierHqApps: 0,
	adopted: false,
};
const REACHED = [US_ACME, INDIA_ACME, INDIA_FIELD];

const NEEDS_PUBLISHED =
	"A CCZ signs workers in to one project space and sends their forms there, so it is made for a project space this app is published to. Once the app is published, you can download the CCZ for that space.";
const PICK =
	"A CCZ signs workers in to one project space and sends their forms there. This app is published to several, so you can pick the one this CCZ is for.";
const HELD =
	"A CCZ signs workers in to one project space and sends their forms there, so it is made for a project space this app is published to. This app can't be published to CommCare HQ as it is, so it has no CCZ yet.";
const NOT_FOR_IMPORT_FILE =
	"The CommCare HQ import file works in any project space, so it isn't made for one. You can download it again without a project space.";
const WEB_APPS_ONLY =
	"A CCZ installs this app on Android phones, and this app runs in Web Apps only, so it has no CCZ. If its workers use phones too, you can set it to run on Android as well, in App settings.";
const unknown = (named: string) =>
	`This app isn't published to ${named}, so there's no CCZ for it there. You can pick one of the project spaces it's published to.`;
const EVERY_SPACE = ["acme on US", "acme on India", "field-ops on India"];

describe("chooseDownloadTarget for a CCZ", () => {
	it("refuses a CCZ of an app that does not declare Android before any project space, listing nothing", () => {
		for (const reached of [[], [US_ACME], REACHED]) {
			for (const input of [
				{},
				{ domain: "acme", server: "india" as const },
				{ heldFromHq: ["a line"] },
			]) {
				const choice = chooseDownloadTarget(reached, {
					format: "ccz",
					declaresAndroid: false,
					...input,
				});
				expect(choice).toEqual({
					kind: "refused",
					reason: "not-declared-for-android",
					message: WEB_APPS_ONLY,
					reached,
					heldFromHq: [],
				});
				if (choice.kind === "refused")
					expect(downloadRefusalLines(choice)).toEqual([]);
			}
		}
	});

	it("refuses an app published nowhere, whatever it names", () => {
		for (const input of [
			{},
			{ server: "india" as const },
			{ domain: "acme" },
			{ heldFromHq: [] },
		]) {
			const choice = chooseDownloadTarget([], {
				format: "ccz",
				declaresAndroid: true,
				...input,
			});
			expect(choice).toEqual({
				kind: "refused",
				reason: "needs-published-project-space",
				message: NEEDS_PUBLISHED,
				reached: [],
				heldFromHq: [],
			});
			if (choice.kind === "refused")
				expect(downloadRefusalLines(choice)).toEqual([]);
		}
	});

	it("says why an app holding a selection CommCare HQ cannot take has no CCZ", () => {
		const held = ['"Child care" reads several parents.'];
		const choice = chooseDownloadTarget([], {
			format: "ccz",
			declaresAndroid: true,
			domain: "acme",
			heldFromHq: held,
		});
		expect(choice).toEqual({
			kind: "refused",
			reason: "selection-held-from-hq",
			message: HELD,
			reached: [],
			heldFromHq: held,
		});
		if (choice.kind === "refused")
			expect(downloadRefusalLines(choice)).toEqual(held);
	});

	it("takes a reached deployment whatever the held lines say", () => {
		expect(
			chooseDownloadTarget([US_ACME], {
				format: "ccz",
				declaresAndroid: true,
				heldFromHq: ["a line"],
			}),
		).toEqual({ kind: "project-space", target: US_ACME });
	});

	it("takes the only deployment there is, or the one the inputs name", () => {
		expect(
			chooseDownloadTarget([INDIA_FIELD], {
				format: "ccz",
				declaresAndroid: true,
			}),
		).toEqual({
			kind: "project-space",
			target: INDIA_FIELD,
		});
		expect(
			chooseDownloadTarget(REACHED, {
				format: "ccz",
				declaresAndroid: true,
				domain: "field-ops",
			}),
		).toEqual({ kind: "project-space", target: INDIA_FIELD });
		expect(
			chooseDownloadTarget(REACHED, {
				format: "ccz",
				declaresAndroid: true,
				domain: "acme",
				server: "india",
			}),
		).toEqual({ kind: "project-space", target: INDIA_ACME });
		expect(
			chooseDownloadTarget(REACHED, {
				format: "ccz",
				declaresAndroid: true,
				server: "production",
			}),
		).toEqual({ kind: "project-space", target: US_ACME });
	});

	it("asks for a pick where the inputs leave several", () => {
		for (const input of [
			{},
			{ domain: "acme" },
			{ server: "india" as const },
		]) {
			const choice = chooseDownloadTarget(REACHED, {
				format: "ccz",
				declaresAndroid: true,
				...input,
			});
			expect(choice).toEqual({
				kind: "refused",
				reason: "pick-project-space",
				message: PICK,
				reached: REACHED,
				heldFromHq: [],
			});
			if (choice.kind === "refused")
				expect(downloadRefusalLines(choice)).toEqual(EVERY_SPACE);
		}
	});

	it("refuses a project space the app is not published to, listing the ones it is", () => {
		for (const [input, named] of [
			[{ domain: "nowhere", server: "india" }, '"nowhere" on India'],
			[{ domain: "field-ops", server: "eu" }, '"field-ops" on EU'],
			[{ domain: "nowhere" }, '"nowhere"'],
			[{ server: "eu" }, "a project space on EU"],
		] as const) {
			const choice = chooseDownloadTarget(REACHED, {
				format: "ccz",
				declaresAndroid: true,
				...input,
			});
			expect(choice).toEqual({
				kind: "refused",
				reason: "unknown-project-space",
				message: unknown(named),
				reached: REACHED,
				heldFromHq: [],
			});
			if (choice.kind === "refused")
				expect(downloadRefusalLines(choice)).toEqual(EVERY_SPACE);
		}
	});
});

describe("chooseDownloadTarget for the import file", () => {
	it("refuses a project space, listing nothing", () => {
		for (const reached of [[], REACHED]) {
			const choice = chooseDownloadTarget(reached, {
				format: "json",
				declaresAndroid: true,
				domain: "acme",
			});
			expect(choice).toMatchObject({
				kind: "refused",
				reason: "domain-not-for-import-file",
				message: NOT_FOR_IMPORT_FILE,
				heldFromHq: [],
			});
			if (choice.kind === "refused")
				expect(downloadRefusalLines(choice)).toEqual([]);
		}
	});

	it("scopes its links to the one deployment the server leaves, and else to none", () => {
		expect(
			chooseDownloadTarget([], { format: "json", declaresAndroid: true }),
		).toEqual({
			kind: "none",
		});
		expect(
			chooseDownloadTarget([US_ACME], {
				format: "json",
				declaresAndroid: true,
			}),
		).toEqual({
			kind: "project-space",
			target: US_ACME,
		});
		expect(
			chooseDownloadTarget(REACHED, { format: "json", declaresAndroid: true }),
		).toEqual({
			kind: "none",
		});
		expect(
			chooseDownloadTarget(REACHED, {
				format: "json",
				declaresAndroid: true,
				server: "production",
			}),
		).toEqual({ kind: "project-space", target: US_ACME });
		expect(
			chooseDownloadTarget(REACHED, {
				format: "json",
				declaresAndroid: true,
				server: "india",
			}),
		).toEqual({ kind: "none" });
		expect(
			chooseDownloadTarget(REACHED, {
				format: "json",
				declaresAndroid: true,
				server: "eu",
			}),
		).toEqual({ kind: "none" });
	});

	it("is never refused for want of a deployment, for a held selection, or for an app without Android", () => {
		expect(
			chooseDownloadTarget([], {
				format: "json",
				declaresAndroid: true,
				heldFromHq: ["a line"],
			}),
		).toEqual({ kind: "none" });
		expect(
			chooseDownloadTarget([US_ACME], {
				format: "json",
				declaresAndroid: false,
			}),
		).toEqual({ kind: "project-space", target: US_ACME });
	});
});

/** A stored `custom_base_url` as `targetFactsFromSource` reads it. */
function heldBase(stored: unknown) {
	return (
		targetFactsFromSource(
			{ custom_base_url: stored },
			{
				observedAt: "2026-11-01T00:00:00.000Z",
				novaOwnsAutoGpsCapture: false,
				adopted: false,
			},
		)?.customBaseUrl ?? null
	);
}

describe("workersSentElsewhere", () => {
	/* A custom base URL sends a phone's sign-in, sync and forms to its
	 * address in HQ's own build, and a CCZ names only the server the app is
	 * published on: a project space holding one elsewhere gets no CCZ. */
	it("gives a project space whose app sends its phones to another address no CCZ, naming the host and never the user information", () => {
		for (const stored of [
			"https://example.org/hq/",
			"http://x",
			"https://u:p@www.commcarehq.org",
			"https://relay:s3cret@proxy.example.org/hq/",
			"https://www.commcarehq.org:8443/",
			"http://www.commcarehq.org/",
		]) {
			const unavailable = workersSentElsewhere(US_ACME, heldBase(stored));
			expect(unavailable, stored).toMatchObject({
				reason: "workers-sent-elsewhere",
			});
			if (unavailable === null) continue;
			const refusal = cczUnavailableRefusal(US_ACME, unavailable, REACHED);
			expect(refusal, stored).toMatchObject({
				kind: "refused",
				reason: "workers-sent-elsewhere",
				reached: REACHED,
				heldFromHq: [],
			});
			for (const text of [refusal.message, cczUnavailableLine(unavailable)]) {
				expect(text).not.toContain("s3cret");
				expect(text).not.toContain("u:p");
			}
			expect(downloadRefusalLines(refusal)).toEqual([]);
		}
		const relayed = workersSentElsewhere(
			US_ACME,
			heldBase("https://relay:s3cret@proxy.example.org/hq/"),
		);
		expect(relayed).toEqual({
			reason: "workers-sent-elsewhere",
			host: "proxy.example.org",
		});
		if (relayed === null) throw new Error("Expected no CCZ");
		expect(cczUnavailableRefusal(US_ACME, relayed, REACHED).message).toBe(
			"In CommCare HQ, this project space's app has a custom base URL, so phones that install it sign in and send forms at proxy.example.org. " +
				'A CCZ from Nova signs workers in on the US server, where this app is published, so there isn\'t one for "acme" while that setting is there. ' +
				"Workers can install the app from CommCare HQ. If the project space moved to another CommCare server, you can publish there and download its CCZ.",
		);
		expect(cczUnavailableLine(relayed)).toBe(
			"Its app in CommCare HQ has a custom base URL that sends phones to proxy.example.org, so Nova doesn't make a CCZ for this project space. Workers can install the app from CommCare HQ.",
		);
	});

	it("gives a CCZ to a project space that keeps no base or the server's own", () => {
		expect(workersSentElsewhere(US_ACME, null)).toBeNull();
		for (const stored of [
			"https://www.commcarehq.org",
			"https://www.commcarehq.org/a/acme/",
			"HTTPS://WWW.CommCareHQ.org:443/",
		])
			expect(
				workersSentElsewhere(US_ACME, heldBase(stored)),
				stored,
			).toBeNull();
		/* Another server's own address is elsewhere for this one. */
		expect(
			workersSentElsewhere(INDIA_ACME, heldBase("https://www.commcarehq.org")),
		).toMatchObject({ reason: "workers-sent-elsewhere" });
		expect(
			workersSentElsewhere(
				INDIA_ACME,
				heldBase("https://india.commcarehq.org/hq/"),
			),
		).toBeNull();
	});
});
