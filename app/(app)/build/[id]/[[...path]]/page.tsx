/**
 * Build page — Server Component that fetches app data and composes the
 * client-side builder tree.
 *
 * This page uses an optional catch-all route (`[[...path]]`) so Next.js
 * serves the same RSC page for all intra-builder paths:
 *   /build/{id}              → home
 *   /build/{id}/{uuid}       → module or form
 *   /build/{id}/{uuid}/{uuid} → form + selected field
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
import { BuilderProvider } from "@/components/builder/BuilderProvider";
import { getSession } from "@/lib/auth-utils";
import { loadApp } from "@/lib/db/apps";
import {
	type CommCareSettingsPublic,
	getCommCareSettings,
} from "@/lib/db/settings";
import { log } from "@/lib/logger";
import { ThreadHistory } from "./thread-history";

export default async function BuilderPage({
	params,
}: {
	params: Promise<{ id: string }>;
}) {
	// [perf] TEMP — server data-fetch buckets for the /build/[id] load. The
	// auth bucket is logged in build/layout (getSession here is a cache hit
	// that races the layout's call, so it isn't timed separately). Remove with
	// the rest of the `[perf]` logging once the load regression is diagnosed.
	const pageStart = performance.now();
	const { id } = await params;

	const session = await getSession();
	const settingsStart = performance.now();
	const commcareSettings = session
		? await getCommCareSettings(session.user.id)
		: ({ configured: false } satisfies CommCareSettingsPublic);
	const settingsMs = Math.round(performance.now() - settingsStart);

	/* New apps — no blueprint fetch needed. */
	if (id === "new") {
		return (
			<BuilderProvider buildId={id}>
				<BuilderLayout commcareSettings={commcareSettings} />
			</BuilderProvider>
		);
	}

	if (!session) redirect("/");

	const loadAppStart = performance.now();
	const app = await loadApp(id);
	const loadAppMs = Math.round(performance.now() - loadAppStart);
	if (!app || app.owner !== session.user.id) notFound();
	if (app.status !== "complete") redirect("/");

	/* [perf] Log size alongside duration: a recently-bloated blueprint would
	 * slow BOTH the Firestore read here AND the RSC serialization that happens
	 * after this component returns (which no in-component timer can see — the
	 * gap between `dataFetchMs` and the perceived load is that serialization +
	 * transfer). `blueprintBytes` is the JSON length of the persisted doc. */
	const blueprintBytes = JSON.stringify(app.blueprint).length;
	log.info("[perf] build/page data", {
		appId: id,
		settingsMs,
		loadAppMs,
		dataFetchMs: Math.round(performance.now() - pageStart),
		blueprintBytes,
		moduleCount: app.blueprint.moduleOrder.length,
		formCount: Object.keys(app.blueprint.forms).length,
		fieldCount: Object.keys(app.blueprint.fields).length,
	});

	return (
		<BuilderProvider buildId={id} initialDoc={app.blueprint}>
			<BuilderLayout isExistingApp commcareSettings={commcareSettings}>
				<Suspense fallback={null}>
					<ThreadHistory appId={id} />
				</Suspense>
			</BuilderLayout>
		</BuilderProvider>
	);
}
