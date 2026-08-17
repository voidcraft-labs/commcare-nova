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
 * translateY carries that offset on whichever box is the shorter of the
 * two. A transform moves paint, not layout, so on a rung where mark and
 * type are nearly the same height (hero) the few pixels of drop that
 * land past the line box widen nothing.
 *
 * The `chrome` rung alone has a wordmark that comes and goes, so it alone
 * sets the word in a collapsing track: it joins the sphere where the header
 * row can hold the whole lockup, and it is drawn INTO the sphere when a
 * build starts. Every other rung is a fixed lockup whose word is either
 * rendered or, under `markOnly`, left to a screen reader.
 */

const MARK_DISC_SHADOW =
	"inset -0.06em -0.09em 0.15em -0.02em var(--nova-dawn),inset -0.02em -0.03em 0.04em -0.01em #fbd0bf,inset 0.07em 0.1em 0.2em -0.02em rgba(150,120,242,0.55),0 0.07em 0.3em -0.05em rgba(245,176,165,0.45)";
const MARK_FLAT =
	"radial-gradient(ellipse 50% 50% at 37% 34%,var(--nova-violet) 0 99%,rgba(150,120,242,0) 100%),var(--nova-dawn)";

/**
 * One lockup, five sizes. The three flat rungs hold the illustration's
 * proportion, where the wordmark is ~1.3× the mark's diameter and the gap
 * ~0.35×.
 *
 * The full sphere has ONE diameter. `chrome` set it: the mark is 44px because
 * that is the control band every other header control stands in. `hero`
 * matches it rather than scaling, because the sphere is the brand object, and
 * the landing page and the header should show the same world, not two sizes
 * of it. Neither rung scales the wordmark with the sphere, for two different
 * reasons. In chrome, proportional type would be 57px, which makes the lockup
 * taller than the buttons beside it and turns the header into a title card:
 * the sphere is the brand and the word is its label, so the type stays near
 * its reading size and the lockup is exactly as tall as a button. In hero,
 * proportional type would be 56px, and a 56px wordmark plus the sphere and
 * gap measures ~457px against the landing column's 400: the word keeps its
 * 48px display size and the whole lockup fits.
 */
const SIZES = {
	sm: { font: 18, mark: 14, gap: 5 },
	md: { font: 20, mark: 15, gap: 5 },
	lg: { font: 30, mark: 23, gap: 8 },
	hero: { font: 48, mark: 44, gap: 13 },
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
	absorbing = false,
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
	/** Play the handoff once: the sphere answers the word's arrival with the
	 * swell it gives the pointer. Set it in the same commit that sets
	 * `markOnly`, and clear it when the animation ends. `chrome` only. */
	absorbing?: boolean;
}) {
	const s = SIZES[size];
	const flat = variant === "flat" || s.mark < FULL_MARK_MIN;
	/* The header rung is the only one whose word travels, so it is the only one
	 * that pays for a collapsing track. `size` decides it for the same reason it
	 * decides the flattened sibling: it is a property of the room the lockup has,
	 * not something each call site should have to remember. */
	const inChrome = size === "chrome";
	/* The lockup aligns on the lowercase INK, never on the two boxes: the ink
	 * band sits 0.132em below the text box's center, so centering the boxes
	 * leaves the mark visibly high. Move whichever box is the shorter of the
	 * two. The mark drops when the type is the taller; the type rises when the
	 * mark is. Moving the wrong one carries it outside the lockup, which is how
	 * a 44px mark ends up hanging below the header row it belongs to. */
	const inkOffset = `${(0.132 * s.font).toFixed(1)}px`;
	const markDrops = s.mark < s.font;

	const word = (
		<>
			<span className="text-nova-text">commcare </span>
			<span className="text-nova-violet-bright">nova</span>
		</>
	);

	return (
		<div
			className={`inline-flex items-center font-display font-bold${
				inChrome ? " nova-logo-chrome" : ""
			}`}
			data-mark-only={markOnly || undefined}
			data-absorbing={absorbing || undefined}
			style={{
				/* In chrome the gap rides INSIDE the collapsing track (see below), so
				 * it leaves with the word rather than holding a dead 12px open beside
				 * a lone sphere. */
				gap: inChrome ? undefined : s.gap,
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
						{/* Paint order matters, and the dawn's place in it is the
						    whole difference between a halo and a crescent. The
						    energy ring and the hover highlight sit OUTSIDE the
						    body and are painted under it, so the body hides their
						    middles and leaves a lit limb. The dawn is painted
						    LAST, over the body, because it belongs inside the
						    world the way the flattened sibling's crescent does.
						    Under the body it would only ever show as the spill
						    past the edge, which is a halo around the sphere and
						    not first light on it. Each layer's appearance, the
						    standby wave, and the hover rim all live in
						    `globals.css`. */}
						<span className="nova-logo-rim" />
						<span className="nova-logo-pulse" />
						<span
							className="absolute rounded-full"
							style={{
								inset: "12%",
								background: "#2b2149",
								boxShadow: MARK_DISC_SHADOW,
							}}
						/>
						<span className="nova-logo-dawn" />
					</>
				)}
			</span>
			{/* One lockup, one line: without this the two tones wrap onto
			    separate lines in a narrow header and the mark reads as a
			    stacked logo it is not.

			    In chrome the word is set in a track that collapses to zero rather
			    than swapped for `sr-only`: `sr-only` takes the word out of layout
			    in one frame, and the whole point here is that it TRAVELS. The
			    clip's padding carries the gap so both leave together, and the
			    three spans each do one job (track, clip, ink offset) because a
			    single element cannot hold a collapsing width, an overflow clip,
			    and two transforms at once. */}
			{inChrome ? (
				<span className="nova-logo-word">
					<span className="nova-logo-word-clip">
						{/* The gap is padding on the TEXT, never on the clip. A clipped
						    box is still at least as wide as its own padding, so a gap
						    spelled one level out survives the collapse as 12px of dead
						    air beside a lone sphere. */}
						<span
							className="block whitespace-nowrap"
							style={{
								paddingLeft: s.gap,
								transform: markDrops ? undefined : `translateY(-${inkOffset})`,
							}}
						>
							{word}
						</span>
					</span>
				</span>
			) : (
				<span
					className={markOnly ? "sr-only" : "whitespace-nowrap"}
					style={{
						transform:
							markOnly || markDrops ? undefined : `translateY(-${inkOffset})`,
					}}
				>
					{word}
				</span>
			)}
		</div>
	);
}
