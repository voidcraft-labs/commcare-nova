import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * The action button. Buttons are soft KEYCAPS: a crown gradient lit from
 * above over a 3px darker side wall (`--key-wall`), with real travel on
 * press: the cap sinks as the wall collapses. The keycap anatomy
 * (crowns, walls, travel, hover brighten, keyboard-only focus ring,
 * disabled at the one 0.6 opacity) lives in the `.nova-keycap-*` classes
 * in `app/globals.css`; this file only picks a variant and lays out the
 * label.
 *
 * ONE size: 44px tall at radius-xl, the 44px hit-target floor IS the
 * button; there is no small/medium/large ladder. `size="icon"` is the
 * same 44px height as a square. A call-site className may set layout
 * (width, margin, grid placement), never height, padding, radius, color,
 * or shadow.
 *
 * Ghost and link stay text-only (no crown, no wall, a 1px press nudge),
 * which is exactly what makes the keycaps read as actionable next to
 * them. Disabled keeps pointer events so the not-allowed cursor can show;
 * every hover is gated off while disabled.
 */
const buttonVariants = cva(
	"group/button inline-flex h-11 shrink-0 cursor-pointer items-center justify-center gap-2 rounded-xl border border-transparent text-[15px] font-medium whitespace-nowrap transition-all outline-none select-none disabled:cursor-not-allowed disabled:opacity-(--disabled-opacity) aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
	{
		variants: {
			variant: {
				// The luminous lilac keycap with dusk text: light is action;
				// no fill carries white text.
				default: "nova-keycap nova-keycap-action",
				secondary: "nova-keycap nova-keycap-surface",
				// The quiet page-level action (the calm sibling of the primary
				// CTA): violet-wash crown on the bright border.
				outline: "nova-keycap nova-keycap-outline border-nova-border-bright",
				// Tinted rose keycap with rose text: calm, not alarming.
				destructive: "nova-keycap nova-keycap-rose",
				// Amber keycap, dusk text (light accents carry dark text).
				warning: "nova-keycap nova-keycap-amber",
				// Text-tier: foreground ladder secondary → text, 1px press nudge.
				ghost:
					"nova-focusable text-nova-text-secondary not-disabled:hover:bg-white/[0.06] not-disabled:hover:text-nova-text aria-expanded:bg-white/[0.06] aria-expanded:text-nova-text not-disabled:active:not-aria-[haspopup]:translate-y-px",
				link: "nova-focusable text-nova-violet-bright underline-offset-4 not-disabled:hover:underline not-disabled:active:translate-y-px",
			},
			size: {
				default: "px-5",
				// Square 44px hit target for icon-only buttons.
				icon: "size-11 px-0",
			},
		},
		defaultVariants: {
			variant: "default",
			size: "default",
		},
	},
);

/** `glow` upgrades the primary keycap's standing halo for hero CTAs. */
function Button({
	className,
	variant = "default",
	size = "default",
	glow = false,
	...props
}: ButtonPrimitive.Props &
	VariantProps<typeof buttonVariants> & { glow?: boolean }) {
	return (
		<ButtonPrimitive
			data-slot="button"
			className={cn(
				buttonVariants({ variant, size, className }),
				glow && "nova-keycap-glow",
			)}
			{...props}
		/>
	);
}

export { Button, buttonVariants };
