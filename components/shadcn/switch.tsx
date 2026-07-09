"use client";

import { Switch as SwitchPrimitive } from "@base-ui/react/switch";

import { cn } from "@/lib/utils";

function Switch({
	className,
	size = "default",
	...props
}: React.ComponentProps<typeof SwitchPrimitive.Root> & {
	/** `sm` is the sub-setting size — a nested option under a parent toggle. */
	size?: "default" | "sm";
}) {
	return (
		<SwitchPrimitive.Root
			data-slot="switch"
			data-size={size}
			className={cn(
				"peer group/switch inline-flex shrink-0 cursor-pointer items-center rounded-full border border-white/[0.08] bg-nova-deep transition-colors outline-none",
				"data-[size=default]:h-5 data-[size=default]:w-9 data-[size=sm]:h-4 data-[size=sm]:w-7",
				"focus-visible:ring-2 focus-visible:ring-nova-violet/40",
				"data-[checked]:border-nova-violet/60 data-[checked]:bg-nova-violet",
				"disabled:cursor-not-allowed disabled:opacity-40",
				className,
			)}
			{...props}
		>
			<SwitchPrimitive.Thumb
				data-slot="switch-thumb"
				className={cn(
					"pointer-events-none block translate-x-[3px] rounded-full bg-nova-text-muted shadow-sm transition-transform",
					// Checked offsets mirror the 3px unchecked inset inside the 1px
					// border: content width − thumb − 3 (34−14−3 and 26−10−3).
					"group-data-[size=default]/switch:size-3.5 group-data-[size=default]/switch:data-[checked]:translate-x-[17px]",
					"group-data-[size=sm]/switch:size-2.5 group-data-[size=sm]/switch:data-[checked]:translate-x-[13px]",
					"data-[checked]:bg-white",
				)}
			/>
		</SwitchPrimitive.Root>
	);
}

export { Switch };
