"use client";
import { Icon } from "@iconify/react/offline";
import { type FieldKind, fieldRegistry } from "@/lib/domain";

interface FieldTypeListProps {
	/** The conversion targets to display. */
	types: ReadonlyArray<FieldKind>;
	/** The current kind — highlighted so the user knows what they're converting from. */
	activeType?: FieldKind;
	onSelect: (kind: FieldKind) => void;
}

/** Single-column list for converting a question to a sibling type.
 *  Surface styling (background, border, shadow) comes from the parent
 *  Menu.Positioner — this component only renders the item rows.
 *  Conversion targets are always a short list (1–3 items), so a
 *  compact vertical layout fits better than a categorised menu.
 *
 *  Icon + label come from `fieldRegistry[kind]` — the domain-owned
 *  metadata registry. No parallel maps. */
export function FieldTypeList({
	types,
	activeType,
	onSelect,
}: FieldTypeListProps) {
	return (
		<div className="overflow-hidden">
			{types.map((type) => {
				const meta = fieldRegistry[type];
				const isActive = type === activeType;
				return (
					<button
						type="button"
						key={type}
						onClick={() => onSelect(type)}
						className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm transition-colors cursor-pointer ${
							isActive
								? "text-nova-violet-bright bg-nova-violet/10"
								: "text-nova-text hover:bg-white/[0.06]"
						}`}
					>
						<Icon
							icon={meta.icon}
							width="16"
							height="16"
							className={
								isActive ? "text-nova-violet-bright" : "text-nova-text-muted"
							}
						/>
						<span>{meta.label}</span>
					</button>
				);
			})}
		</div>
	);
}
