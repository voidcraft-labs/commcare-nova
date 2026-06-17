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
 * Chrome lives one level down: `(site)/layout.tsx` renders the global
 * AppHeader for the app list / admin / settings surfaces, while
 * `build/` renders its own BuilderHeader — the builder doesn't carry
 * the site nav. Each group also owns its `#main-content` wrapper
 * (scrolling site pages vs the builder's fixed full-height shell).
 *
 * The `nova-noise` class lives here, on the wrapper div: its `::before`
 * is fixed-position, so it still covers the whole viewport even though
 * it's no longer applied at `<body>`. The docs subtree intentionally
 * doesn't carry it — the noise texture is part of the builder feel,
 * not the docs feel.
 */
import { ErrorReporter } from "@/components/ErrorReporter";
import { SentryUser } from "@/components/SentryUser";
import { ToastContainer } from "@/components/ui/ToastContainer";
import { TooltipProvider } from "@/components/ui/TooltipProvider";

export default function AppLayout({ children }: { children: React.ReactNode }) {
	return (
		<div className="nova-noise flex flex-col h-dvh bg-nova-void">
			{/* Skip link — visually hidden until focused, jumps keyboard users past the header chrome. */}
			<a
				href="#main-content"
				className="sr-only focus:not-sr-only focus:absolute focus:z-system focus:top-2 focus:left-2 focus:px-4 focus:py-2 focus:rounded-lg focus:bg-nova-violet focus:text-white focus:text-sm focus:font-medium focus:outline-none"
			>
				Skip to main content
			</a>
			<ErrorReporter />
			<SentryUser />
			<TooltipProvider>
				{children}
				<ToastContainer />
			</TooltipProvider>
		</div>
	);
}
