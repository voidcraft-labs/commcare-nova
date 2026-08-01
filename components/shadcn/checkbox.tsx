"use client";

import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { Icon } from "@iconify/react/offline";
import tablerCheck from "@iconify-icons/tabler/check";

import { cn } from "@/lib/utils";

function Checkbox({ className, ...props }: CheckboxPrimitive.Root.Props) {
	return (
		<CheckboxPrimitive.Root
			data-slot="checkbox"
			// Checked wears the action fill with a dusk glyph, matching the
			// Switch — in Nova light is action, and no fill carries white ink.
			// The `after:` inset stretches the pointer target to the 44px floor
			// around the 16px visual box.
			className={cn(
				"nova-focusable peer relative flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-[4px] border border-input bg-nova-deep transition-colors outline-none group-has-disabled/field:opacity-(--disabled-opacity) after:absolute after:-inset-x-3.5 after:-inset-y-3.5 disabled:cursor-not-allowed disabled:opacity-(--disabled-opacity) aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-checked:border-transparent data-checked:bg-nova-action data-checked:text-nova-action-ink not-disabled:data-checked:hover:bg-nova-action-hover",
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
