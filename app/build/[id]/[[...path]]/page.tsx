/**
 * Build page — Server Component that fetches app data and composes the
 * client-side builder tree.
 *
 * This page uses an optional catch-all route (`[[...path]]`) so Next.js
 * serves the same RSC page for all intra-builder paths:
 *   /build/{id}              → home
 *   /build/{id}/{uuid}       → module or form
 *   /build/{id}/{uuid}/{uuid} → form + selected question
 *   /build/{id}/{uuid}/cases  → case list
 *
 * The `path` param is NOT read here — all path resolution happens
 * client-side in `useLocation()` (via `useBuilderPathSegments` +
 * `parsePathToLocation`). Navigation uses the browser History API
 * (pushState/replaceState) so intra-builder screen changes are purely
 * client-side with zero server round-trips.
 *
 * Stale deep links (bookmarks with deleted UUIDs) are handled client-side
 * by `LocationRecoveryEffect`, which detects URL/location mismatches
 * and issues `replaceState` to fix the path.
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
