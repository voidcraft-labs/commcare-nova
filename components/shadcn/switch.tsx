"use client";

import { Switch as SwitchPrimitive } from "@base-ui/react/switch";

import { cn } from "@/lib/utils";

/**
 * The switch, one size: a 44px hit area (the one control height:
 * button = input = toggle) around a lighter 32px visible track, so the
 * solid pill doesn't outweigh bordered fields of the same height. The
 * track is drawn as a `before:` pseudo so the hit area stays honest.
 *
 * "On" wears the primary button's action fill (`--nova-action`) with a
 * dusk thumb: the thumb is the "ink" on the lit fill, same as button
 * text. Off: deep track, muted thumb. Hover lifts one step toward light
 * (never dims); disabled dims to the one 0.6 opacity with hover gated
 * off and keeps pointer events for the not-allowed cursor.
 */
function Switch({
	className,
	...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>) {
	return (
		<SwitchPrimitive.Root
			data-slot="switch"
			className={cn(
				"peer group/switch relative inline-flex h-11 w-[58px] shrink-0 cursor-pointer items-center rounded-full outline-none",
				"before:absolute before:top-1/2 before:left-0 before:h-8 before:w-[58px] before:-translate-y-1/2 before:rounded-full before:border before:border-white/[0.08] before:bg-nova-deep before:transition-colors",
				"not-disabled:hover:before:border-white/[0.16] not-disabled:hover:before:bg-nova-surface",
				"data-[checked]:before:border-transparent data-[checked]:before:bg-nova-action data-[checked]:not-disabled:hover:before:bg-nova-action-hover",
				"focus-visible:before:border-nova-ring focus-visible:before:shadow-(--focus-ring)",
				"disabled:cursor-not-allowed disabled:opacity-(--disabled-opacity)",
				className,
			)}
			{...props}
		>
			<SwitchPrimitive.Thumb
				data-slot="switch-thumb"
				className={cn(
					"pointer-events-none relative z-ground block size-6 translate-x-1 rounded-full bg-nova-text-muted shadow-sm transition-[transform,background-color]",
					"group-not-disabled/switch:group-hover/switch:bg-nova-text-secondary",
					// Travel: 4px inset off → 28px on (58 − 24 − 4 − 2px border).
					"data-[checked]:translate-x-7 data-[checked]:bg-nova-action-ink data-[checked]:group-not-disabled/switch:group-hover/switch:bg-nova-action-ink",
				)}
			/>
		</SwitchPrimitive.Root>
	);
}

export { Switch };
