import { useCallback, useEffect, useState } from "react";
// `import type` is load-bearing: the value side of `lib/db/credits` pulls in
// `@google-cloud/firestore`, and only the erased `type` form keeps that server
// dependency out of the client bundle this hook ships in.
import type { CreditSummary } from "@/lib/db/credits";

/**
 * Client hook: the signed-in user's current credit summary, fetched from
 * GET /api/user/usage.
 *
 * Shared so the two surfaces that show a credit figure — the AccountMenu's
 * fuel-gauge and the chat send-button's cost chip — read one fetch shape
 * instead of each maintaining a private copy. It dedups the *code*, not the
 * request: each consumer fetches independently (the figures are read-only and
 * cheap, and a request cache would be premature for two callers), so there is
 * deliberately no shared store here.
 *
 * Best-effort by design: a failed or aborted fetch leaves `summary` null and
 * the caller renders without the figure rather than surfacing an error — a
 * missing balance hint is never worth blocking the UI. `enabled` gates the
 * initial fetch so a caller behind an async auth check can avoid firing a 401
 * before sign-in resolves. `refresh` re-fetches on demand (e.g. when a dropdown
 * opens after a generation has spent credits); pass an AbortSignal to cancel an
 * in-flight request on cleanup.
 */
export function useCreditBalance(enabled = true): {
	summary: CreditSummary | null;
	refresh: (signal?: AbortSignal) => void;
} {
	const [summary, setSummary] = useState<CreditSummary | null>(null);

	const refresh = useCallback((signal?: AbortSignal) => {
		fetch("/api/user/usage", { signal })
			.then((res) => (res.ok ? (res.json() as Promise<CreditSummary>) : null))
			.then((data) => {
				if (data) setSummary(data);
			})
			.catch(() => {});
	}, []);

	/* Fetch once on mount (when enabled) so a consumer has the figure ready the
	 * first time it renders, with no loading flash. The AbortController cancels
	 * the in-flight request if the component unmounts before it resolves. */
	useEffect(() => {
		if (!enabled) return;
		const controller = new AbortController();
		refresh(controller.signal);
		return () => controller.abort();
	}, [enabled, refresh]);

	return { summary, refresh };
}
