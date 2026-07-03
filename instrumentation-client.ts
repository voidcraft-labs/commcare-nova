// This file configures the initialization of Sentry on the client.
// The added config here will be used whenever a users loads a page in their browser.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";

Sentry.init({
	dsn: "https://1c43ea684bc94e3c53926a2ca3ab9a51@o4511537737039872.ingest.us.sentry.io/4511537747918848",

	/* Off on localhost — the E2E smoke suite drives the production bundle through
	 * HeadlessChrome at http://localhost, and local dev runs there too; neither
	 * should ship browser errors to PROD Sentry. A real deployment is never
	 * localhost. (The server/edge configs gate on the Firestore emulator host,
	 * which the browser can't read.) */
	enabled:
		typeof window !== "undefined" &&
		!["localhost", "127.0.0.1"].includes(window.location.hostname),

	// Add optional integrations for additional features
	integrations: [Sentry.replayIntegration()],

	// Define how likely traces are sampled. Adjust this value in production, or use tracesSampler for greater control.
	tracesSampleRate: 1,
	// Enable logs to be sent to Sentry
	enableLogs: true,

	// Define how likely Replay events are sampled.
	// This sets the sample rate to be 10%. You may want this to be 100% while
	// in development and sample at a lower rate in production
	replaysSessionSampleRate: 0.1,

	// Define how likely Replay events are sampled when an error occurs.
	replaysOnErrorSampleRate: 1.0,

	// Enable sending user PII (Personally Identifiable Information)
	// https://docs.sentry.io/platforms/javascript/guides/nextjs/configuration/options/#sendDefaultPii
	sendDefaultPii: true,
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
