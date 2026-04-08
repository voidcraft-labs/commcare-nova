/**
 * Admin data queries — shared between API routes and RSC pages.
 *
 * Extracted from the admin API route handlers so Server Components can
 * call the same logic directly without going through HTTP.
 *
 * Role data comes from `auth_users` (Better Auth's admin plugin), while
 * app-level user data (activity timestamps) comes from `users/`. Both
 * are read and merged by user ID.
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

/** Read a user's role from the auth_users collection (Better Auth admin plugin). */
async function getAuthUserRole(userId: string): Promise<"user" | "admin"> {
	const snap = await getDb().collection("auth_users").doc(userId).get();
	return snap.data()?.role === "admin" ? "admin" : "user";
}

/**
 * Build a userId → role map by batch-reading all auth_users documents.
 *
 * Used by `getAdminUsersWithStats` to merge role data from auth_users
 * into the admin user table without N+1 individual reads.
 */
async function getAuthUserRoles(): Promise<Map<string, "user" | "admin">> {
	const snap = await getDb().collection("auth_users").get();
	const roles = new Map<string, "user" | "admin">();
	for (const doc of snap.docs) {
		roles.set(doc.id, doc.data().role === "admin" ? "admin" : "user");
	}
	return roles;
}

/**
 * Fetch all users with current month usage and app counts.
 *
 * Reads from four sources:
 * - `users/` — profile data and activity timestamps
 * - `auth_users` — role (from Better Auth admin plugin)
 * - `users/{id}/usage/{period}` — monthly spend/generation counts
 * - `apps` collection — per-user app count aggregations
 */
export async function getAdminUsersWithStats(): Promise<AdminUsersResponse> {
	/* Read app users and auth roles in parallel */
	const [allUsers, roleMap] = await Promise.all([
		listAllUsers(),
		getAuthUserRoles(),
	]);
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
			role: roleMap.get(user.id) ?? "user",
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
 * Reads profile data from `users/` and role from `auth_users` in parallel.
 * Separated so the profile card can stream independently via Suspense.
 */
export async function getAdminUserProfile(
	userId: string,
): Promise<AdminUserDetailResponse["user"] | null> {
	const [user, role] = await Promise.all([
		getUser(userId),
		getAuthUserRole(userId),
	]);
	if (!user) return null;

	return {
		id: userId,
		email: user.email,
		name: user.name,
		image: user.image,
		role,
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
