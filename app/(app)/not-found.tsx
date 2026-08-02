import Link from "next/link";
import { Button } from "@/components/shadcn/button";
import { Logo } from "@/components/ui/Logo";

/**
 * Not-found for the whole app route group.
 *
 * Without this file, an unmatched URL falls through to Next's built-in page,
 * which is white full-bleed and reads "This page could not be found." That is
 * jarring anywhere in a dark product, and worse on `/build/<unknown-id>`,
 * where Nova's own layout has already mounted underneath it.
 *
 * The docs subtree has had its own not-found for this reason; this is the
 * same courtesy for the app. It takes responsibility and offers the way back,
 * the way every other Nova error surface does.
 */
export default function AppNotFound() {
	return (
		<div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-nova-void px-6">
			<Logo size="lg" />
			<div className="max-w-md space-y-2 text-center">
				<h1 className="font-display text-lg font-semibold tracking-tighter text-nova-text">
					I couldn't find that page
				</h1>
				<p className="text-sm text-nova-text-secondary">
					The link may be out of date, or the app it points to may have been
					deleted. Your other apps are still where you left them.
				</p>
			</div>
			<Button render={<Link href="/" />} nativeButton={false}>
				Back to your apps
			</Button>
		</div>
	);
}
