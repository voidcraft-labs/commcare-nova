// This file configures the initialization of Sentry on the server.
// The config you add here will be used whenever the server handles a request.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";

Sentry.init({
	dsn: "https://1c43ea684bc94e3c53926a2ca3ab9a51@o4511537737039872.ingest.us.sentry.io/4511537747918848",

	/* Never report from a run against the Firestore EMULATOR — the E2E smoke
	 * suite and the integration tests build+run the production bundle locally,
	 * so without this a test-run server error (e.g. a mid-run emulator SIGTERM
	 * surfacing as `ECONNREFUSED 127.0.0.1:8080`) ships to PROD Sentry,
	 * mis-tagged `environment: production`, with a localhost URL. The emulator
	 * host is only ever set in those local runs, never in a real deployment. */
	enabled: !process.env.FIRESTORE_EMULATOR_HOST,

	// Define how likely traces are sampled. Adjust this value in production, or use tracesSampler for greater control.
	tracesSampleRate: 1,

	// Enable logs to be sent to Sentry
	enableLogs: true,

	/* Off on the server: with PII enabled the SDK attaches request headers
	 * and cookies to events, which would ship the Better Auth session token
	 * to Sentry on every captured error. The client config keeps it on —
	 * browser events carry no cookies, just IP-based user attribution. */
	sendDefaultPii: false,
});
