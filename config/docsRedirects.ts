import type { NextConfig } from "next";
import { HOSTNAMES } from "../lib/hostnames";

/** Permanent docs URL moves, host-scoped because Next applies these before Proxy. */
export const docsRedirects: NonNullable<NextConfig["redirects"]> = async () => [
	{
		source: "/feature-flags",
		has: [
			{
				type: "host",
				value: HOSTNAMES.docs.replaceAll(".", "\\."),
			},
		],
		destination: "/project-space-compatibility",
		permanent: true,
	},
];
