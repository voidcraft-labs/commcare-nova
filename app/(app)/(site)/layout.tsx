/**
 * Site layout: the scrolling document shell for every non-builder surface
 * (app list, admin, settings, consent).
 *
 * It renders no header. There is one band for the whole signed-in app and it
 * is mounted above both route groups (`(app)/layout.tsx` → `AppChrome`),
 * because a header owned by a route group is rebuilt on every crossing between
 * groups. The site's own menus — the nav, the Project switcher, Help — are the
 * band's UNCLAIMED state, so they need no wiring here: the builder claims the
 * band while it is on screen and they step aside for exactly that long.
 *
 * What this layout still owns is the scroller. The builder's own
 * `#main-content` is a fixed full-height flex cell instead, because it manages
 * its internal scrolling itself.
 */
export default function SiteLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	return (
		<div id="main-content" className="flex-1 overflow-auto">
			{children}
		</div>
	);
}
