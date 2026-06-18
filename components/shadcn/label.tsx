"use client";

import type * as React from "react";

import { cn } from "@/lib/utils";

function Label({ className, ...props }: React.ComponentProps<"label">) {
	return (
		// The Label primitive is a generic <label> wrapper consumers
		// attach to controls via `htmlFor`. Biome's noLabelWithoutControl
		// rule can't see across the consumer's JSX boundary to verify
		// the association; the contract lives at the call site.
		// biome-ignore lint/a11y/noLabelWithoutControl: htmlFor association is the consumer's responsibility; the primitive is purpose-built to be paired by id
		<label
			data-slot="label"
			className={cn(
				"flex items-center gap-2 text-sm leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-40",
				className,
			)}
			{...props}
		/>
	);
}

export { Label };
