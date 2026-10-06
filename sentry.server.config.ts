// This file configures the initialization of Sentry on the server.
// The config you add here will be used whenever the server handles a request.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";
import { serverDataCollection } from "./sentry.dataCollection";

// withSentryConfig inlines this value in application code. The native server
// SDK reads its injected-global fallback instead, so carry the same value
// across that boundary before init installs its frame-rewriting integration.
Reflect.set(
	globalThis,
	"_sentryRewriteFramesDistDir",
	process.env._sentryRewriteFramesDistDir,
);

Sentry.init({
	dsn: "https://1c43ea684bc94e3c53926a2ca3ab9a51@o4511537737039872.ingest.us.sentry.io/4511537747918848",
	release: process.env.NOVA_BUILD_ID || undefined,

	/* Never report from a LOCAL run — the E2E smoke suite (and `npm run dev`)
	 * build+run the production bundle against the local Postgres, so without this
	 * a test-run server error (e.g. a localhost connection reset) ships to PROD
	 * Sentry, mis-tagged `environment: production`, with a localhost URL.
	 * `NOVA_DB_LOCAL_URL` is the local-Postgres opt-in — set in every local run,
	 * never in a real deployment (production uses the Cloud SQL connector). */
	enabled: !process.env.NOVA_DB_LOCAL_URL,

	// Define how likely traces are sampled. Adjust this value in production, or use tracesSampler for greater control.
	tracesSampleRate: 1,

	/* Restricted on the server: the SDK's own defaults would ship the Better
	 * Auth session cookie, request bodies, and model prompts to Sentry. The
	 * client config keeps the default, where it adds only IP-based user
	 * attribution. */
	dataCollection: serverDataCollection,
});
