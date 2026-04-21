/**
 * Admin data queries — shared between API routes and RSC pages.
 *
 * Reads `auth_users` directly via Firestore SDK rather than Better Auth's
 * admin API (`listUsers`/`getUser`) because those return `UserWithRole`
 * which doesn't include `additionalFields` in its TypeScript types.
 * Our `lastActiveAt` field is there at runtime but invisible to TS.
 */

import { Timestamp } from "@google-cloud/firestore";
import type {
	AdminStats,
	AdminUserDetailResponse,
	AdminUserRow,
	AdminUsersResponse,
	UsagePeriod,
} from "@/lib/admin/types";
import { listApps } from "./apps";
import { collections, docs, getDb } from "./firestore";
import { getCurrentPeriod } from "./usage";

// ── Auth User Data ───────────────────────────────────────────────────

/**
 * Fields we read from `auth_users` documents. Typed as potentially
 * undefined because raw Firestore reads bypass Better Auth's validation.
 */
interface AuthUserData {
	email: string | undefined;
	name: string | undefined;
	image: string | null | undefined;
	role: "admin" | "user" | undefined;
	createdAt: Timestamp | Date;
	lastActiveAt: Timestamp | Date | undefined;
}

/** Raw Firestore reads return Timestamps, not Dates — handle both. */
function toISOString(val: Timestamp | Date): string {
	if (val instanceof Timestamp) return val.toDate().toISOString();
	return val.toISOString();
}

// ── Queries ──────────────────────────────────────────────────────────

/**
 * Fetch all users with current month usage and app counts.
 *
 * Reads from three sources:
 * - `auth_users` — profile, role, activity timestamps (direct Firestore read)
 * - `usage/{userId}/months/{period}` — monthly spend/generation counts
 * - `apps` collection — per-user app count aggregations
 */
export async function getAdminUsersWithStats(): Promise<AdminUsersResponse> {
	const authUsersSnap = await getDb().collection("auth_users").get();
	const allUsers = authUsersSnap.docs.map((doc) => ({
		id: doc.id,
		...(doc.data() as AuthUserData),
	}));
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
			email: user.email ?? "",
			name: user.name ?? "",
			image: user.image ?? null,
			role: user.role === "admin" ? ("admin" as const) : ("user" as const),
			created_at: toISOString(user.createdAt),
			/* Fall back to createdAt for users who haven't interacted since
			 * the lastActiveAt field was added. */
			last_active_at: user.lastActiveAt
				? toISOString(user.lastActiveAt)
				: toISOString(user.createdAt),
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
 * Reads directly from `auth_users` — one document read, no merge needed.
 * Separated so the profile card can stream independently via Suspense.
 */
export async function getAdminUserProfile(
	userId: string,
): Promise<AdminUserDetailResponse["user"] | null> {
	const snap = await getDb().collection("auth_users").doc(userId).get();
	if (!snap.exists) return null;
	const data = snap.data() as AuthUserData;

	return {
		id: userId,
		email: data.email ?? "",
		name: data.name ?? "",
		image: data.image ?? null,
		role: data.role === "admin" ? "admin" : "user",
		created_at: toISOString(data.createdAt),
		last_active_at: data.lastActiveAt
			? toISOString(data.lastActiveAt)
			: toISOString(data.createdAt),
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
