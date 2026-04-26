/**
 * Docs 404 — rendered inside the docs layout so the `.nova-docs` chrome
 * (background bloom, sidebar, search) carries through. Without this
 * file, `notFound()` from the catch-all page would walk up to the
 * global default and render unstyled outside the docs subtree.
 */
import Link from "next/link";

export default function DocsNotFound() {
	return (
		<main className="flex flex-col items-center justify-center gap-4 px-6 py-24 text-center">
			<p className="font-mono text-sm tracking-widest text-fd-muted-foreground uppercase">
				404
			</p>
			<h1 className="font-display text-3xl text-fd-foreground">No such page</h1>
			<p className="max-w-md text-fd-muted-foreground">
				The page you tried to open isn't here. It may have moved, or the link
				you followed might be out of date.
			</p>
			<Link
				href="/"
				className="rounded-md border border-fd-border bg-fd-secondary px-4 py-2 text-sm text-fd-foreground transition-colors hover:bg-fd-accent hover:text-fd-accent-foreground"
			>
				Back to docs
			</Link>
		</main>
	);
}
