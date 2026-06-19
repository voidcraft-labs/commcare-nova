"use client";

import { Switch as SwitchPrimitive } from "@base-ui/react/switch";

import { cn } from "@/lib/utils";

function Switch({
	className,
	...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>) {
	return (
		<SwitchPrimitive.Root
			data-slot="switch"
			className={cn(
				"peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-white/[0.08] bg-nova-deep transition-colors outline-none",
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
					"pointer-events-none block size-3.5 translate-x-[3px] rounded-full bg-nova-text-muted shadow-sm transition-transform",
					"data-[checked]:translate-x-[19px] data-[checked]:bg-white",
				)}
			/>
		</SwitchPrimitive.Root>
	);
}

export { Switch };
