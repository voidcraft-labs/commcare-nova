import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";

import { Spinner } from "@/components/shadcn/spinner";
import { cn } from "@/lib/utils";

/**
 * Small status / metadata chip: a full pill of soft, BORDERLESS color:
 * a pool of tint rather than an outlined chip (nothing machined, nothing
 * doubled up against card borders). Violet is the neutral accent;
 * emerald / amber / rose carry semantic state. Amber means warning /
 * recovering ("Trying again"), never in-progress: working states pass
 * `working` for the quiet violet spinner instead.
 *
 * Badge text: sentence case, no punctuation. Interactive badges
 * (rendered as a link or button) lift one step toward light on hover.
 */
const badgeVariants = cva(
	"group/badge inline-flex h-[22px] w-fit shrink-0 items-center justify-center gap-1.5 rounded-4xl px-2.5 text-xs leading-none font-medium whitespace-nowrap transition-colors focus-visible:shadow-(--focus-ring) [&>svg]:pointer-events-none [&>svg]:size-3!",
	{
		variants: {
			variant: {
				muted:
					"bg-white/[0.06] text-nova-text-secondary [a&]:hover:bg-white/[0.11] [button&]:hover:bg-white/[0.11]",
				violet:
					"bg-nova-violet/[0.16] text-nova-violet-bright [a&]:hover:bg-nova-violet/[0.26] [button&]:hover:bg-nova-violet/[0.26]",
				emerald:
					"bg-nova-emerald/[0.16] text-nova-emerald [a&]:hover:bg-nova-emerald/[0.26] [button&]:hover:bg-nova-emerald/[0.26]",
				amber:
					"bg-nova-amber/[0.16] text-nova-amber [a&]:hover:bg-nova-amber/[0.26] [button&]:hover:bg-nova-amber/[0.26]",
				rose: "bg-nova-rose/[0.16] text-nova-rose [a&]:hover:bg-nova-rose/[0.26] [button&]:hover:bg-nova-rose/[0.26]",
			},
		},
		defaultVariants: {
			variant: "muted",
		},
	},
);

function Badge({
	className,
	variant = "muted",
	working = false,
	children,
	render,
	...props
}: useRender.ComponentProps<"span"> &
	VariantProps<typeof badgeVariants> & {
		/** Quiet violet spinner for in-progress states ("Generating"). */
		working?: boolean;
	}) {
	return useRender({
		defaultTagName: "span",
		props: mergeProps<"span">(
			{
				className: cn(badgeVariants({ variant }), className),
				children: (
					<>
						{working && (
							<Spinner className="size-[11px] text-nova-violet-bright" />
						)}
						{children}
					</>
				),
			},
			props,
		),
		render,
		state: {
			slot: "badge",
			variant,
		},
	});
}

export { Badge, badgeVariants };
