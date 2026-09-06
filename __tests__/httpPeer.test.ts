import { expect, it } from "vitest";
import { withHttpPeer } from "./helpers/httpPeer";

it("intercepts Node's native fetch and refuses unmatched destinations at the mock transport", async () => {
	await withHttpPeer(async (peer) => {
		peer
			.get("https://intercepted.invalid")
			.intercept({ path: "/read", method: "GET" })
			.reply(200, "controlled response");
		const response = await fetch("https://intercepted.invalid/read");
		expect(await response.text()).toBe("controlled response");
		await expect(fetch("https://unmatched.invalid/read")).rejects.toMatchObject(
			{ cause: { code: "UND_MOCK_ERR_MOCK_NOT_MATCHED" } },
		);
		expect(
			peer
				.getCallHistory()
				?.calls()
				.map((call) => call.fullUrl),
		).toEqual([
			"https://intercepted.invalid/read",
			"https://unmatched.invalid/read",
		]);
	});
});
