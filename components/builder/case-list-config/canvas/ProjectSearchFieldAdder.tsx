"use client";

import { useId, useState } from "react";
import { Button } from "@/components/shadcn/button";
import { Field, FieldLabel } from "@/components/shadcn/field";
import { Input } from "@/components/shadcn/input";

export function ProjectSearchFieldAdder({
	onAdd,
	onAddHidden,
	disabledReason,
}: {
	onAdd: (name: string, label: string) => boolean;
	onAddHidden: () => void;
	disabledReason?: string | undefined;
}) {
	const id = useId();
	const [open, setOpen] = useState(false);
	const [label, setLabel] = useState("");
	const [name, setName] = useState("");
	if (!open)
		return (
			<Button
				type="button"
				variant="ghost"
				data-case-add-search-field
				disabled={!!disabledReason}
				title={disabledReason}
				onClick={() => setOpen(true)}
			>
				Add search field
			</Button>
		);
	return (
		<div className="grid gap-2">
			<Field>
				<FieldLabel htmlFor={id + "-question"}>
					What does the worker see?
				</FieldLabel>
				<Input
					id={id + "-question"}
					value={label}
					onChange={(event) => setLabel(event.target.value)}
				/>
			</Field>
			<Field>
				<FieldLabel htmlFor={id + "-key"}>Name sent to the search</FieldLabel>
				<Input
					id={id + "-key"}
					value={name}
					onChange={(event) => setName(event.target.value)}
				/>
			</Field>
			<div className="flex flex-wrap gap-2">
				<Button
					type="button"
					variant="outline"
					disabled={!name.trim() || !label.trim() || !!disabledReason}
					onClick={() => {
						if (onAdd(name.trim(), label.trim())) {
							setName("");
							setLabel("");
							setOpen(false);
						}
					}}
				>
					Add field
				</Button>
				<Button
					type="button"
					variant="ghost"
					disabled={!!disabledReason}
					onClick={() => {
						onAddHidden();
						setOpen(false);
					}}
				>
					Add hidden value
				</Button>
				<Button type="button" variant="ghost" onClick={() => setOpen(false)}>
					Cancel
				</Button>
			</div>
		</div>
	);
}
