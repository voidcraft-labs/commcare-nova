import { randomBytes } from "node:crypto";
import type { Browser, BrowserContextOptions } from "@playwright/test";

/** Model the local load balancer's two-hop forwarding contract. Each context
 * owns a distinct /64, which is Better Auth's IPv6 rate-limit boundary.
 * Production URL probes never send synthetic forwarding headers. */
export function smokeNetworkHeaders(
	baseURL: string | undefined,
): Record<string, string> {
	if (
		process.env.SMOKE_MANAGE_SERVER !== "1" ||
		process.env.SMOKE_LANE === "browser" ||
		!baseURL ||
		!["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseURL).hostname)
	)
		return {};
	const identity = randomBytes(6);
	const prefix = [0, 2, 4]
		.map((offset) => identity.readUInt16BE(offset).toString(16))
		.join(":");
	return { "x-forwarded-for": `fd00:${prefix}::1, 127.0.0.1` };
}

/** Explicit collaborator contexts use the same network ownership as fixtures. */
export function createSmokeContext(
	browser: Browser,
	options: BrowserContextOptions & { baseURL: string | undefined },
) {
	return browser.newContext({
		...options,
		extraHTTPHeaders: {
			...options.extraHTTPHeaders,
			...smokeNetworkHeaders(options.baseURL),
		},
	});
}
