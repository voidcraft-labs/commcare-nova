import { withSentryConfig } from "@sentry/nextjs";
import { createMDX } from "fumadocs-mdx/next";
import type { NextConfig } from "next";

const withMDX = createMDX();

const nextConfig: NextConfig = {
	/* Standalone output for containerized deployments (Cloud Run, Docker). */
	/* Produces a self-contained build with only necessary node_modules. */
	output: "standalone",

	/* Run the Google Cloud server SDKs from node_modules instead of bundling
	 * them into the minified server chunk.
	 *
	 * `proto3-json-serializer` (used by `@google-cloud/firestore` and
	 * `@google-cloud/kms` via `google-gax` on the REST transport) detects
	 * 64-bit integer values solely by `value.constructor.name === "Long"`.
	 * When the SDK is bundled, the minifier renames the `long` package's
	 * `Long` class to a short identifier, so the name check fails and EVERY
	 * Firestore write carrying an int64 value (timestamps, counts, `seq`)
	 * throws `toProto3JSON: don't know how to convert value <n>`. Loading the
	 * SDKs externally keeps them unminified, so the class name — and the
	 * check — survive. `firebase-admin` already gets this treatment via
	 * Next's built-in default external list; these two we import directly. */
	serverExternalPackages: ["@google-cloud/firestore", "@google-cloud/kms"],

	/* Silence the dev-mode "ƒ serverAction(args)" trace — its safe-stable-stringify
	   truncation renders large args (e.g. saveThread's ThreadDoc) as [Object] /
	   "N items not stringified", which is noise rather than signal. */
	logging: {
		serverFunctions: false,
	},

	/* Allow next/image optimization for Google OAuth profile avatars. */
	images: {
		remotePatterns: [
			{ protocol: "https", hostname: "lh3.googleusercontent.com" },
		],
	},

	async headers() {
		return [
			{
				source: "/:path*",
				headers: [
					/* Prevent MIME-sniffing — forces the browser to trust Content-Type */
					{ key: "X-Content-Type-Options", value: "nosniff" },
					/* Legacy framing block — CSP frame-ancestors 'none' in proxy.ts is
             the primary control; this covers browsers without CSP level 2. */
					{ key: "X-Frame-Options", value: "DENY" },
					/* Send full URL as referrer to same-origin; origin-only cross-origin */
					{ key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
					/* Restrict browser features. `geolocation=(self)` lets the GPS
					   location picker's "use my location" read the device position;
					   camera/microphone stay fully disabled. */
					{
						key: "Permissions-Policy",
						value: "camera=(), microphone=(), geolocation=(self)",
					},
				],
			},
		];
	},
};

export default withSentryConfig(withMDX(nextConfig), {
	org: "dimagi-1l",
	project: "nova",

	/* Only print source-map upload logs in CI. */
	silent: !process.env.CI,

	/* Upload the widened source-map set so stack traces symbolicate beyond
	 * the app's own frames. Uploading happens inside `next build` when
	 * SENTRY_AUTH_TOKEN is set (Cloud Build passes it from Secret Manager
	 * as a Docker build arg); without a token the plugin skips the upload
	 * and the build still succeeds. */
	widenClientFileUpload: true,

	/* Browser events POST to this same-origin path and the server forwards
	 * them to Sentry ingest, so ad-blockers can't drop them and the CSP
	 * `connect-src 'self'` already covers it. Lives under `/api` so the
	 * proxy's API short-circuit applies (no CSP assembly, no auth
	 * redirect); the path is allowlisted per-host in `lib/hostnames.ts`. */
	tunnelRoute: "/api/monitoring",
});
