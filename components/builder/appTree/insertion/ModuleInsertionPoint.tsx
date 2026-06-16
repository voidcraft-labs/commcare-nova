// components/builder/appTree/insertion/ModuleInsertionPoint.tsx
//
// A hover-reveal "+" between modules in the app tree that opens the
// add-module popover, inserting at `atIndex` in `moduleOrder`.

"use client";
import { useState } from "react";
import { AddModulePopover } from "./AddModulePopover";
import { TreeInsertionAffordance } from "./TreeInsertionAffordance";

export function ModuleInsertionPoint({ atIndex }: { atIndex: number }) {
	const [open, setOpen] = useState(false);
	return (
		<TreeInsertionAffordance open={open}>
			<AddModulePopover atIndex={atIndex} open={open} onOpenChange={setOpen} />
		</TreeInsertionAffordance>
	);
}
