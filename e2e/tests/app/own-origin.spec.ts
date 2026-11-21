import { randomUUID } from "node:crypto";
import { CROSS_ORIGIN_REFUSAL } from "@/lib/auth-public";
import { expect, test } from "../../lib/appFixtures";
import { smokeNetworkHeaders } from "../../lib/smokeNetwork";

/**
 * The cookie boundary of every route handler (`auth-utils.ts::getSessionSafe`)
 * takes a request that can change something only from Nova's own pages. A
 * signed-in member's cookie rides each request here, as a page on another
 * host of the same site, or on another site, could send it: such a request is
 * answered 403 with the sentence before the cookie is read, whatever it asks
 * for, while a read, a request from Nova's own page and a client that is no
 * browser go on to the route as before. The app's own pages making every
 * request they make is held by the journeys that publish, bring in, review
 * changes and edit.
 */

/** A body the changes review refuses as unreadable, once it has read the session. */
const UNREADABLE = {};

test("a request that can change something, sent from another site, is refused with the sentence before the session is read", {
	tag: "@seed:auth",
}, async ({ playwright, scenario, baseURL }) => {
	if (baseURL === undefined) throw new Error("The smoke lane names its server");
	const member = await playwright.request.newContext({
		baseURL,
		storageState: scenario.common.storageState,
		extraHTTPHeaders: smokeNetworkHeaders(baseURL),
	});
	try {
		const review = (headers: Record<string, string>) =>
			member.post("/api/commcare/changes/review", {
				data: UNREADABLE,
				headers,
			});
		const elsewhere: readonly Record<string, string>[] = [
			{ "Sec-Fetch-Site": "cross-site" },
			/* Another host of the same site holds the cookie too. */
			{ "Sec-Fetch-Site": "same-site" },
			/* A browser that names no fetch site names where it came from. */
			{ Origin: "https://elsewhere.example" },
		];
		for (const headers of elsewhere) {
			const refused = await review(headers);
			expect(refused.status(), JSON.stringify(headers)).toBe(403);
			expect(await refused.json()).toEqual({ error: CROSS_ORIGIN_REFUSAL });
		}

		/* An autosave of any app is refused the same way, before anything
		 * about the app is read. */
		const save = await member.put(`/api/apps/${randomUUID()}`, {
			data: UNREADABLE,
			headers: { "Sec-Fetch-Site": "cross-site" },
		});
		expect(save.status()).toBe(403);
		expect(await save.json()).toEqual({ error: CROSS_ORIGIN_REFUSAL });

		/* A request from Nova's own page, one whose Origin is the server's own,
		 * and a client that is no browser reach the route, which reads the
		 * session and then refuses the body. */
		const own: readonly Record<string, string>[] = [
			{ "Sec-Fetch-Site": "same-origin" },
			{ Origin: new URL(baseURL).origin },
			{},
		];
		for (const headers of own) {
			const answered = await review(headers);
			expect(answered.status(), JSON.stringify(headers)).toBe(400);
		}

		/* A read from another site changes nothing, and is answered. */
		const read = await member.get("/api/commcare/connection", {
			headers: { "Sec-Fetch-Site": "cross-site" },
		});
		expect(read.status()).toBe(200);
	} finally {
		await member.dispose();
	}
});
