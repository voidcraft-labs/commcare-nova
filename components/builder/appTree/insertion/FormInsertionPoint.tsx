// components/builder/appTree/insertion/FormInsertionPoint.tsx
//
// A hover-reveal "+" between forms inside a module that opens the add-form
// menu, inserting at `atIndex` in the module's `formOrder`.

"use client";
import { useState } from "react";
import type { Uuid } from "@/lib/domain";
import { AddFormMenu } from "./AddFormMenu";
import { TreeInsertionAffordance } from "./TreeInsertionAffordance";

export function FormInsertionPoint({
	moduleUuid,
	hasCaseType,
	atIndex,
}: {
	moduleUuid: Uuid;
	hasCaseType: boolean;
	atIndex: number;
}) {
	const [open, setOpen] = useState(false);
	return (
		<TreeInsertionAffordance open={open}>
			<AddFormMenu
				moduleUuid={moduleUuid}
				hasCaseType={hasCaseType}
				atIndex={atIndex}
				open={open}
				onOpenChange={setOpen}
			/>
		</TreeInsertionAffordance>
	);
}
