/**
 * Docs subtree layout. Wraps every page under `app/(docs)/docs/`.
 *
 * `nova-docs` on the wrapper scopes the docs-only background bloom and
 * heading font (see `app/globals.css`). Fumadocs dark tokens come from
 * the `dark` class on `<html>` in the root layout; this subtree
 * inherits that and never toggles theme. Nova's violet accent overrides
 * deliberately live on `html.dark` rather than `.nova-docs` so fumadocs
 * surfaces which Radix-portal to `<body>` (search dialog, popovers)
 * inherit them too.
 *
 * `RootProvider` is mounted here, not in the root layout, so the search
 * popover and link-prefetch behavior only apply on the docs subtree.
 */
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { RootProvider } from "fumadocs-ui/provider/next";
import type { ReactNode } from "react";
import { docsLayoutProps } from "@/lib/docs/layoutProps";
import { source } from "@/lib/docs/source";

export default function Layout({ children }: { children: ReactNode }) {
	return (
		<div className="nova-docs min-h-full bg-fd-background text-fd-foreground">
			<RootProvider
				search={{
					/* Static search: `/api/search` exports the prebuilt
					 * Orama index via `createFromSource(...).staticGET`;
					 * the client downloads it once and searches in-browser.
					 * Both halves must agree — `type: "static"` here is the
					 * matching client-side configuration. */
					options: {
						type: "static",
					},
				}}
				theme={{
					enabled: false,
				}}
			>
				<DocsLayout tree={source.getPageTree()} {...docsLayoutProps}>
					{children}
				</DocsLayout>
			</RootProvider>
		</div>
	);
}
