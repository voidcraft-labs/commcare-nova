"use client";
import { useId } from "react";
import { Switch } from "@/components/shadcn/switch";
import { PlatformNoteRow } from "../shared/PlatformNoteRow";

export function LocationSwitch({
	label,
	description,
	checked,
	disabled,
	active,
	onChange,
}: {
	label: string;
	description: string;
	checked: boolean;
	disabled?: boolean;
	active: boolean;
	onChange: (next: boolean) => void;
}) {
	const id = useId();
	return (
		<section className="border-t border-white/[0.06] pt-3">
			<label
				htmlFor={id}
				className="flex items-center gap-3 text-xs text-nova-text"
			>
				<span className="flex-1">{label}</span>
				<Switch
					id={id}
					aria-describedby={`${id}-help`}
					checked={checked}
					disabled={disabled}
					onCheckedChange={onChange}
				/>
			</label>
			<p id={`${id}-help`} className="mt-1 text-xs text-nova-text-muted">
				{description}
			</p>
			<PlatformNoteRow features={active ? ["connect-location-capture"] : []} />
		</section>
	);
}
