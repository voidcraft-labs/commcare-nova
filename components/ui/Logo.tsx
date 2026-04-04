export function Logo({ size = "md" }: { size?: "sm" | "md" | "lg" | "hero" }) {
	const textSizes = {
		sm: "text-lg",
		md: "text-xl",
		lg: "text-3xl",
		hero: "text-5xl",
	};

	const dotSizes = {
		sm: "w-2 h-2",
		md: "w-2 h-2",
		lg: "w-3 h-3",
		hero: "w-4 h-4",
	};

	const gaps = {
		sm: "gap-2",
		md: "gap-2",
		lg: "gap-2.5",
		hero: "gap-3.5",
	};

	return (
		<div
			className={`${textSizes[size]} font-display font-bold tracking-tight flex items-center ${gaps[size]}`}
		>
			<div className={`relative ${dotSizes[size]} shrink-0`}>
				<div className={`${dotSizes[size]} rounded-full bg-nova-violet`} />
				<div
					className={`absolute inset-0 ${dotSizes[size]} rounded-full bg-nova-violet animate-ping opacity-30 motion-reduce:hidden`}
				/>
			</div>
			<span className="bg-gradient-to-r from-nova-text to-nova-violet-bright bg-clip-text text-transparent [text-box:trim-both_ex_alphabetic]">
				commcare nova
			</span>
		</div>
	);
}
