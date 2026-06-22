// components/preview/form/fields/geopoint/GeopointField.tsx
//
// Entry point for the geopoint field widget, dispatched from
// FieldRenderer. In edit (authoring) mode it renders a compact static
// card — the author is editing structure, not entering data, so mounting
// a live map per field would be wasteful. In preview/running mode it
// renders the full interactive picker (map + address search + geolocate).
//
// This mirrors MediaField's edit/preview split; the difference is that
// preview mode is now a real, working control rather than a "not
// available in preview" note.

"use client";
import { Icon } from "@iconify/react/offline";
import tablerMapPin from "@iconify-icons/tabler/map-pin";
import type { GeopointField as GeopointFieldEntity } from "@/lib/domain";
import type { FieldState } from "@/lib/preview/engine/types";
import { useEditMode } from "@/lib/session/hooks";
import { GeopointPicker } from "./GeopointPicker";
import { formatLatLonLabel, parseGeopoint } from "./geopointValue";

interface GeopointFieldProps {
	readonly field: GeopointFieldEntity;
	readonly state: FieldState;
	readonly onChange: (value: string) => void;
	readonly onBlur: () => void;
}

export function GeopointField({ state, onChange, onBlur }: GeopointFieldProps) {
	const isEdit = useEditMode() === "edit";

	if (isEdit) {
		// Authoring view: a cheap static card (no map — the author is editing
		// structure, not entering data). Just identifies the field; shows a
		// default coordinate if one is parseable. No "preview" qualifier — the
		// real picker simply renders when the form runs.
		const preset = parseGeopoint(state.value);
		return (
			<div className="flex items-center gap-3 rounded-lg border border-dashed border-pv-input-border bg-pv-surface px-4 py-3">
				<Icon
					icon={tablerMapPin}
					width="20"
					height="20"
					aria-hidden="true"
					className="text-nova-violet-bright"
				/>
				<span className="text-sm text-nova-text-muted">
					{preset ? `Location · ${formatLatLonLabel(preset)}` : "Location"}
				</span>
			</div>
		);
	}

	return (
		<GeopointPicker
			value={state.value}
			onChange={onChange}
			onBlur={onBlur}
			showError={state.touched && !state.valid}
			errorMessage={state.errorMessage}
		/>
	);
}
