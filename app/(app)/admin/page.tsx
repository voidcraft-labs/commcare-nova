import { Suspense } from "react";
import { AdminContent } from "./admin-content";
import { AdminContentSkeleton } from "./skeletons";

/**
 * Admin dashboard — streams the shell instantly, data via Suspense.
 *
 * Auth is handled by the admin layout (requireAdminAccess). The global header
 * is rendered by the root layout. Title renders immediately. Stats and user
 * table stream in together via a single Suspense boundary.
 */
export default function AdminDashboardPage() {
	return (
		<main className="max-w-6xl mx-auto px-6 py-12">
			<h1 className="text-2xl font-display font-semibold mb-8">
				Admin Dashboard
			</h1>

			<Suspense fallback={<AdminContentSkeleton />}>
				<AdminContent />
			</Suspense>
		</main>
	);
}
