/**
 * Admin data queries — shared between API routes and RSC pages.
 *
 * Reads the user list from `auth_user` via Kysely (the shared `getAuthDb`)
 * rather than Better Auth's admin API (`listUsers`/`getUser`) because those
 * return `UserWithRole`, which doesn't include `additionalFields` (our
 * `lastActiveAt`) in its TypeScript types. The per-user usage / credits /
 * apps figures stay in Firestore — this is a fan-out, NOT a SQL join (those
 * collections live in the `lib/db` domain).
 */

import { Timestamp } from "@google-cloud/firestore";
import type {
	AdminStats,
	AdminUserDetailResponse,
	AdminUserRow,
	AdminUsersResponse,
	CreditGrantAudit,
	UsagePeriod,
} from "@/lib/admin/types";
import { getAuthDb } from "../auth/db";
import { type AppSummary, listApps } from "./apps";
import { type CreditSummary, getCreditSummary } from "./credits";
import { collections } from "./firestore";
import { getCurrentPeriod } from "./period";

// ── Date helper ──────────────────────────────────────────────────────

/**
 * To an ISO string. The auth-user reads come back from Kysely as `Date`;
 * the credit-grant audit path still reads Firestore (`Timestamp`) — handle
 * both shapes.
 */
function toISOString(val: Timestamp | Date): string {
	if (val instanceof Timestamp) return val.toDate().toISOString();
	return val.toISOString();
}

// ── Queries ──────────────────────────────────────────────────────────

/**
 * Fetch all users with current-month usage, lifetime cost, credit balances,
 * and app counts.
 *
 * Reads from three sources per user, fanned out via Promise.all:
 * - `auth_user` — profile, role, activity timestamps (Kysely read)
 * - `credits/{userId}/months` + `usage/{userId}/months` — full subcollection
 *   reads per user for credit figures and lifetime/current cost. We read the
 *   ENTIRE usage subcollection (not just the current-period doc) because the
 *   lifetime cost sum requires all months anyway — reading the current doc
 *   separately would pay for it twice. `getCreditSummary` similarly reads the
 *   entire credit-months subcollection to compute `lifetimeConsumed`.
 * - `apps` collection — per-user app count aggregations
 *
 * O(users) subcollection reads is accepted at current scale — same shape as
 * the existing per-user app-count Promise.all this function already ran.
 */
export async function getAdminUsersWithStats(): Promise<AdminUsersResponse> {
	const db = await getAuthDb();
	const allUsers = await db
		.selectFrom("auth_user")
		.select([
			"id",
			"email",
			"name",
			"image",
			"role",
			"createdAt",
			"lastActiveAt",
		])
		.execute();
	const period = getCurrentPeriod();

	/* Fan out one inner Promise.all per user: credit summary, all usage months,
	 * and app count — each in parallel across all users. */
	const enriched: AdminUserRow[] = await Promise.all(
		allUsers.map(async (user) => {
			const [creditSummary, usageSnap, appCountSnap] = await Promise.all([
				/* Credit summary reads the full credit-months subcollection to compute
				 * lifetimeConsumed and the current-period balance in one pass. */
				getCreditSummary(user.id),
				/* Full usage subcollection — needed for the lifetime cost sum. Reading
				 * the whole collection here avoids a redundant single-doc read that
				 * would otherwise re-read the current period to get `generations`/`cost`. */
				collections.usage(user.id).get(),
				/* App counts are aggregation queries. Filter by `deleted_at == null`
				 * so the count reflects live apps only; soft-deleted rows would
				 * otherwise inflate the admin view. */
				collections
					.apps()
					.where("owner", "==", user.id)
					.where("deleted_at", "==", null)
					.count()
					.get(),
			]);

			/* Find the current-period usage doc from the full collection read. */
			const currentUsage = usageSnap.docs.find((d) => d.id === period)?.data();

			/* Sum cost_estimate across ALL periods for the lifetime figure. */
			const cost_lifetime = usageSnap.docs.reduce(
				(sum, d) => sum + (d.data().cost_estimate ?? 0),
				0,
			);

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
				generations: currentUsage?.request_count ?? 0,
				cost: currentUsage?.cost_estimate ?? 0,
				app_count: appCountSnap.data().count,
				credits_used: creditSummary.consumed,
				credits_remaining: creditSummary.balance,
				credits_used_lifetime: creditSummary.lifetimeConsumed,
				cost_lifetime,
			};
		}),
	);

	/* Compute headline stats from the enriched data */
	const stats: AdminStats = {
		totalUsers: enriched.length,
		totalGenerations: enriched.reduce((sum, u) => sum + u.generations, 0),
		totalSpend: enriched.reduce((sum, u) => sum + u.cost, 0),
		period,
		totalCreditsConsumed: enriched.reduce((sum, u) => sum + u.credits_used, 0),
	};

	return { users: enriched, stats };
}

/**
 * Fetch a single user's profile — returns null if user doesn't exist.
 *
 * Reads `auth_user` via Kysely — one row, no merge needed. Separated so
 * the profile card can stream independently via Suspense.
 */
export async function getAdminUserProfile(
	userId: string,
): Promise<AdminUserDetailResponse["user"] | null> {
	const db = await getAuthDb();
	const data = await db
		.selectFrom("auth_user")
		.select(["email", "name", "image", "role", "createdAt", "lastActiveAt"])
		.where("id", "=", userId)
		.executeTakeFirst();
	if (!data) return null;

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
 * Fetch a user's credit balance summary and admin-intervention audit trail.
 *
 * Separated so the credit panel can stream independently via Suspense.
 * Returns the full `CreditSummary` (current period + lifetime) alongside
 * the ordered audit rows. Grants are newest-first so the most recent
 * intervention is visible at the top of the list without scrolling.
 */
export async function getAdminUserCredits(
	userId: string,
): Promise<{ credits: CreditSummary; grants: CreditGrantAudit[] }> {
	const [credits, grantsSnap] = await Promise.all([
		getCreditSummary(userId),
		collections.creditGrants(userId).orderBy("created_at", "desc").get(),
	]);

	const grants: CreditGrantAudit[] = grantsSnap.docs.map((doc) => {
		const data = doc.data();
		return {
			amount: data.amount,
			type: data.type,
			/* `actor` uid is intentionally omitted — the admin email is the
			 * human-readable identity surfaced in the audit UI; the uid is
			 * an implementation detail the dashboard never needs. */
			actor_email: data.actor_email,
			reason: data.reason,
			period: data.period,
			created_at: toISOString(data.created_at),
		};
	});

	return { credits, grants };
}

/**
 * Fetch a user's usage history — all monthly usage periods, newest first.
 *
 * Reads both the usage subcollection and the credit-months subcollection in
 * parallel, then joins them by period id so each `UsagePeriod` carries the
 * matching credit figures when they exist. Periods that predate the credit
 * system have no credit doc and will have
 * `credits_allowance`/`credits_consumed`/`credits_bonus` left undefined.
 *
 * Separated so the usage table can stream independently via Suspense.
 */
export async function getAdminUserUsage(
	userId: string,
): Promise<UsagePeriod[]> {
	const [usageSnap, creditMonthsSnap] = await Promise.all([
		collections.usage(userId).orderBy("updated_at", "desc").get(),
		collections.creditMonths(userId).get(),
	]);

	/* Build a lookup map: period string → credit figures. Keyed by document id
	 * (which equals the "yyyy-mm" period string) for an O(1) join below.
	 * `allowance` rides along so the detail table can show the full credit
	 * standing (allowance / consumed / bonus / balance) per period — balance is
	 * derived in the render from these three, never stored. */
	const creditByPeriod = new Map<
		string,
		{ allowance: number; consumed: number; bonus: number }
	>(
		creditMonthsSnap.docs.map((doc) => [
			doc.id,
			{
				allowance: doc.data().allowance,
				consumed: doc.data().consumed,
				bonus: doc.data().bonus,
			},
		]),
	);

	return usageSnap.docs.map((doc) => {
		const data = doc.data();
		const creditEntry = creditByPeriod.get(doc.id);
		return {
			period: doc.id,
			request_count: data.request_count,
			input_tokens: data.input_tokens,
			output_tokens: data.output_tokens,
			cost_estimate: data.cost_estimate,
			/* Only present when a credit doc exists for this period. */
			...(creditEntry !== undefined
				? {
						credits_allowance: creditEntry.allowance,
						credits_consumed: creditEntry.consumed,
						credits_bonus: creditEntry.bonus,
					}
				: undefined),
		};
	});
}

/**
 * First-page size for the admin-surface app list.
 *
 * Admin views render a single card grid with no "show more" affordance
 * today. Matches the historical default `listApps` used before the
 * options-object refactor so admin behavior is unchanged. When the
 * admin UI grows pagination, consume `nextCursor` here too.
 */
const ADMIN_LIST_PAGE_SIZE = 50;

/**
 * Fetch a user's apps — delegates to `listApps`.
 *
 * Separated so the app list can stream independently via Suspense.
 * Returns the flattened `AppSummary[]` (not `ListAppsResult`) because
 * the admin surface has no pagination UI and `AdminUserDetailResponse`
 * exposes apps as a plain array.
 */
export async function getAdminUserApps(userId: string): Promise<AppSummary[]> {
	const { apps } = await listApps(userId, {
		limit: ADMIN_LIST_PAGE_SIZE,
		sort: "updated_desc",
	});
	return apps;
}

/**
 * Fetch a single user's profile, usage history, apps, credit balance, and
 * grant audit trail.
 *
 * Convenience wrapper that calls the four independent functions in parallel.
 * Used by the admin API route; the RSC page uses the individual functions
 * directly for granular Suspense streaming.
 */
export async function getAdminUserDetail(
	userId: string,
): Promise<AdminUserDetailResponse | null> {
	const [user, usage, apps, creditsData] = await Promise.all([
		getAdminUserProfile(userId),
		getAdminUserUsage(userId),
		getAdminUserApps(userId),
		getAdminUserCredits(userId),
	]);

	if (!user) return null;
	return { user, usage, apps, ...creditsData };
}
