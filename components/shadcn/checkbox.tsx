"use client";

import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { Icon } from "@iconify/react/offline";
import tablerCheck from "@iconify-icons/tabler/check";

import { cn } from "@/lib/utils";

function Checkbox({ className, ...props }: CheckboxPrimitive.Root.Props) {
	return (
		<CheckboxPrimitive.Root
			data-slot="checkbox"
			className={cn(
				// Checked = violet, matching the Switch — violet is the theme's
				// selected-state accent (the white glyph is a graphical object, so
				// 4.23:1 on violet clears the 3:1 non-text bar).
				"peer relative flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-[4px] border border-input bg-nova-deep transition-colors outline-none group-has-disabled/field:opacity-40 after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-40 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 data-checked:border-nova-violet/60 data-checked:bg-nova-violet data-checked:text-white",
				className,
			)}
			{...props}
		>
			<CheckboxPrimitive.Indicator
				data-slot="checkbox-indicator"
				className="grid place-content-center text-current transition-none [&>svg]:size-3.5"
			>
				<Icon icon={tablerCheck} />
			</CheckboxPrimitive.Indicator>
		</CheckboxPrimitive.Root>
	);
}

export { Checkbox };
