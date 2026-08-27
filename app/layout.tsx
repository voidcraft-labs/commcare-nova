/**
 * Application root layout.
 *
 * The root layout's job is the document shell only: `<html>`, `<body>`,
 * the global CSS import, and the next/font loaders that publish the
 * Nova font CSS variables. Nothing here reads sessions, headers, or
 * cookies, so every route group below: main app, docs, dev-only:
 * starts from a request-independent shell that can be statically
 * generated. Per-area chrome (the authenticated app header, error
 * reporter, toast container, the docs RootProvider) lives inside each
 * route group's own layout.
 */
import type { Metadata } from "next";
import { JetBrains_Mono, Outfit, Plus_Jakarta_Sans } from "next/font/google";
import { readReactProfilerConfig } from "@/config/reactProfiler";
import "./globals.css";

const reactProfiler = readReactProfilerConfig();

const display = Outfit({
	subsets: ["latin"],
	variable: "--font-nova-display",
	weight: ["300", "400", "500", "600", "700"],
});

const sans = Plus_Jakarta_Sans({
	subsets: ["latin"],
	variable: "--font-nova-sans",
});

const mono = JetBrains_Mono({
	subsets: ["latin"],
	variable: "--font-nova-mono",
});

export const metadata: Metadata = {
	title: {
		default: "commcare nova",
		template: "%s · commcare nova",
	},
	description: "Build CommCare apps from natural language",
	/* The hardened bridge reads these before hydration. They exist only in an
	 * explicitly profiled development process; production metadata never carries
	 * the ephemeral token or a WebSocket destination. */
	...(reactProfiler.enabled
		? {
				other: {
					"agent-react-devtools-host": reactProfiler.bridgeHost,
					"agent-react-devtools-port": reactProfiler.bridgePort,
					"agent-react-devtools-token": reactProfiler.token,
				},
			}
		: {}),
};

export default function RootLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	return (
		<html lang="en" className="dark">
			<body
				className={`${display.variable} ${sans.variable} ${mono.variable} antialiased`}
			>
				{children}
			</body>
		</html>
	);
}
