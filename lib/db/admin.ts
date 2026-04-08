/**
 * Admin data queries — shared between API routes and RSC pages.
 *
 * Extracted from the admin API route handlers so Server Components can
 * call the same logic directly without going through HTTP.
 */

import type {
	AdminStats,
	AdminUserDetailResponse,
	AdminUserRow,
	AdminUsersResponse,
	UsagePeriod,
} from "../types/admin";
import { listApps } from "./apps";
import { collections, docs, getDb } from "./firestore";
import { getCurrentPeriod } from "./usage";
import { getUser, listAllUsers } from "./users";

/**
 * Fetch all users with current month usage and app counts.
 *
 * Batch-reads all usage docs in a single Firestore getAll() call (1 round trip
 * for N users instead of N individual reads). App counts are aggregation
 * queries and can't be batched, so those run in parallel per user.
 */
export async function getAdminUsersWithStats(): Promise<AdminUsersResponse> {
	const allUsers = await listAllUsers();
	const period = getCurrentPeriod();

	/* Batch-read all usage docs in a single round trip */
	const usageRefs = allUsers.map((u) => docs.usage(u.id, period));
	const usageSnaps =
		usageRefs.length > 0 ? await getDb().getAll(...usageRefs) : [];

	/* App counts are aggregation queries — run in parallel.
	 * Each query filters the root-level apps collection by owner userId. */
	const appCounts = await Promise.all(
		allUsers.map((u) =>
			collections.apps().where("owner", "==", u.id).count().get(),
		),
	);

	const enriched: AdminUserRow[] = allUsers.map((user, i) => {
		const usageData = usageSnaps[i]?.exists
			? (usageSnaps[i].data() as {
					request_count?: number;
					cost_estimate?: number;
				})
			: null;

		return {
			id: user.id,
			email: user.email,
			name: user.name,
			image: user.image,
			role: user.role,
			created_at: user.created_at.toDate().toISOString(),
			last_active_at: user.last_active_at.toDate().toISOString(),
			generations: usageData?.request_count ?? 0,
			cost: usageData?.cost_estimate ?? 0,
			app_count: appCounts[i].data().count,
		};
	});

	/* Compute headline stats from the enriched data */
	const stats: AdminStats = {
		totalUsers: enriched.length,
		totalGenerations: enriched.reduce((sum, u) => sum + u.generations, 0),
		totalSpend: enriched.reduce((sum, u) => sum + u.cost, 0),
		period,
	};

	return { users: enriched, stats };
}

/**
 * Fetch a single user's profile — returns null if user doesn't exist.
 *
 * Separated so the profile card can stream independently via Suspense.
 */
export async function getAdminUserProfile(
	userId: string,
): Promise<AdminUserDetailResponse["user"] | null> {
	const user = await getUser(userId);
	if (!user) return null;

	return {
		id: userId,
		email: user.email,
		name: user.name,
		image: user.image,
		role: user.role,
		created_at: user.created_at.toDate().toISOString(),
		last_active_at: user.last_active_at.toDate().toISOString(),
	};
}

/**
 * Fetch a user's usage history — all monthly usage periods, newest first.
 *
 * Separated so the usage table can stream independently via Suspense.
 */
export async function getAdminUserUsage(
	userId: string,
): Promise<UsagePeriod[]> {
	const usageSnap = await collections
		.usage(userId)
		.orderBy("updated_at", "desc")
		.get();

	return usageSnap.docs.map((doc) => {
		const data = doc.data();
		return {
			period: doc.id,
			request_count: data.request_count,
			input_tokens: data.input_tokens,
			output_tokens: data.output_tokens,
			cost_estimate: data.cost_estimate,
		};
	});
}

/**
 * Fetch a user's apps — delegates to `listApps`.
 *
 * Separated so the app list can stream independently via Suspense.
 */
export async function getAdminUserApps(userId: string) {
	return listApps(userId);
}

/**
 * Fetch a single user's profile, usage history, and apps.
 *
 * Convenience wrapper that calls the three independent functions in parallel.
 * Used by the admin API route; the RSC page uses the individual functions
 * directly for granular Suspense streaming.
 */
export async function getAdminUserDetail(
	userId: string,
): Promise<AdminUserDetailResponse | null> {
	const [user, usage, apps] = await Promise.all([
		getAdminUserProfile(userId),
		getAdminUserUsage(userId),
		getAdminUserApps(userId),
	]);

	if (!user) return null;
	return { user, usage, apps };
}
