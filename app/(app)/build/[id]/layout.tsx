/**
 * The build route's own segment, above the page's data reads.
 *
 * It exists for one job: claim the shared header band before the page can.
 * The page awaits an authorized app snapshot and its threads, so on a hard
 * load the app shell hydrates first and the band would paint the site's menus
 * inside the builder for the length of those reads. This layer renders in the
 * first commit and hands the band its opening state; `BuilderHeader` keeps it
 * current from there (see `BuilderBandClaim`).
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
	return (
		<>
			<BuilderBandClaim newBuild={id === "new"} />
			{children}
		</>
	);
}
