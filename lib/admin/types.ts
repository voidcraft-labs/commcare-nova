/**
 * Admin dashboard types — shared between API routes and client components.
 * All dates are ISO 8601 strings — consistent from Postgres through JSON to client.
 */
import type { AppSummary } from "@/lib/db/apps";
import type { CreditSummary } from "@/lib/db/credits";

/** A single row in the admin user table. */
export interface AdminUserRow {
	/** User UUID — used for navigation and Postgres lookups. */
	id: string;
	/** Email address — for display only. */
	email: string;
	name: string;
	image: string | null;
	role: "user" | "admin";
	created_at: string;
	last_active_at: string;
	/** Number of chat requests (generation runs) this month. */
	generations: number;
	/**
	 * This month's true dollar cost — tracked for tuning + the invisible backstop,
	 * no longer the user-facing gate.
	 */
	cost: number;
	/** Total number of saved apps. */
	app_count: number;
	/** Credits debited by this user in the current period. */
	credits_used: number;
	/** Spendable credits remaining in the current period (allowance + bonus − consumed). */
	credits_remaining: number;
	/** Total credits debited across every period the user has ever had a credit doc for. */
	credits_used_lifetime: number;
	/** Sum of `cost_estimate` across every usage period (all time). */
	cost_lifetime: number;
}

/** Headline statistics for the admin dashboard. */
export interface AdminStats {
	totalUsers: number;
	totalGenerations: number;
	totalSpend: number;
	/** The usage period these stats cover (e.g. "2026-04"). */
	period: string;
	/** Total credits consumed across all users for the current period. */
	totalCreditsConsumed: number;
}

/** Combined response from GET /api/admin/users. */
export interface AdminUsersResponse {
	users: AdminUserRow[];
	stats: AdminStats;
}

/** Per-month usage breakdown for the admin user detail view. */
export interface UsagePeriod {
	period: string;
	request_count: number;
	input_tokens: number;
	output_tokens: number;
	cost_estimate: number;
	/** Monthly credit allowance granted for this period — absent when the period predates the credit system. */
	credits_allowance?: number;
	/** Credits debited in this period — absent when the period predates the credit system. */
	credits_consumed?: number;
	/** Admin bonus credits applied in this period — absent when the period predates the credit system. */
	credits_bonus?: number;
}

/** One row of the admin credit-intervention audit trail (a reset or grant). */
export interface CreditGrantAudit {
	amount: number;
	type: "reset" | "grant";
	/** Human-readable acting admin email; the actor uid is intentionally not exposed. */
	actor_email: string;
	reason: string | null;
	period: string;
	/** ISO 8601 timestamp of when the intervention was recorded. */
	created_at: string;
}

/** JSON response from GET /api/admin/users/[id]. */
export interface AdminUserDetailResponse {
	user: {
		/** User UUID. */
		id: string;
		/** Email address — for display. */
		email: string;
		name: string;
		image: string | null;
		role: "user" | "admin";
		created_at: string;
		last_active_at: string;
	};
	usage: UsagePeriod[];
	apps: AppSummary[];
	/** Current-period credit balance and lifetime consumed — sourced from `getCreditSummary`. */
	credits: CreditSummary;
	/** Admin credit interventions for this user, newest first. */
	grants: CreditGrantAudit[];
}
