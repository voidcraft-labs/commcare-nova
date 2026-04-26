/**
 * Main-app layout — wraps every authenticated-app route under `(app)/`.
 *
 * This layer is what used to live in the root layout. It was split out
 * so that public-but-served-from-the-same-app surfaces — currently the
 * docs site under `(docs)/` — don't have to pay for `getSession()`
 * (and the Firestore round-trip it triggers) on every request. With
 * this split, docs requests never run the auth lookup, and the docs
 * subdomain stays available even if Firestore is briefly unreachable.
 *
 * The `nova-noise` class lives here, on the wrapper div: its `::before`
 * is fixed-position, so it still covers the whole viewport even though
 * it's no longer applied at `<body>`. The docs subtree intentionally
 * doesn't carry it — the noise texture is part of the builder feel,
 * not the docs feel.
 */
import { ErrorReporter } from "@/components/ErrorReporter";
import { AppHeader } from "@/components/ui/AppHeader";
import { ToastContainer } from "@/components/ui/ToastContainer";
import { TooltipProvider } from "@/components/ui/TooltipProvider";
import { getSession } from "@/lib/auth-utils";

export default async function AppLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	const session = await getSession();
	/* Impersonated sessions are blocked from admin routes, so hide the nav link. */
	const isAdmin =
		session?.user?.role === "admin" && !session?.session?.impersonatedBy;

	/* During impersonation, session.user is the target — pass their
	 * identity so the header banner shows who is being viewed. */
	const impersonating = session?.session?.impersonatedBy
		? { userName: session.user.name, userEmail: session.user.email }
		: null;

	return (
		<div className="nova-noise flex flex-col h-dvh bg-nova-void">
			{/* Skip link — visually hidden until focused, jumps keyboard users past the header nav. */}
			<a
				href="#main-content"
				className="sr-only focus:not-sr-only focus:absolute focus:z-system focus:top-2 focus:left-2 focus:px-4 focus:py-2 focus:rounded-lg focus:bg-nova-violet focus:text-white focus:text-sm focus:font-medium focus:outline-none"
			>
				Skip to main content
			</a>
			<ErrorReporter />
			<TooltipProvider>
				<AppHeader
					isAdmin={isAdmin}
					isAuthenticated={!!session}
					impersonating={impersonating}
				/>
				<div id="main-content" className="flex-1 overflow-auto">
					{children}
				</div>
				<ToastContainer />
			</TooltipProvider>
		</div>
	);
}
