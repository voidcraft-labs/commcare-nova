/**
 * The CommCare Nova logo: the "first light sphere" logomark + the
 * lowercase wordmark. The mark is a dusk world whose limb catches first
 * light — a violet energy ring warming to dawn at the lower right,
 * softly breathing (light waxes and wanes; nothing moves, nothing
 * pings) — with the sphere's own edge lit to match. The wordmark is
 * two-tone, no gradient: "commcare" in the text tier, "nova" in
 * violet-bright.
 *
 * `variant="flat"` swaps in the flattened sibling — a violet body with a
 * bold dawn crescent, two flat shapes that survive 16px — for tiny
 * contexts (the favicon is exported from this variant).
 *
 * Alignment: the mark's box is centered on the lowercase ink band, which
 * sits 0.132em below the line-box center in Outfit bold (baseline at
 * 0.875em with line-height 1, minus half the 0.486em x-height); the
 * translateY carries that offset.
 */

const MARK_ENERGY =
	"conic-gradient(from 0deg,#7c5fd0 0deg,var(--nova-violet) 92deg,var(--nova-dawn) 130deg,#fbd0bf 147deg,var(--nova-dawn) 164deg,#8a6ce0 225deg,#b6a0fb 315deg,#7c5fd0 360deg)";
const MARK_MASK =
	"radial-gradient(circle closest-side,transparent 62%,#000 74%,#000 80%,transparent 90%)";
const MARK_DISC_SHADOW =
	"inset -0.06em -0.09em 0.15em -0.02em var(--nova-dawn),inset -0.02em -0.03em 0.04em -0.01em #fbd0bf,inset 0.07em 0.1em 0.2em -0.02em rgba(150,120,242,0.55),0 0.07em 0.3em -0.05em rgba(245,176,165,0.45)";
const MARK_FLAT =
	"radial-gradient(ellipse 50% 50% at 37% 34%,var(--nova-violet) 0 99%,rgba(150,120,242,0) 100%),var(--nova-dawn)";

const SIZES = {
	sm: { font: 18, mark: 14, gap: 5 },
	md: { font: 20, mark: 15, gap: 5 },
	lg: { font: 30, mark: 23, gap: 8 },
	hero: { font: 48, mark: 37, gap: 13 },
} as const;

export function Logo({
	size = "md",
	variant = "full",
	animate = true,
	markOnly = false,
}: {
	size?: "sm" | "md" | "lg" | "hero";
	/** `flat` = the crescent mark that survives tiny or light contexts. */
	variant?: "full" | "flat";
	/** Stills the breathing (print, dense UI). */
	animate?: boolean;
	/** Keep the recognizable mark when a wordmark cannot fit. The
	 * surrounding control must provide its accessible name. */
	markOnly?: boolean;
}) {
	const s = SIZES[size];
	const mark = markOnly ? Math.round(s.mark * 1.15) : s.mark;
	const flat = variant === "flat";

	return (
		<div
			className="inline-flex items-center font-display font-bold"
			style={{
				gap: s.gap,
				fontSize: s.font,
				letterSpacing: "-0.02em",
				lineHeight: 1,
			}}
		>
			<span
				className="relative shrink-0"
				style={{
					width: mark,
					height: mark,
					transform: markOnly
						? undefined
						: `translateY(${(0.132 * s.font).toFixed(1)}px)`,
				}}
			>
				{flat ? (
					<span
						className="absolute inset-0 rounded-full"
						style={{ background: MARK_FLAT }}
					/>
				) : (
					<>
						<span
							className={`absolute inset-0 rounded-full opacity-80 ${
								animate
									? "animate-[nova-logo-breathe_var(--duration-breathe)_ease-in-out_infinite]"
									: ""
							}`}
							style={{
								background: MARK_ENERGY,
								WebkitMaskImage: MARK_MASK,
								maskImage: MARK_MASK,
								filter: `blur(${(mark * 0.045).toFixed(1)}px)`,
							}}
						/>
						<span
							className="absolute rounded-full"
							style={{
								inset: "12%",
								background: "#2b2149",
								boxShadow: MARK_DISC_SHADOW,
							}}
						/>
					</>
				)}
			</span>
			<span className={markOnly ? "sr-only" : undefined}>
				<span className="text-nova-text">commcare </span>
				<span className="text-nova-violet-bright">nova</span>
			</span>
		</div>
	);
}
