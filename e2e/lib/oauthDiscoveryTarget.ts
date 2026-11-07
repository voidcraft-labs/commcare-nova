/** This smoke knows production's two public hosts and a loopback forwarding
 * target. Refuse other deployments instead of silently probing production. */
export function oauthDiscoveryTarget(
	baseURL: string | undefined,
): "local" | "production" {
	if (!baseURL) throw new Error("Missing app URL");
	const url = new URL(baseURL);
	if (
		!url.username &&
		!url.password &&
		["http:", "https:"].includes(url.protocol)
	) {
		if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
			return "local";
		if (url.origin === "https://commcare.app") return "production";
	}
	throw new Error(
		"OAuth discovery smoke supports only loopback targets or https://commcare.app. The configured target is unsupported.",
	);
}
