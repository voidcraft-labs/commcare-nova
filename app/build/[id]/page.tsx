/**
 * Build page — Server Component that fetches app data and composes
 * the client-side builder tree.
 *
 * For existing apps: fetches the blueprint and CommCare settings
 * server-side in parallel, verifies ownership, and passes both to
 * BuilderProvider/BuilderLayout. Historical threads load inside a
 * Suspense boundary so they don't block the builder.
 *
 * For new apps (`/build/new`): no blueprint fetch. CommCare settings
 * are still read so the export dropdown is populated on first paint.
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

	/* getSession() is React-cached — deduplicates with the layout's
	 * requireAuth() call (zero extra Firestore reads). */
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

	/* Existing apps — fetch blueprint on the server. */
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
