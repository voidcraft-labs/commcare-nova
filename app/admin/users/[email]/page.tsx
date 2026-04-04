import { Suspense } from "react";
import Link from "next/link";
import { Icon } from "@iconify/react/offline";
import ciChevronLeft from "@iconify-icons/ci/chevron-left";
import { UserProfileSection } from "./user-profile";
import { UserUsageSection } from "./user-usage";
import { UserProjectsSection } from "./user-projects";
import { ProfileSkeleton, UsageSkeleton, ProjectsSkeleton } from "./loading";

/**
 * Admin user detail — in-page breadcrumb + three streamed sections.
 *
 * Auth is handled by the admin layout (requireAdminAccess). The global header
 * is rendered by the root layout. Back navigation and breadcrumb trail live
 * in the page content — not the header.
 */
export default async function AdminUserDetailPage({
	params,
}: {
	params: Promise<{ email: string }>;
}) {
	const { email: rawEmail } = await params;
	const email = decodeURIComponent(rawEmail);
	const encodedEmail = encodeURIComponent(email);

	return (
		<main className="max-w-4xl mx-auto px-6 py-10 space-y-8">
			{/* ── In-page breadcrumb navigation ──────────────────── */}
			<nav className="flex items-center gap-2 text-sm text-nova-text-muted">
				<Link
					href="/admin"
					className="flex items-center gap-0.5 hover:text-nova-text transition-colors"
				>
					<Icon icon={ciChevronLeft} width="16" height="16" />
					Admin
				</Link>
				<span className="text-nova-text-muted/50">/</span>
				<span className="text-nova-text-secondary">{email}</span>
			</nav>

			{/* ── Content — three independent Suspense streams ─── */}
			<Suspense fallback={<ProfileSkeleton />}>
				<UserProfileSection email={email} />
			</Suspense>

			<Suspense fallback={<UsageSkeleton />}>
				<UserUsageSection email={email} />
			</Suspense>

			<Suspense fallback={<ProjectsSkeleton />}>
				<UserProjectsSection email={email} encodedEmail={encodedEmail} />
			</Suspense>
		</main>
	);
}
