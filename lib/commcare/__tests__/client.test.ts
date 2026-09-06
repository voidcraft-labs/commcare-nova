import { expect, it } from "vitest";
import { withHttpPeer } from "@/__tests__/helpers/httpPeer";
import { isValidDomainSlug, testDomainAccess } from "../client";

it("accepts HQ's legacy spelling only when it remains one exact URL path segment", async () => {
	const valid = [
		"myproject",
		"my-project",
		"my.project",
		"my:project",
		"my_project",
		"12345",
		"org.project_v2:staging",
		"a",
		"...",
	];
	await withHttpPeer(async (peer) => {
		for (const domain of valid) {
			expect(isValidDomainSlug(domain), domain).toBe(true);
			peer
				.get("https://india.commcarehq.org")
				.intercept({
					path: `/a/${domain}/apps/api/list_apps/`,
					method: "GET",
					headers: { authorization: "ApiKey account:key" },
				})
				.reply(200, { status: "success", applications: [] });
			expect(
				await testDomainAccess(
					{ username: "account", apiKey: "key", server: "india" },
					domain,
				),
			).toBe(true);
		}
		expect(
			peer
				.getCallHistory()
				?.calls()
				.map((call) => new URL(call.fullUrl).pathname),
		).toEqual(valid.map((domain) => `/a/${domain}/apps/api/list_apps/`));
	});
});

it("rejects dot segments and URL syntax before an authenticated request", async () => {
	const invalid = [
		".",
		"..",
		"",
		"../etc/passwd",
		"domain/../../secret",
		"domain%2F..",
		"my project",
		"domain\n",
		"domain\0",
		"<script>",
		"domain?admin=true",
		"domain#fragment",
		"domain\\secret",
	];
	await withHttpPeer(async (peer) => {
		for (const domain of invalid) {
			expect(isValidDomainSlug(domain), JSON.stringify(domain)).toBe(false);
			expect(
				await testDomainAccess(
					{ username: "account", apiKey: "key", server: "india" },
					domain,
				),
			).toBe(false);
		}
		expect(peer.getCallHistory()?.calls()).toEqual([]);
	});
});
