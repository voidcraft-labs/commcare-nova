/* Pull the builder page's server module graph into this page's graph.
 * The import is for its side effect only: instantiating these modules
 * is the multi-second cost a fresh instance otherwise pays on its
 * first real page render. */
import "@/app/(app)/build/[id]/[[...path]]/page";
import { getSession } from "@/lib/auth-utils";

/**
 * Warmup target for Cloud Run's HTTP startup probe.
 *
 * A new instance is only marked ready — and only starts receiving
 * traffic — once this page has rendered successfully. Rendering it
 * forces the work a cold instance otherwise performs on its first
 * user-facing request: the `(app)` layout chain, the auth client and
 * shared Cloud SQL pool initialization (via `getSession`), and the
 * builder page's server module graph (via the side-effect import
 * above). With the probe pointed here, deploys and autoscale-ups stop
 * exposing that cost to users.
 *
 * Reachability: only the probe should hit this. The probe arrives with
 * the instance's own Host header, which classifies as unknown in
 * `proxy.ts` and is exempted from the auth redirect there. On the
 * custom domains the hostname allowlist 404s `/warmup`, so it is not a
 * public page.
 */
export default async function WarmupPage() {
	await getSession();
	return <p>warm</p>;
}
