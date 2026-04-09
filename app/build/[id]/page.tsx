/**
 * Build page — Server Component that fetches app data and composes
 * the client-side builder tree.
 *
 * For existing apps: fetches the blueprint server-side, verifies
 * ownership, and passes it to BuilderProvider. Historical threads
 * load inside a Suspense boundary so they don't block the builder —
 * the user can start editing immediately while threads stream in.
 *
 * For new apps (`/build/new`): no server fetch. BuilderProvider starts
 * in Idle phase for chat-driven generation.
 */
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { BuilderLayout } from "@/components/builder/BuilderLayout";
import { BuilderProvider } from "@/hooks/useBuilder";
import { getSession } from "@/lib/auth-utils";
import { loadApp } from "@/lib/db/apps";
import { ThreadHistory } from "./thread-history";

export default async function BuilderPage({
	params,
}: {
	params: Promise<{ id: string }>;
}) {
	const { id } = await params;

	/* New apps — no server fetch needed. */
	if (id === "new") {
		return (
			<BuilderProvider buildId={id}>
				<BuilderLayout />
			</BuilderProvider>
		);
	}

	/* Existing apps — fetch blueprint on the server. getSession() is
	 * React-cached, so this deduplicates with the layout's requireAuth()
	 * call (zero extra Firestore reads). */
	const session = await getSession();
	if (!session) redirect("/");

	const app = await loadApp(id);
	if (!app || app.owner !== session.user.id) notFound();
	if (app.status !== "complete") redirect("/");

	return (
		<BuilderProvider buildId={id} initialBlueprint={app.blueprint}>
			<BuilderLayout isExistingApp>
				<Suspense fallback={null}>
					<ThreadHistory appId={id} />
				</Suspense>
			</BuilderLayout>
		</BuilderProvider>
	);
}
