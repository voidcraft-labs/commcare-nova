/* Pull the builder page's server module graph into this page's graph.
 * The import is for its side effect only: instantiating these modules
 * is the multi-second cost a fresh instance otherwise pays on its
 * first real page render. */
import "@/app/(app)/build/[id]/[[...path]]/page";
import { assertRuntimeStartupHealth } from "@/lib/runtimeCapabilities/startupHealth";

/** Health must execute inside each candidate instance, never at image build. */
export const dynamic = "force-dynamic";

/**
 * Warmup target for Cloud Run's HTTP startup probe.
 *
 * A new instance is only marked ready — and only starts receiving
 * traffic — once this page has rendered successfully. Rendering it
 * forces the work a cold instance otherwise performs on its first
 * user-facing request: the `(app)` layout chain, the shared Cloud SQL pool,
 * and the builder page's server module graph (via the side-effect import
 * above). It also rejects a candidate whose baked capability declaration or
 * Cloud Build identity does not exactly match the checked-in runtime contract.
 * With the probe pointed here, deploys and autoscale-ups stop exposing cold
 * graph cost or a misdeclared candidate to users.
 *
 * Reachability: only the probe should hit this. The probe arrives with
 * the instance's own Host header, which classifies as unknown in `proxy.ts`;
 * production admits only exact GET/HEAD requests for this path. Public custom
 * hosts reject it, and every failure renders a generic 500 without declaration
 * or database details.
 */
export default async function WarmupPage() {
	await assertRuntimeStartupHealth();
	return <p>warm</p>;
}
