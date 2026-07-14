/**
 * Async server component — user usage history table.
 *
 * Fetches all monthly usage periods from Postgres and renders a data table.
 * Wrapped in a Suspense boundary by the parent page so it streams in
 * independently of the profile card and app list.
 */
import type { UsagePeriod } from "@/lib/admin/types";
import { getAdminUserUsage } from "@/lib/db/admin";
import {
	formatCurrency,
	formatPeriodLabel,
	formatTokenCount,
} from "@/lib/utils/format";

interface UserUsageSectionProps {
	userId: string;
}

export async function UserUsageSection({ userId }: UserUsageSectionProps) {
	const usage = await getAdminUserUsage(userId);

	// Lifetime totals are summed straight off the rows we already fetched — no
	// second query. Only the two figures that carry a meaningful all-time sum
	// are totalled: credits used (lifetime credit consumption) and cost
	// (lifetime dollar spend). Generations / tokens / bonus are per-period
	// detail with no useful lifetime aggregate, so their total cells stay blank.
	// `?? 0` coalesces the optional credit fields for periods that predate the
	// credit system, exactly as the per-row cells below do.
	const totalCreditsConsumed = usage.reduce(
		(sum, period) => sum + (period.credits_consumed ?? 0),
		0,
	);
	const totalCost = usage.reduce(
		(sum, period) => sum + period.cost_estimate,
		0,
	);

	return (
		<section>
			<h3 className="text-lg font-display font-semibold mb-4">Usage History</h3>
			{usage.length === 0 ? (
				<p className="text-sm text-nova-text-secondary">
					No usage recorded yet.
				</p>
			) : (
				<div className="rounded-xl border border-nova-border overflow-x-auto">
					<table className="w-full">
						<thead>
							<tr className="border-b border-nova-border bg-nova-deep/50">
								<th
									scope="col"
									className="px-4 py-3 text-left text-xs font-display font-semibold uppercase tracking-wide text-nova-text-secondary"
								>
									Period
								</th>
								<th
									scope="col"
									className="px-4 py-3 text-left text-xs font-display font-semibold uppercase tracking-wide text-nova-text-secondary"
								>
									Generations
								</th>
								<th
									scope="col"
									className="px-4 py-3 text-left text-xs font-display font-semibold uppercase tracking-wide text-nova-text-secondary"
								>
									Tokens (in / out)
								</th>
								<th
									scope="col"
									className="px-4 py-3 text-left text-xs font-display font-semibold uppercase tracking-wide text-nova-text-secondary"
								>
									Cost
								</th>
								{/* The four credit columns, in canonical order:
								    allowance → credits used → bonus → balance. Balance is
								    derived per row (allowance + bonus − consumed), never
								    stored. */}
								<th
									scope="col"
									className="px-4 py-3 text-left text-xs font-display font-semibold uppercase tracking-wide text-nova-text-secondary"
								>
									Allowance
								</th>
								<th
									scope="col"
									className="px-4 py-3 text-left text-xs font-display font-semibold uppercase tracking-wide text-nova-text-secondary"
								>
									Credits used
								</th>
								<th
									scope="col"
									className="px-4 py-3 text-left text-xs font-display font-semibold uppercase tracking-wide text-nova-text-secondary"
								>
									Bonus
								</th>
								<th
									scope="col"
									className="px-4 py-3 text-left text-xs font-display font-semibold uppercase tracking-wide text-nova-text-secondary"
								>
									Balance
								</th>
							</tr>
						</thead>
						<tbody>
							{usage.map((period: UsagePeriod) => (
								<tr
									key={period.period}
									className="border-b border-nova-border/50"
								>
									<td className="px-4 py-3 text-sm font-medium">
										{formatPeriodLabel(period.period)}
									</td>
									<td className="px-4 py-3 text-sm tabular-nums">
										{period.request_count}
									</td>
									<td className="px-4 py-3 text-sm text-nova-text-secondary tabular-nums">
										{formatTokenCount(period.input_tokens)} /{" "}
										{formatTokenCount(period.output_tokens)}
									</td>
									<td className="px-4 py-3 text-sm tabular-nums">
										{formatCurrency(period.cost_estimate)}
									</td>
									<td className="px-4 py-3 text-sm tabular-nums">
										{(period.credits_allowance ?? 0).toLocaleString()}
									</td>
									<td className="px-4 py-3 text-sm tabular-nums">
										{(period.credits_consumed ?? 0).toLocaleString()}
									</td>
									<td className="px-4 py-3 text-sm tabular-nums">
										{(period.credits_bonus ?? 0).toLocaleString()}
									</td>
									{/* Balance = allowance + bonus − consumed, derived here (not
									    stored). A period that predates the credit system has all
									    three absent, so the `?? 0` coalescing yields 0 — accurate
									    for a month with no credit doc. */}
									<td className="px-4 py-3 text-sm tabular-nums">
										{(
											(period.credits_allowance ?? 0) +
											(period.credits_bonus ?? 0) -
											(period.credits_consumed ?? 0)
										).toLocaleString()}
									</td>
								</tr>
							))}
							{/* Totals row — visually set apart by a heavier top border +
							    medium weight. Only the two figures with a meaningful
							    lifetime sum (credits used, cost) carry a value; the other
							    cells stay blank so the columns still line up. Allowance is a
							    per-month constant and balance doesn't sum meaningfully across
							    months, so both of their total cells stay blank too. */}
							<tr className="border-t-2 border-nova-border font-medium">
								<td className="px-4 py-3 text-sm">Total</td>
								<td className="px-4 py-3 text-sm" />
								<td className="px-4 py-3 text-sm" />
								<td className="px-4 py-3 text-sm tabular-nums">
									{formatCurrency(totalCost)}
								</td>
								<td className="px-4 py-3 text-sm" />
								<td className="px-4 py-3 text-sm tabular-nums">
									{totalCreditsConsumed.toLocaleString()}
								</td>
								<td className="px-4 py-3 text-sm" />
								<td className="px-4 py-3 text-sm" />
							</tr>
						</tbody>
					</table>
				</div>
			)}
		</section>
	);
}
