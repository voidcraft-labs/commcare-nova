/**
 * Async server component for admin dashboard content.
 *
 * Separated from the admin page so it can be wrapped in a Suspense boundary.
 * The data fetch (all users + usage + app counts) happens here while the
 * page shell — header, title — renders and streams immediately.
 *
 * Stats and user table share a single Suspense boundary because they come from
 * the same `getAdminUsersWithStats()` call — splitting them would require either
 * duplicating the user fetch or restructuring the data layer.
 */
import { connection } from "next/server";
import { getAdminUsersWithStats } from "@/lib/db/admin";
import { formatCurrency } from "@/lib/utils/format";
import { StatCard } from "./stat-card";
import { UserTable } from "./user-table";

export async function AdminContent() {
	/* Prevent execution during next build's static generation phase.
	 * The admin layout already bails via connection() in getSession(), but
	 * Next.js may still evaluate Suspense children independently — without
	 * this guard, getAdminUsersWithStats() would attempt a Firestore read
	 * in an environment with no database credentials (Docker build). */
	await connection();
	const { users, stats } = await getAdminUsersWithStats();

	return (
		<div className="space-y-8">
			<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
				<StatCard label="Total Users" value={String(stats.totalUsers)} />
				<StatCard
					label="Generations"
					value={String(stats.totalGenerations)}
					subtitle="this month"
				/>
				{/* Credits are the primary fleet gate metric, so this card sits
				    ahead of the dollar spend in reading order. */}
				<StatCard
					label="Credits Used"
					value={stats.totalCreditsConsumed.toLocaleString()}
					subtitle="this month"
				/>
				{/* Spend is the true dollar cost now, no longer the user-facing
				    gate — "Actual Spend" disambiguates it from the credit metric. */}
				<StatCard
					label="Actual Spend"
					value={formatCurrency(stats.totalSpend)}
					subtitle="this month"
				/>
			</div>

			<UserTable users={users} />
		</div>
	);
}
