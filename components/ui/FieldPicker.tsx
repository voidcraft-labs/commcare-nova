/**
 * FieldPicker — shared Base UI Autocomplete for selecting form fields.
 *
 * Provides a searchable dropdown of form fields with kind icons and
 * labels. Reusable anywhere a user needs to reference a field by ID —
 * close conditions, future XPath field pickers, etc.
 *
 * Consumes the normalized doc directly (`fields` + `fieldOrder` maps).
 * The flat list of selectable entries comes from `collectFieldEntries`,
 * the same walker used by CodeMirror XPath autocomplete and TipTap
 * reference chips — so field lookups stay consistent across surfaces.
 */
"use client";
import { Autocomplete } from "@base-ui/react/autocomplete";
import { Icon } from "@iconify/react/offline";
import { useCallback, useMemo } from "react";
import { questionTypeIcons } from "@/lib/questionTypeIcons";
import {
	collectFieldEntries,
	type FieldEntrySource,
	VALUE_PRODUCING_TYPES,
} from "@/lib/references/provider";
import {
	MENU_ITEM_BASE,
	MENU_POPUP_CLS,
	MENU_SUBMENU_POSITIONER_CLS,
} from "@/lib/styles";

// ── Types ────────────────────────────────────────────────────────────

/** A flattened field entry for the autocomplete list. */
export interface FieldEntry {
	/** Bare field ID (e.g. "confirm_close"). */
	id: string;
	/** Full path for nested fields (e.g. "group1/confirm_close"). */
	path: string;
	/** Human-readable label. */
	label: string;
	/** Field kind (text, single_select, etc.) — drives the icon. */
	questionType: string;
}

// ── Utility ──────────────────────────────────────────────────────────

/**
 * Build a flat list of selectable fields from the normalized doc
 * rooted at `parentUuid` (typically the form uuid for top-level picker
 * usage; a group/repeat uuid when scoping to a container).
 *
 * Centralizes the "which fields can be referenced" logic so both the
 * FieldPicker UI and future XPath autocomplete filtering share the
 * same source of truth. Pass `typeFilter` to restrict to specific
 * kinds (e.g. only single/multi-select for close conditions).
 */
export function buildFieldEntries(
	src: FieldEntrySource,
	parentUuid: string,
	typeFilter?: ReadonlySet<string>,
): FieldEntry[] {
	const raw = collectFieldEntries(src, parentUuid);
	const filter = typeFilter ?? VALUE_PRODUCING_TYPES;
	return raw
		.filter((e) => filter.has(e.questionType))
		.map((e) => ({
			id: e.path.includes("/")
				? e.path.slice(e.path.lastIndexOf("/") + 1)
				: (e.path as string),
			path: e.path as string,
			label: e.label,
			questionType: e.questionType,
		}));
}

// ── Component ────────────────────────────────────────────────────────

interface FieldPickerProps {
	/** The normalized doc's field + order projection. Pass the doc store
	 *  slice directly; the picker only reads and doesn't mutate. */
	source: FieldEntrySource;
	/** Uuid of the container whose fields are pickable (form uuid or
	 *  group/repeat uuid). */
	parentUuid: string;
	/** Current field ID value. */
	value: string;
	/** Called with the bare field ID when a field is selected from the list. */
	onChange: (id: string) => void;
	/** Label text shown above the input. */
	label: string;
	/** Optional kind filter — defaults to `VALUE_PRODUCING_TYPES`. */
	typeFilter?: ReadonlySet<string>;
	/** Placeholder text for empty state. */
	placeholder?: string;
	/** Mark as required (shows rose asterisk). */
	required?: boolean;
}

/**
 * Searchable field picker backed by Base UI Autocomplete.
 * Shows field IDs with kind icons and labels as you type.
 */
export function FieldPicker({
	source,
	parentUuid,
	value,
	onChange,
	label,
	typeFilter,
	placeholder = "Search fields...",
	required,
}: FieldPickerProps) {
	const fields = useMemo(
		() => buildFieldEntries(source, parentUuid, typeFilter),
		[source, parentUuid, typeFilter],
	);

	/** Match against both ID and label so typing either narrows results. */
	const filterField = useCallback((item: FieldEntry, query: string) => {
		const q = query.toLowerCase();
		return (
			item.id.toLowerCase().includes(q) || item.label.toLowerCase().includes(q)
		);
	}, []);

	/** Only persist when the user actually selects an item. */
	const handleValueChange = useCallback(
		(val: string, details: { reason: string }) => {
			if (details.reason === "item-press") {
				onChange(val ?? "");
			}
		},
		[onChange],
	);

	return (
		<div>
			<span className="text-[10px] text-nova-text-muted uppercase tracking-wider mb-0.5 flex items-center gap-0.5">
				{label}
				{required && <span className="text-nova-rose ml-0.5">*</span>}
			</span>
			<Autocomplete.Root
				items={fields}
				filter={filterField}
				defaultValue={value}
				onValueChange={handleValueChange}
				itemToStringValue={(item) => item.id}
				openOnInputClick
			>
				<Autocomplete.InputGroup className="relative">
					<Autocomplete.Input
						placeholder={placeholder}
						autoComplete="off"
						data-1p-ignore
						className="w-full text-xs font-mono text-nova-violet-bright px-2 py-1.5 rounded-md border transition-colors outline-none bg-nova-deep/50 border-white/[0.06] hover:border-nova-violet/30 focus:bg-nova-surface focus:border-nova-violet/50 focus:shadow-[0_0_0_1px_rgba(139,92,246,0.1)]"
					/>
				</Autocomplete.InputGroup>

				<Autocomplete.Portal>
					<Autocomplete.Positioner
						side="bottom"
						align="start"
						sideOffset={4}
						className={MENU_SUBMENU_POSITIONER_CLS}
						style={{ minWidth: "var(--anchor-width)", maxWidth: 320 }}
					>
						<Autocomplete.Popup className={`${MENU_POPUP_CLS} w-full`}>
							<Autocomplete.Empty>
								<div className="px-3 py-2 text-xs text-nova-text-muted">
									No matching fields
								</div>
							</Autocomplete.Empty>
							<Autocomplete.List
								className="w-full max-h-48 overflow-y-auto"
								style={{ scrollbarGutter: "auto" }}
							>
								<Autocomplete.Collection>
									{(field: FieldEntry) => (
										<Autocomplete.Item
											key={field.path}
											value={field}
											className={`${MENU_ITEM_BASE} text-nova-text cursor-pointer data-[highlighted]:bg-white/[0.06] first:rounded-t-xl last:rounded-b-xl`}
										>
											<Icon
												icon={
													questionTypeIcons[field.questionType] ??
													questionTypeIcons.text
												}
												width="14"
												height="14"
												className="text-nova-text-muted shrink-0"
											/>
											{field.questionType === "hidden" ||
											field.label === field.path ? (
												<span className="font-mono text-xs text-nova-text truncate">
													{field.id}
												</span>
											) : (
												<>
													<span className="text-xs text-nova-text truncate">
														{field.label}
													</span>
													<span className="font-mono text-[10px] text-nova-text-muted truncate ml-auto">
														{field.id}
													</span>
												</>
											)}
										</Autocomplete.Item>
									)}
								</Autocomplete.Collection>
							</Autocomplete.List>
						</Autocomplete.Popup>
					</Autocomplete.Positioner>
				</Autocomplete.Portal>
			</Autocomplete.Root>
		</div>
	);
}
