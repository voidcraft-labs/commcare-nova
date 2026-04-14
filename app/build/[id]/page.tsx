/**
 * Build page — Server Component that fetches app data and composes the
 * client-side builder tree.
 *
 * This page does NOT read `searchParams`. Search params drive intra-builder
 * navigation (screen, selection) and are consumed entirely on the client by
 * `useLocation()` and `LocationRecoveryEffect`. By not depending on search
 * params, Next.js only re-renders this page when the `[id]` segment changes
 * — search param navigations are pure client-side state transitions with
 * zero server round-trips.
 *
 * Stale deep links (bookmarks with deleted UUIDs) are handled client-side
 * by `LocationRecoveryEffect`, which strips invalid params on mount.
 */
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { BuilderLayout } from "@/components/builder/BuilderLayout";
import { BuilderProvider } from "@/hooks/useBuilder";
import { getSession } from "@/lib/auth-utils";
import { loadApp } from "@/lib/db/apps";
import { getCommCareSettings } from "@/lib/db/settings";
import { ThreadHistory } from "./thread-history";

export default async function BuilderPage({
	params,
}: {
	params: Promise<{ id: string }>;
}) {
	const { id } = await params;

	const session = await getSession();
	const commcareSettings = session
		? await getCommCareSettings(session.user.id)
		: { configured: false as const, username: "", domain: null };

	/* New apps — no blueprint fetch needed. */
	if (id === "new") {
		return (
			<BuilderProvider buildId={id}>
				<BuilderLayout commcareSettings={commcareSettings} />
			</BuilderProvider>
		);
	}

	if (!session) redirect("/");

	const app = await loadApp(id);
	if (!app || app.owner !== session.user.id) notFound();
	if (app.status !== "complete") redirect("/");

	return (
		<BuilderProvider buildId={id} initialBlueprint={app.blueprint}>
			<BuilderLayout isExistingApp commcareSettings={commcareSettings}>
				<Suspense fallback={null}>
					<ThreadHistory appId={id} />
				</Suspense>
			</BuilderLayout>
		</BuilderProvider>
	);
}
