import Link from "next/link";
import { Button } from "@/components/shadcn/button";
import { Logo } from "@/components/ui/Logo";

/**
 * Root not-found: the fallback for any URL that matches no route group.
 *
 * Next's built-in page is white full-bleed with "This page could not be
 * found." Nova is dark everywhere and nothing in it is white, so that page
 * reads as a different product having crashed. The app and docs groups carry
 * their own not-found; this is the one underneath them.
 *
 * It renders inside the root layout, which deliberately reads no session, so
 * this stays a static server component and an unauthenticated visitor gets it
 * without paying for auth.
 */
export default function NotFound() {
	return (
		<div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-nova-void px-6">
			<Logo size="lg" />
			<div className="max-w-md space-y-2 text-center">
				<h1 className="font-display text-lg font-semibold tracking-tighter text-nova-text">
					I couldn't find that page
				</h1>
				<p className="text-sm text-nova-text-secondary">
					The link may be out of date, or the page may have moved.
				</p>
			</div>
			{/* Name the destination, not the product. "Go to commcare nova" is a
			 *  greeting where an address belongs, and it reads as the product
			 *  introducing itself to someone who is already inside it. */}
			<Button render={<Link href="/" />} nativeButton={false}>
				Go to the home page
			</Button>
		</div>
	);
}
