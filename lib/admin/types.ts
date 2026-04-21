/**
 * Admin dashboard types — shared between API routes and client components.
 * All dates are ISO 8601 strings — consistent from Firestore through JSON to client.
 */
import type { AppSummary } from "@/lib/db/apps";

/** A single row in the admin user table. */
export interface AdminUserRow {
	/** User UUID — used for navigation and Firestore lookups. */
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
	/** Estimated spend in USD this month. */
	cost: number;
	/** Total number of saved apps. */
	app_count: number;
}

/** Headline statistics for the admin dashboard. */
export interface AdminStats {
	totalUsers: number;
	totalGenerations: number;
	totalSpend: number;
	/** The usage period these stats cover (e.g. "2026-04"). */
	period: string;
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
}
