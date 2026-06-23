/**
 * Parse a URL's hostname/origin without throwing, for host comparisons.
 *
 * Used instead of `url.includes(host)` substring checks — those are both
 * imprecise (`accounts.google.com` matches `accounts.google.com.evil.test`) and
 * a CodeQL `js/incomplete-url-substring-sanitization` finding. Shared so the
 * config, the error-guard fixture, and the public spec all parse the same way.
 */
export function urlHost(url: string): string | undefined {
	try {
		return new URL(url).hostname;
	} catch {
		return undefined;
	}
}

export function urlOrigin(url: string): string | undefined {
	try {
		return new URL(url).origin;
	} catch {
		return undefined;
	}
}
