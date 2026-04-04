/**
 * Async server component — user usage history table.
 *
 * Fetches all monthly usage periods from Firestore and renders a data table.
 * Wrapped in a Suspense boundary by the parent page so it streams in
 * independently of the profile card and app list.
 */
import { getAdminUserUsage } from "@/lib/db/admin";
import type { UsagePeriod } from "@/lib/types/admin";
import {
	formatCurrency,
	formatPeriodLabel,
	formatTokenCount,
} from "@/lib/utils/format";

interface UserUsageSectionProps {
	email: string;
}

export async function UserUsageSection({ email }: UserUsageSectionProps) {
	const usage = await getAdminUserUsage(email);

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
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</section>
	);
}
