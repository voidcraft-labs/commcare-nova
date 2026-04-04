import { Icon } from "@iconify/react/offline";
import tablerPlus from "@iconify-icons/tabler/plus";
import Link from "next/link";
import { Suspense } from "react";
import { getSession } from "@/lib/auth-utils";
import { AppList } from "./app-list";
import { Landing } from "./landing";
import { AppListSkeleton } from "./loading";

/**
 * Root page — app list for authenticated users, sign-in for everyone else.
 *
 * Server component that resolves the session once. Authenticated users see
 * their apps immediately (the list streams via Suspense). Unauthenticated
 * users see the landing page with Google OAuth sign-in.
 */
export default async function HomePage() {
	const session = await getSession();

	if (!session) return <Landing />;

	const isAdmin = session.session?.isAdmin === true;

	return (
		<main className="max-w-4xl mx-auto px-6 py-12">
			<div className="flex items-center justify-between mb-8">
				<h1 className="text-2xl font-display font-semibold">Your Apps</h1>
				<Link
					href="/build/new"
					className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg bg-nova-violet text-white border border-transparent hover:bg-nova-violet-bright shadow-[var(--nova-glow-violet)] transition-all duration-200"
				>
					<Icon icon={tablerPlus} width="14" height="14" />
					New App
				</Link>
			</div>

			<Suspense fallback={<AppListSkeleton />}>
				<AppList email={session.user.email} isAdmin={isAdmin} />
			</Suspense>
		</main>
	);
}
