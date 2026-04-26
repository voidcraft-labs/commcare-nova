import { createMDX } from "fumadocs-mdx/next";
import type { NextConfig } from "next";

const withMDX = createMDX();

const nextConfig: NextConfig = {
	/* Standalone output for containerized deployments (Cloud Run, Docker). */
	/* Produces a self-contained build with only necessary node_modules. */
	output: "standalone",

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
