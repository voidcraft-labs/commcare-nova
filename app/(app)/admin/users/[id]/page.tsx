import { Icon } from "@iconify/react/offline";
import tablerChevronLeft from "@iconify-icons/tabler/chevron-left";
import Link from "next/link";
import { Suspense } from "react";
import { AppsSkeleton, ProfileSkeleton, UsageSkeleton } from "./skeletons";
import { UserAppsSection } from "./user-apps";
import { UserProfileSection } from "./user-profile";
import { UserUsageSection } from "./user-usage";

/**
 * Admin user detail — in-page breadcrumb + three streamed sections.
 *
 * Auth is handled by the admin layout (requireAdminAccess). The global header
 * is rendered by the root layout. Back navigation and breadcrumb trail live
 * in the page content — not the header.
 *
 * The URL param is the user's UUID (`/admin/users/{userId}`). The profile
 * section resolves the email and name from Firestore for display.
 */
export default async function AdminUserDetailPage({
	params,
}: {
	params: Promise<{ id: string }>;
}) {
	const { id: userId } = await params;
	return (
		<main className="max-w-4xl mx-auto px-6 py-10 space-y-8">
			{/* ── In-page breadcrumb navigation ──────────────────── */}
			<nav className="flex items-center gap-2 text-sm text-nova-text-muted">
				<Link
					href="/admin"
					className="flex items-center gap-0.5 hover:text-nova-text transition-colors"
				>
					<Icon icon={tablerChevronLeft} width="16" height="16" />
					Admin
				</Link>
				<span className="text-nova-text-muted/50">/</span>
				<span className="text-nova-text-secondary">User</span>
			</nav>

			{/* ── Content — three independent Suspense streams ─── */}
			<Suspense fallback={<ProfileSkeleton />}>
				<UserProfileSection userId={userId} />
			</Suspense>

			<Suspense fallback={<UsageSkeleton />}>
				<UserUsageSection userId={userId} />
			</Suspense>

			<Suspense fallback={<AppsSkeleton />}>
				<UserAppsSection userId={userId} />
			</Suspense>
		</main>
	);
}
