/**
 * The CommCare Nova logo: the "first light sphere" logomark + the
 * lowercase wordmark. The mark is a dusk world whose limb catches first
 * light: a violet energy ring warming to dawn at the lower right, with
 * the sphere's own edge lit to match. The wordmark is two-tone, no
 * gradient: "commcare" in the text tier, "nova" in violet-bright.
 *
 * At rest the dawn WIDENS and narrows along the limb, the way a sunrise
 * lamp comes up: nothing moves, resizes, spins, or blinks, and the
 * standby state never fades the mark out. Pointing at it is the rim's
 * job instead, and only where the lockup is genuinely a link or a
 * button. All of it is CSS, and it lives in `globals.css` beside the
 * keyframes, because none of it is per-call-site and half of it is a
 * hover state this component cannot see. `animate={false}` stops the
 * standby wave; the reduced-motion preference is handled globally.
 *
 * The flattened sibling, a violet body with a bold dawn crescent, is the
 * mark below `FULL_MARK_MIN`: two flat shapes that still read at 16px,
 * and the form the favicon is exported from. The size picks it, because
 * the choice is a property of how much room the sphere has and not
 * something each call site should have to remember; `variant="flat"`
 * forces it at any size (a light background, a print sheet).
 *
 * Alignment: the mark's box is centered on the lowercase ink band, which
 * sits 0.132em below the line-box center in Outfit bold (baseline at
 * 0.875em with line-height 1, minus half the 0.486em x-height); the
 * translateY carries that offset, bounded so the mark stays inside the
 * line box it is set in.
 */

const MARK_DISC_SHADOW =
	"inset -0.06em -0.09em 0.15em -0.02em var(--nova-dawn),inset -0.02em -0.03em 0.04em -0.01em #fbd0bf,inset 0.07em 0.1em 0.2em -0.02em rgba(150,120,242,0.55),0 0.07em 0.3em -0.05em rgba(245,176,165,0.45)";
const MARK_FLAT =
	"radial-gradient(ellipse 50% 50% at 37% 34%,var(--nova-violet) 0 99%,rgba(150,120,242,0) 100%),var(--nova-dawn)";

/**
 * One lockup, five sizes. Four of them hold the illustration's proportion,
 * where the wordmark is ~1.3× the mark's diameter and the gap ~0.35×.
 *
 * `chrome` is the app's own header, and it inverts that proportion on purpose.
 * The mark is 44px because that is the control band every other header control
 * stands in, and the wordmark does NOT come with it: scaled proportionally the
 * type would be 57px, which makes the lockup taller than the buttons beside it
 * and turns the header into a title card. Here the sphere is the brand and the
 * word is its label, so the type stays near its reading size and the lockup is
 * exactly as tall as a button.
 */
const SIZES = {
	sm: { font: 18, mark: 14, gap: 5 },
	md: { font: 20, mark: 15, gap: 5 },
	lg: { font: 30, mark: 23, gap: 8 },
	hero: { font: 48, mark: 37, gap: 13 },
	chrome: { font: 32, mark: 44, gap: 12 },
} as const;

/**
 * The diameter below which the sphere stops being the sphere.
 *
 * The mark's detail is a blurred energy ring over a lit limb, and it needs
 * room: the brand guideline draws the flattened sibling for "favicons,
 * avatars, and anything under 32px". That is the same reason the favicon is
 * flat, so a 14px full sphere in a header is the favicon's argument used
 * against it.
 */
const FULL_MARK_MIN = 32;

export function Logo({
	size = "md",
	variant,
	animate = true,
	markOnly = false,
}: {
	size?: keyof typeof SIZES;
	/** Force the flattened crescent where the size alone wouldn't: a light
	 * background, a print sheet. Omit and the size decides. */
	variant?: "flat";
	/** Stills the breathing (print, dense UI). */
	animate?: boolean;
	/** Keep the mark when a wordmark cannot fit. The surrounding control must
	 * provide its accessible name. */
	markOnly?: boolean;
}) {
	const s = SIZES[size];
	const flat = variant === "flat" || s.mark < FULL_MARK_MIN;
	/* The lockup aligns on the lowercase INK, never on the two boxes: the ink
	 * band sits 0.132em below the text box's center, so centering the boxes
	 * leaves the mark visibly high. Move whichever box has the room. The mark
	 * drops when the type is the taller of the two; the type rises when the
	 * mark is. Moving the wrong one carries it outside the lockup, which is how
	 * a 44px mark ends up hanging below the header row it belongs to. */
	const inkOffset = `${(0.132 * s.font).toFixed(1)}px`;
	const markDrops = s.mark < s.font;

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
			{/* `fontSize` is the mark's own diameter, so every layer of the
			    mark (the limb light, the dawn bloom, the disc's lit edge)
			    sizes itself in `em` against the SPHERE rather than against
			    the word beside it. Without it a 44px mark next to 32px type
			    lights its edge as if it were 32px across. */}
			<span
				className={`relative shrink-0 ${animate ? "nova-logo-waving" : ""}`}
				style={{
					width: s.mark,
					height: s.mark,
					fontSize: s.mark,
					transform:
						markOnly || !markDrops ? undefined : `translateY(${inkOffset})`,
				}}
			>
				{flat ? (
					<span
						className="absolute inset-0 rounded-full"
						style={{ background: MARK_FLAT }}
					/>
				) : (
					<>
						{/* Paint order is the order light arrives: the energy ring,
						    the dawn warming it, the hover highlight over both, and
						    the world's own body last, covering the middle so only
						    the limb shows. Each layer's appearance lives in
						    `globals.css`, which is also where the standby wave and
						    the hover rim are defined. */}
						<span className="nova-logo-rim" />
						<span className="nova-logo-dawn" />
						<span className="nova-logo-pulse" />
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
			{/* One lockup, one line: without this the two tones wrap onto
			    separate lines in a narrow header and the mark reads as a
			    stacked logo it is not. */}
			<span
				className={markOnly ? "sr-only" : "whitespace-nowrap"}
				style={{
					transform:
						markOnly || markDrops ? undefined : `translateY(-${inkOffset})`,
				}}
			>
				<span className="text-nova-text">commcare </span>
				<span className="text-nova-violet-bright">nova</span>
			</span>
		</div>
	);
}
