/** Server-rendered stat card: pure markup, no client JS. */
export function StatCard({
	label,
	value,
	subtitle,
}: {
	label: string;
	value: string;
	subtitle?: string;
}) {
	return (
		<div className="bg-nova-surface border border-nova-border rounded-lg p-6">
			<p className="text-xs font-medium text-nova-text-secondary mb-1">
				{label}
			</p>
			<p className="text-3xl font-display font-semibold tracking-tighter text-nova-text">
				{value}
			</p>
			{subtitle && (
				<p className="text-xs text-nova-text-muted mt-1">{subtitle}</p>
			)}
		</div>
	);
}
