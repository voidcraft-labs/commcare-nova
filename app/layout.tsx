import type { Metadata } from "next";
import { Outfit, Plus_Jakarta_Sans, JetBrains_Mono } from "next/font/google";
import { getSession } from "@/lib/auth-utils";
import { AppHeader } from "@/components/ui/AppHeader";
import { ErrorReporter } from "@/components/ErrorReporter";
import "./globals.css";

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
	title: "commcare nova",
	description: "Build CommCare mobile apps from natural language",
};

/**
 * Root layout — fonts, global header, page wrapper.
 *
 * The flex-col + h-dvh container lets the global header take its natural
 * height while the page content fills the rest. On the landing page, the
 * header returns null so the full viewport is available. On builder pages,
 * BuilderLayout uses flex-1 to fill the remaining space below the header.
 * On regular pages, the overflow-auto wrapper scrolls naturally.
 */
export default async function RootLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	const session = await getSession();
	const isAdmin = session?.session?.isAdmin === true;

	return (
		<html lang="en" className="dark">
			<body
				className={`${display.variable} ${sans.variable} ${mono.variable} antialiased nova-noise`}
			>
				<div className="flex flex-col h-dvh bg-nova-void">
					<ErrorReporter />
					<AppHeader isAdmin={isAdmin} />
					<div className="flex-1 overflow-auto">{children}</div>
				</div>
			</body>
		</html>
	);
}
