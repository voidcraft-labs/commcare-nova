import { expect, test } from "../../lib/appFixtures";
import { smokeNetworkHeaders } from "../../lib/smokeNetwork";

test("one local client exhausting its auth rate limit leaves another client's session available", {
	tag: "@seed:auth",
}, async ({ request, playwright, scenario, baseURL }) => {
	const other = await playwright.request.newContext({
		baseURL,
		storageState: scenario.common.storageState,
		extraHTTPHeaders: smokeNetworkHeaders(baseURL),
	});
	try {
		// The production limiter remains active. This caller reaches its actual
		// budget while a separate network identity keeps its own allowance.
		const statuses: number[] = [];
		for (let batch = 0; batch < 10; batch++) {
			statuses.push(
				...(await Promise.all(
					Array.from({ length: 10 }, async () =>
						(await request.get("/api/auth/get-session")).status(),
					),
				)),
			);
		}
		expect(statuses).toEqual(Array(100).fill(200));
		expect((await request.get("/api/auth/get-session")).status()).toBe(429);
		const unaffected = await other.get("/api/auth/get-session");
		expect(unaffected.status()).toBe(200);
		expect((await unaffected.json()).user.id).toBe(scenario.common.userId);
	} finally {
		await other.dispose();
	}
});
