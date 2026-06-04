import { createMDX } from "fumadocs-mdx/next";
import type { NextConfig } from "next";

const withMDX = createMDX();

const nextConfig: NextConfig = {
	/* Standalone output for containerized deployments (Cloud Run, Docker). */
	/* Produces a self-contained build with only necessary node_modules. */
	output: "standalone",

	/* Run the Firestore + KMS SDKs from node_modules instead of bundling them
	 * into the minified server chunk.
	 *
	 * `proto3-json-serializer` (reached via `google-gax` on the REST transport)
	 * detects 64-bit integer values solely by `value.constructor.name ===
	 * "Long"`. When the SDK is bundled, the minifier renames the `long`
	 * package's `Long` class to a short identifier, so the name check fails and
	 * EVERY write carrying an int64 value (timestamps, counts, `seq`) throws
	 * `toProto3JSON: don't know how to convert value <n>`. Loading the SDK
	 * externally keeps it unminified, so the class name — and the check —
	 * survive. `firebase-admin` already gets this treatment via Next's built-in
	 * default external list; firestore + kms we import directly.
	 *
	 * We deliberately do NOT externalize `@google-cloud/storage` or
	 * `@google-cloud/cloud-sql-connector`. They don't reach the `Long`
	 * serializer (they use the JSON/gaxios transport, not gax+protobuf), so
	 * they aren't affected by this bug — and externalizing them breaks
	 * `next build`: both are ESM `type: module` dual packages, and Next's
	 * page-data collection fails to `require()` them as externals
	 * (`Failed to collect page data … at externalImport`). Bundling is correct
	 * for them; only the two CommonJS gax SDKs that carry the footgun need to
	 * stay external. */
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
					/* Restrict browser features the app never uses */
					{
						key: "Permissions-Policy",
						value: "camera=(), microphone=(), geolocation=()",
					},
				],
			},
		];
	},
};

export default withMDX(nextConfig);
