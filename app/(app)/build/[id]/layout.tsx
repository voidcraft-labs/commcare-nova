/**
 * The build route's own segment, above the page's data reads.
 *
 * It exists to tell the shared header band, as early as possible, that this
 * page is already a build. Two mechanisms, because they answer at different
 * times and the band needs both.
 *
 * `BuilderBandClaim` claims in the first client commit — earlier than the page
 * can, since the page awaits an authorized app snapshot and its threads, and
 * the band would otherwise stand unclaimed for the length of those reads.
 *
 * The marker answers in the HTML itself, which is earlier still and is the
 * only thing that can be right on the FIRST PAINT. A claim can only come from
 * below the band, so the band's server render is structurally unclaimed: it
 * emits the whole `commcare nova` lockup and the site's menus, and every hard
 * load of an existing build painted them for a beat before React collapsed
 * them. `globals.css` reads this marker with `:has()` and settles both from
 * the first byte, with no script and nothing to animate away. `/build/new`
 * deliberately has no marker: it has no app, so it IS the site band.
 *
 * `id` is read here and nowhere else in the builder's routing: every intra-
 * builder path is resolved client-side from the History API.
 */
import { BuilderBandClaim } from "@/components/builder/BuilderBandClaim";

export default async function BuildIdLayout({
	children,
	params,
}: {
	children: React.ReactNode;
	params: Promise<{ id: string }>;
}) {
	const { id } = await params;
	const buildOpen = id !== "new";
	return (
		<>
			{buildOpen ? <div data-nova-build-open hidden /> : null}
			<BuilderBandClaim newBuild={!buildOpen} />
			{children}
		</>
	);
}
