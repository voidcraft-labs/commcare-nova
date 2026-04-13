/**
 * Build page — Server Component that fetches app data, validates the
 * URL's location against the live blueprint, and composes the
 * client-side builder tree.
 *
 * URL validation is Phase 2's RSC-side defense: if a user lands on
 * `/build/[id]?s=f&m=<stale-uuid>&…`, this handler server-redirects
 * to a clean URL (stripping only the stale components) before any
 * client code runs. The client-side `LocationRecoveryEffect` covers
 * mutations that happen during a live session.
 */
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { BuilderLayout } from "@/components/builder/BuilderLayout";
import { BuilderProvider } from "@/hooks/useBuilder";
import { getSession } from "@/lib/auth-utils";
import { loadApp } from "@/lib/db/apps";
import { getCommCareSettings } from "@/lib/db/settings";
import { toDoc } from "@/lib/doc/converter";
import { serializeLocation } from "@/lib/routing/location";
import { validateAndRecover } from "@/lib/routing/validateSearchParams";
import { ThreadHistory } from "./thread-history";

export default async function BuilderPage({
	params,
	searchParams,
}: {
	params: Promise<{ id: string }>;
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const { id } = await params;

	const session = await getSession();
	const commcareSettings = session
		? await getCommCareSettings(session.user.id)
		: { configured: false as const, username: "", domain: null };

	/* New apps — no blueprint fetch, no URL validation needed. */
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

	/* Validate the incoming URL against the live blueprint. Stale uuids
	 * (from a bookmark into a deleted question, module, or form) collapse
	 * to the closest valid ancestor via `validateAndRecover` — a user who
	 * bookmarked `?s=f&m=<valid>&f=<valid>&sel=<deleted>` lands on the
	 * form with selection cleared, not bounced all the way to home.
	 *
	 * The pathless compare below (`target !== incomingTarget`) avoids a
	 * redirect loop when the incoming URL already parses to the recovered
	 * location — e.g. duplicate query params that normalize to the same
	 * `Location` as the recovered result. Without this guard the handler
	 * would redirect to the same URL forever. */
	const spRaw = await searchParams;
	const sp = new URLSearchParams();
	for (const [k, v] of Object.entries(spRaw)) {
		if (typeof v === "string") sp.set(k, v);
	}
	const doc = toDoc(app.blueprint, id);
	const validation = validateAndRecover(sp, doc);
	if (validation.kind === "redirect") {
		const cleaned = serializeLocation(validation.location).toString();
		const target = cleaned ? `/build/${id}?${cleaned}` : `/build/${id}`;
		if (target !== `/build/${id}?${sp.toString()}`) {
			redirect(target);
		}
	}

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
