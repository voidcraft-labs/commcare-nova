/**
 * Admin data queries — shared between API routes and RSC pages.
 *
 * Reads the user list from `auth_user` via Kysely (the shared `getAuthDb`)
 * rather than Better Auth's admin API (`listUsers`/`getUser`) because those
 * return `UserWithRole`, which doesn't include `additionalFields` (our
 * `lastActiveAt`) in its TypeScript types. The per-user usage / credits / apps
 * figures come from the app-state tables via `getAppDb`. Both handles ride the
 * same Cloud SQL pool, but this is still a per-user FAN-OUT (one set of reads
 * per user), NOT a single SQL join across them.
 */

import type {
	AdminStats,
	AdminUserDetailResponse,
	AdminUserRow,
	AdminUsersResponse,
	CreditGrantAudit,
	UsagePeriod,
} from "@/lib/admin/types";
import { getAuthDb } from "../auth/db";
import { type AppSummary, listAppsByOwner } from "./apps";
import {
	type CreditSummary,
	getCreditSummary,
	listCreditGrants,
} from "./credits";
import { getCurrentPeriod } from "./period";
import { getAppDb } from "./pg";

// ── Date helper ──────────────────────────────────────────────────────

/** To an ISO string — every timestamp here comes back from Kysely as a `Date`. */
function toISOString(val: Date): string {
	return val.toISOString();
}

// ── Queries ──────────────────────────────────────────────────────────

/**
 * Fetch all users with current-month usage, lifetime cost, credit balances,
 * and app counts.
 *
 * Reads from three sources per user, fanned out via Promise.all:
 * - `auth_user` — profile, role, activity timestamps (Kysely read)
 * - `credit_months` + `usage_months` — full per-user month reads for the credit
 *   figures and lifetime/current cost. We read EVERY usage month (not just the
 *   current-period row) because the lifetime cost sum needs all of them anyway —
 *   reading the current row separately would pay for it twice. `getCreditSummary`
 *   similarly reads every credit month to compute `lifetimeConsumed`.
 * - `apps` — a per-user live app count
 *
 * O(users) per-user reads is accepted at current scale — the same shape as the
 * per-user app-count fan-out this function already ran.
 */
export async function getAdminUsersWithStats(): Promise<AdminUsersResponse> {
	const authDb = await getAuthDb();
	const appDb = await getAppDb();
	const allUsers = await authDb
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
	 * and the live app count — each in parallel across all users. */
	const enriched: AdminUserRow[] = await Promise.all(
		allUsers.map(async (user) => {
			const [creditSummary, usageMonths, appCountRow] = await Promise.all([
				/* Credit summary reads every credit-month row to compute
				 * lifetimeConsumed and the current-period balance in one pass. */
				getCreditSummary(user.id),
				/* Every usage month — needed for the lifetime cost sum; the
				 * current-period figures are picked out of the same rows. */
				appDb
					.selectFrom("usage_months")
					.select(["period", "request_count", "cost_estimate"])
					.where("user_id", "=", user.id)
					.execute(),
				/* Live app count: `owner`-scoped, `deleted_at IS NULL` so
				 * soft-deleted rows don't inflate the admin view. */
				appDb
					.selectFrom("apps")
					.select((eb) => eb.fn.countAll<string>().as("count"))
					.where("owner", "=", user.id)
					.where("deleted_at", "is", null)
					.executeTakeFirst(),
			]);

			const currentUsage = usageMonths.find((m) => m.period === period);
			const cost_lifetime = usageMonths.reduce(
				(sum, m) => sum + (m.cost_estimate ?? 0),
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
				app_count: Number(appCountRow?.count ?? 0),
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
	const [credits, grantRows] = await Promise.all([
		getCreditSummary(userId),
		listCreditGrants(userId),
	]);

	const grants: CreditGrantAudit[] = grantRows.map((grant) => ({
		amount: grant.amount,
		type: grant.type,
		/* `actor` uid is intentionally omitted — the admin email is the
		 * human-readable identity surfaced in the audit UI; the uid is
		 * an implementation detail the dashboard never needs. */
		actor_email: grant.actor_email,
		reason: grant.reason,
		period: grant.period,
		created_at: toISOString(grant.created_at),
	}));

	return { credits, grants };
}

/**
 * Fetch a user's usage history — all monthly usage periods, newest first.
 *
 * Reads both the usage months and the credit months in parallel, then joins
 * them by period so each `UsagePeriod` carries the matching credit figures when
 * they exist. Periods that predate the credit system have no credit row and
 * will have `credits_allowance`/`credits_consumed`/`credits_bonus` left
 * undefined.
 *
 * Separated so the usage table can stream independently via Suspense.
 */
export async function getAdminUserUsage(
	userId: string,
): Promise<UsagePeriod[]> {
	const appDb = await getAppDb();
	const [usageMonths, creditMonths] = await Promise.all([
		appDb
			.selectFrom("usage_months")
			.select([
				"period",
				"request_count",
				"input_tokens",
				"output_tokens",
				"cost_estimate",
			])
			.where("user_id", "=", userId)
			.orderBy("updated_at", "desc")
			.execute(),
		appDb
			.selectFrom("credit_months")
			.select(["period", "allowance", "consumed", "bonus"])
			.where("user_id", "=", userId)
			.execute(),
	]);

	/* Build a lookup map: period string → credit figures, for an O(1) join
	 * below. `allowance` rides along so the detail table can show the full
	 * credit standing (allowance / consumed / bonus / balance) per period —
	 * balance is derived in the render from these three, never stored. */
	const creditByPeriod = new Map<
		string,
		{ allowance: number; consumed: number; bonus: number }
	>(
		creditMonths.map((month) => [
			month.period,
			{
				allowance: month.allowance,
				consumed: month.consumed,
				bonus: month.bonus,
			},
		]),
	);

	return usageMonths.map((month) => {
		const creditEntry = creditByPeriod.get(month.period);
		return {
			period: month.period,
			request_count: month.request_count,
			input_tokens: Number(month.input_tokens),
			output_tokens: Number(month.output_tokens),
			cost_estimate: month.cost_estimate,
			/* Only present when a credit row exists for this period. */
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
 * Fetch a user's apps — delegates to `listAppsByOwner`.
 *
 * Separated so the app list can stream independently via Suspense.
 * Returns the flattened `AppSummary[]` (not `ListAppsResult`) because
 * the admin surface has no pagination UI and `AdminUserDetailResponse`
 * exposes apps as a plain array.
 */
export async function getAdminUserApps(userId: string): Promise<AppSummary[]> {
	const { apps } = await listAppsByOwner(userId, {
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
