/**
 * OptionsEditor — declarative editor for the `options` array on
 * single-select / multi-select fields.
 *
 * Two exports:
 *   - `OptionsEditor` — the FieldEditorComponent adapter. Accepts
 *     `FieldEditorComponentProps` and enforces the schema's `min(2)`
 *     invariant at the adapter boundary: drafts smaller than two
 *     entries collapse to `undefined` (which the reducer treats as a
 *     removal patch) rather than writing through a list the schema
 *     would reject on the next validation pass.
 *   - `OptionsEditorWidget` — the underlying fieldset widget with the
 *     `{ options, onSave }` shape. Callers that already hold a
 *     persistence strategy and simply want the label/value rows + add
 *     button use this directly.
 */

"use client";
import { Icon } from "@iconify/react/offline";
import tablerTrash from "@iconify-icons/tabler/trash";
import { useCallback, useId, useRef, useState } from "react";
import { AddPropertyButton } from "@/components/builder/editor/AddPropertyButton";
import { MediaSlot } from "@/components/builder/media/MediaSlot";
import { RejectionInline } from "@/components/builder/RejectionNotice";
import type { CommitOutcome, Field, SelectOption } from "@/lib/domain";
import type { FieldEditorComponentProps } from "@/lib/domain/kinds";
import { MEDIA_KINDS, type Media } from "@/lib/domain/multimedia";

/**
 * Draft option with a stable identity for React key management.
 * The `id` is component-local and never persisted — it exists purely
 * so that reordering or editing doesn't cause React to lose input
 * state.
 */
interface DraftOption extends SelectOption {
	id: number;
}

interface OptionsEditorWidgetProps {
	options: SelectOption[];
	/** Persist the next options. May return the gated dispatch's outcome —
	 *  a refusal keeps the widget's draft (the committed-key ref only
	 *  advances on a landed save); `void` reads as committed. */
	onSave: (options: SelectOption[]) => CommitOutcome | undefined;
	/** Staged-upload identity base for the option rows' media slots —
	 *  the owning field's uuid; each row scopes itself by option value. */
	slotKeyBase: string;
	/** When true, the first option label input receives focus on mount (undo/redo restore). */
	autoFocus?: boolean;
}

/** Counter for generating monotonically increasing draft IDs. */
let nextDraftId = 0;

/**
 * Stable ref callback that focuses the element on mount. Defined at
 * module scope so React doesn't see a new function identity each
 * render — if it did, React would unmount and remount the ref on
 * every parent update and steal focus.
 */
const focusOnMount = (el: HTMLInputElement | null) =>
	el?.focus({ preventScroll: true });

/** Wrap raw options with stable draft IDs. */
function toDraftOptions(options: SelectOption[]): DraftOption[] {
	return options.map((o) => ({ ...o, id: nextDraftId++ }));
}

/** Strip the component-local draft id before persisting, preserving
 *  every real option field (value, label, and optional media). A
 *  destructure-and-spread (rather than picking `{value, label}`) is
 *  load-bearing: picking would silently drop `media` on every commit,
 *  erasing an option's attached image/audio/video the moment its label
 *  or value is edited. */
function toOptions(draft: DraftOption[]): SelectOption[] {
	return draft.map(({ id: _id, ...option }) => option);
}

/**
 * Canonical key used to compare two `SelectOption[]` values. The
 * draft-sync gate uses it to detect external changes without
 * regenerating draft ids on every round-trip.
 */
function serializeOptions(options: SelectOption[]): string {
	return JSON.stringify(options);
}

/**
 * Low-level widget: renders the label+value inputs, add/remove row
 * affordances, and commits on group blur / Enter keypress.
 */
function OptionsEditorWidget({
	options,
	onSave,
	slotKeyBase,
	autoFocus,
}: OptionsEditorWidgetProps) {
	const [draft, setDraft] = useState<DraftOption[]>(() =>
		toDraftOptions(options),
	);
	const [focusIndex, setFocusIndex] = useState<number | null>(null);
	const groupLabelId = useId();

	// Ref on the fieldset element — used by the blur handler to check
	// whether focus moved outside the group. Checking
	// `fieldsetRef.current?.contains(...)` after an rAF is resilient
	// to the element unmounting mid-blur (common when the group's
	// last input is deleted during focus), because the ref nulls out
	// when the DOM detaches.
	const fieldsetRef = useRef<HTMLFieldSetElement | null>(null);

	// Remember the key of the last *local* commit so we can
	// distinguish "parent echoed our own write back" from "external
	// mutation" (undo/redo, tool call, another editor). Only external
	// mutations should regenerate draft ids + clear the focus index;
	// echoes of our own commits would otherwise unmount the
	// currently-focused input between keystrokes and drop caret/focus.
	const lastCommittedKeyRef = useRef<string>(serializeOptions(options));
	const currentKey = serializeOptions(options);
	if (currentKey !== lastCommittedKeyRef.current) {
		// External change — the prop no longer matches what we last
		// wrote. Resync the draft and drop any pending focus hint.
		lastCommittedKeyRef.current = currentKey;
		setDraft(toDraftOptions(options));
		setFocusIndex(null);
	}

	// Commit the draft to the parent, stripping empty rows. The committed
	// key advances only when the save LANDED — on a gate refusal the doc
	// is unchanged, so advancing it optimistically would make the
	// external-change sync block above read the unchanged prop as foreign
	// and revert the user's draft right as the notice explains the bounce.
	const commit = useCallback(
		(updated: DraftOption[]) => {
			const cleaned = toOptions(updated).filter(
				// Drop only fully-empty rows. A row carrying media is kept
				// even with a blank label/value so attaching an image and
				// then blanking the text doesn't silently discard the asset
				// reference along with the row.
				(o) => o.label.trim() || o.value.trim() || o.media,
			);
			const outcome = onSave(cleaned);
			if (!outcome || outcome.ok) {
				lastCommittedKeyRef.current = serializeOptions(cleaned);
			}
		},
		[onSave],
	);

	const updateOption = useCallback(
		(index: number, field: "label" | "value", val: string) => {
			setDraft((prev) => {
				const next = [...prev];
				next[index] = { ...next[index], [field]: val };
				return next;
			});
		},
		[],
	);

	const removeOption = useCallback(
		(index: number) => {
			const next = draft.filter((_, i) => i !== index);
			setDraft(next);
			commit(next);
		},
		[draft, commit],
	);

	// Attach / replace / clear an option's media. Commits immediately
	// rather than on group-blur: the media picker is a separate dialog,
	// so focus never returns to the fieldset to trigger the blur commit.
	const setOptionMedia = useCallback(
		(index: number, media: Media | undefined) => {
			const next = draft.map((o, i) => {
				if (i !== index) return o;
				const { media: _was, ...base } = o;
				return (media ? { ...base, media } : base) as DraftOption;
			});
			setDraft(next);
			commit(next);
		},
		[draft, commit],
	);

	const addOption = useCallback(() => {
		const num = draft.length + 1;
		const next: DraftOption[] = [
			...draft,
			{ id: nextDraftId++, value: `option_${num}`, label: `Option ${num}` },
		];
		setDraft(next);
		commit(next);
		setFocusIndex(next.length - 1);
	}, [draft, commit]);

	/**
	 * Commit when focus leaves the entire option group.
	 *
	 * The check runs in the next frame (rAF) because `blur` fires
	 * before React processes the focus move to the new element —
	 * without the deferral, `document.activeElement` is still `body`
	 * even when the user is tabbing between inputs inside the same
	 * fieldset. `fieldsetRef.current?.contains(...)` is nullable to
	 * survive the case where the fieldset itself unmounted between
	 * blur and the rAF callback (e.g. the options array dropped to
	 * zero rows and a parent hid the section).
	 */
	const handleBlur = useCallback(() => {
		requestAnimationFrame(() => {
			const el = fieldsetRef.current;
			if (!el) return;
			if (!el.contains(document.activeElement)) {
				commit(draft);
				setFocusIndex(null);
			}
		});
	}, [draft, commit]);

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (e.key === "Enter") {
				e.preventDefault();
				(e.target as HTMLElement).blur();
				commit(draft);
			}
		},
		[draft, commit],
	);

	return (
		<fieldset
			ref={fieldsetRef}
			onBlur={handleBlur}
			aria-labelledby={groupLabelId}
			className="border-none p-0 m-0"
		>
			<legend
				id={groupLabelId}
				className="text-xs text-nova-text-muted uppercase tracking-wider mb-1 block p-0"
			>
				Options
			</legend>
			<div className="space-y-1.5">
				{draft.map((opt, i) => (
					<div
						key={opt.id}
						className="flex flex-wrap items-center gap-1.5 group"
					>
						<div className="flex-1 min-w-0 flex gap-1">
							<input
								value={opt.label}
								onChange={(e) => updateOption(i, "label", e.target.value)}
								onKeyDown={handleKeyDown}
								placeholder="Label"
								ref={
									focusIndex === i || (autoFocus && i === 0)
										? focusOnMount
										: undefined
								}
								className="flex-1 min-w-0 text-xs px-2 py-1.5 rounded-md bg-nova-deep/50 border border-white/[0.06] focus:border-nova-violet/50 focus:shadow-[0_0_0_1px_rgba(139,92,246,0.1)] text-nova-text outline-none transition-colors"
								autoComplete="off"
								data-1p-ignore
							/>
							<input
								value={opt.value}
								onChange={(e) => updateOption(i, "value", e.target.value)}
								onKeyDown={handleKeyDown}
								placeholder="value"
								className="w-24 shrink-0 text-xs font-mono px-2 py-1.5 rounded-md bg-nova-deep/50 border border-white/[0.06] focus:border-nova-violet/50 focus:shadow-[0_0_0_1px_rgba(139,92,246,0.1)] text-nova-text-muted outline-none transition-colors"
								autoComplete="off"
								data-1p-ignore
							/>
						</div>
						<button
							type="button"
							onClick={() => removeOption(i)}
							className="shrink-0 p-0.5 text-nova-text-muted opacity-0 group-hover:opacity-100 hover:text-nova-rose transition-all cursor-pointer"
							tabIndex={-1}
						>
							<Icon icon={tablerTrash} width="12" height="12" />
						</button>
						<div className="basis-full pl-1">
							<MediaSlot
								value={opt.media}
								onChange={(media) => setOptionMedia(i, media)}
								kinds={MEDIA_KINDS}
								// Keyed by the option's VALUE (the same handle the SA
								// tool addresses options by), so add/remove of sibling
								// rows doesn't re-target a staged chip mid-upload.
								slotKey={`option:${slotKeyBase}:${opt.value}`}
								ariaLabel={opt.label.trim() || `Option ${i + 1}`}
							/>
						</div>
					</div>
				))}
			</div>
			<AddPropertyButton
				label="Add option"
				onClick={addOption}
				className="mt-2"
			/>
		</fieldset>
	);
}

/**
 * Declarative FieldEditorComponent adapter.
 *
 * Empties and single-option drafts collapse to `undefined`; the
 * single-select / multi-select schemas declare `.min(2)` on
 * `options`, so any smaller list would fail re-validation on the
 * next write. Treating `undefined` as "not set yet" is the only
 * round-trip-safe value for a sub-minimum draft — the reducer
 * interprets it as a removal patch.
 *
 * The `as F["options" & keyof F]` cast is needed because the generic
 * `onChange(next: F[K])` is an indexed-access write; every kind that
 * declares `options` carries it as `SelectOption[] | undefined`, so
 * both branches are valid values at runtime.
 */
export function OptionsEditor<F extends Field>(
	props: FieldEditorComponentProps<F, "options" & keyof F>,
) {
	const { field, value, onChange, autoFocus } = props;
	const current = Array.isArray(value) ? (value as SelectOption[]) : [];
	/* The widget's `onSave` has no inline channel of its own, so the
	 * adapter holds the gate's finding and renders it beneath the rows —
	 * the section dispatches through the inline (no-toast) flavor on the
	 * promise that every editor presents its own rejections. Cleared on
	 * the next save that lands. */
	const [rejection, setRejection] = useState<string | null>(null);
	return (
		<div data-field-id="options">
			<OptionsEditorWidget
				options={current}
				slotKeyBase={field.uuid}
				autoFocus={autoFocus}
				onSave={(next) => {
					// Enforce the schema's `min(2)` at the adapter boundary —
					// any sub-minimum draft becomes `undefined` (removal patch).
					const persisted =
						next.length >= 2 ? next : (undefined as SelectOption[] | undefined);
					const outcome = onChange(persisted as F["options" & keyof F]);
					setRejection(outcome.ok ? null : (outcome.messages[0] ?? null));
					// The widget gates its committed-key ref on this — a refusal
					// must keep the user's draft rows on screen.
					return outcome;
				}}
			/>
			<RejectionInline message={rejection} />
		</div>
	);
}
