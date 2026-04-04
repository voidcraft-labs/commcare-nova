interface BadgeProps {
	variant?: "violet" | "emerald" | "amber" | "rose" | "muted";
	children: React.ReactNode;
	className?: string;
}

export function Badge({
	variant = "muted",
	children,
	className = "",
}: BadgeProps) {
	const variants = {
		violet: "bg-nova-violet/15 text-nova-violet-bright border-nova-violet/20",
		emerald: "bg-nova-emerald/15 text-nova-emerald border-nova-emerald/20",
		amber: "bg-nova-amber/15 text-nova-amber border-nova-amber/20",
		rose: "bg-nova-rose/15 text-nova-rose border-nova-rose/20",
		muted: "bg-nova-surface text-nova-text-secondary border-nova-border",
	};

	return (
		<span
			className={`inline-flex items-center px-2 py-0.5 text-xs font-medium rounded-md border ${variants[variant]} ${className}`}
		>
			{children}
		</span>
	);
}
