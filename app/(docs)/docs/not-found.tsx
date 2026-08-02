/**
 * Docs 404: rendered inside the docs layout so the `.nova-docs` chrome
 * (background bloom, sidebar, search) carries through. Without this
 * file, `notFound()` from the catch-all page would walk up to the
 * global default and render unstyled outside the docs subtree.
 */
import Link from "next/link";
import { Button } from "@/components/shadcn/button";

export default function DocsNotFound() {
	return (
		<main className="flex w-full max-w-none flex-1 flex-col items-center justify-center gap-4 px-6 py-24 text-center">
			<p className="text-sm text-fd-muted-foreground">404</p>
			<h1 className="font-display tracking-tighter text-3xl text-fd-foreground">
				I couldn&rsquo;t find that page
			</h1>
			<p className="max-w-md text-fd-muted-foreground">
				It may have moved, or the link you followed might be out of date. The
				docs home has everything that&rsquo;s here now.
			</p>
			<Button
				render={<Link href="/" />}
				nativeButton={false}
				variant="secondary"
			>
				Back to docs
			</Button>
		</main>
	);
}
