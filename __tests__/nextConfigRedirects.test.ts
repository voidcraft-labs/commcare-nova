import {
	getRedirectUrl,
	unstable_getResponseFromNextConfig,
} from "next/experimental/testing/server";
import { describe, expect, it } from "vitest";
import { docsRedirects } from "@/config/docsRedirects";

const nextConfig = { redirects: docsRedirects };

async function redirectFor(url: string) {
	return unstable_getResponseFromNextConfig({ url, nextConfig });
}

describe("next.config redirects", () => {
	it("permanently moves the retired docs URL and preserves its query", async () => {
		const response = await redirectFor(
			"https://docs.commcare.app/feature-flags?from=bookmark",
		);

		expect(response.status).toBe(308);
		expect(getRedirectUrl(response)).toBe(
			"https://docs.commcare.app/project-space-compatibility?from=bookmark",
		);
	});

	it.each([
		"https://commcare.app/feature-flags",
		"https://mcp.commcare.app/feature-flags",
		"https://docsXcommcareYapp/feature-flags",
		"https://docs.commcare.app/docs/feature-flags",
	])("does not widen the redirect to %s", async (url) => {
		const response = await redirectFor(url);

		expect(response.status).toBe(200);
		expect(getRedirectUrl(response)).toBeNull();
	});
});
