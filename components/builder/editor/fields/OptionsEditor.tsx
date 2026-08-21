/**
 * OptionsEditor: declarative editor for a select field's inline options.
 *
 * Two exports:
 *   - `OptionsEditor`: the FieldEditorComponent adapter. Accepts
 *     `FieldEditorComponentProps` and preserves the complete
 *     `optionsSource` discriminant.
 *   - `OptionsEditorWidget`: the underlying fieldset widget with the
 *     `{ options, onSave }` shape. Callers that already hold a
 *     persistence strategy and simply want the label/value rows + add
 *     button use this directly.
 */

"use client";
import { Icon } from "@iconify/react/offline";
import tablerTrash from "@iconify-icons/tabler/trash";
import { useCallback, useId, useRef, useState } from "react";
import { AddPropertyButton } from "@/components/builder/editor/AddPropertyButton";
import { INSPECTOR_LABEL_CLS } from "@/components/builder/inspector/inspectorChrome";
import { MediaSlot } from "@/components/builder/media/MediaSlot";
import { RefLabelInput } from "@/components/builder/RefLabelInput";
import { RejectionInline } from "@/components/builder/RejectionNotice";
import { useProseProjection } from "@/lib/doc/hooks/useProseProjection";
import {
	asUuid,
	type CommitOutcome,
	type Field,
	type ProseTemplate,
	proseTemplateIsEmpty,
	proseTemplateText,
	proseText,
	type SelectOption,
	type SelectOptionsSource,
	sanitizeSelectOptionValue,
	suggestSelectOptionValue,
} from "@/lib/domain";
import type { FieldEditorComponentProps } from "@/lib/domain/kinds";
import { MEDIA_KINDS, type Media } from "@/lib/domain/multimedia";

/**
 * Draft option with a stable identity for React key management.
 * The `id` is component-local and never persisted: it exists purely
 * so that reordering or editing doesn't cause React to lose input
 * state.
 */
interface DraftOption extends SelectOption {
	id: number;
}

/**
 * A row exactly as `addOption` (or the field's default options) minted it:
 * value `option_N` under label "Option N". Nobody chose either, so the
 * first real label may also name the value. Pure and exported for tests.
 */
export function isMintedPlaceholder(option: SelectOption): boolean {
	const match = /^option_(\d+)$/.exec(option.value);
	if (match === null) return false;
	return proseTemplateText(option.label).trim() === `Option ${match[1]}`;
}

export interface OptionsEditorWidgetProps {
	options: SelectOption[];
	/** Persist the next options. May return the gated dispatch's outcome:
	 *  a refusal keeps the widget's draft (the committed-key ref only
	 *  advances on a landed save); `void` reads as committed. */
	onSave: (options: SelectOption[]) => CommitOutcome | undefined;
	/** Staged-upload identity base for the option rows' media slots:
	 *  the owning field's uuid; each row scopes itself by option value. */
	slotKeyBase: string;
	/** When true, the first option label input receives focus on mount (undo/redo restore). */
	autoFocus?: boolean;
}

/** Counter for generating monotonically increasing draft IDs. */
let nextDraftId = 0;

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
export function OptionsEditorWidget({
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
	// The two accessible names below are the only place an option label is
	// read as plain text; a screen reader hears the same words the sighted
	// author sees in the chip, so it goes through the document too.
	const projectProse = useProseProjection();

	// Ref on the fieldset element: used by the blur handler to check
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
		// External change: the prop no longer matches what we last
		// wrote. Resync the draft and drop any pending focus hint.
		lastCommittedKeyRef.current = currentKey;
		setDraft(toDraftOptions(options));
		setFocusIndex(null);
	}

	// Commit the draft to the parent, stripping empty rows. The committed
	// key advances only when the save LANDED: on a gate refusal the doc
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
				(o) => !proseTemplateIsEmpty(o.label) || o.value.trim() || o.media,
			);
			const outcome = onSave(cleaned);
			if (!outcome || outcome.ok) {
				lastCommittedKeyRef.current = serializeOptions(cleaned);
			}
		},
		[onSave],
	);

	// The value box admits only what the wire can carry: a typed space
	// becomes an underscore and a quote mark is dropped as it is typed, so
	// the row never holds a value the commit gate would bounce
	// (`SELECT_OPTION_VALUE_INVALID`). The same grammar the SA's schema
	// teaches and the validator enforces, applied at the keystroke; the
	// sanitizer deliberately leaves edge underscores alone, since the one
	// just typed is an edge until the next character lands.
	const updateValue = useCallback((index: number, raw: string) => {
		const value = sanitizeSelectOptionValue(raw);
		setDraft((prev) => {
			const next = [...prev];
			next[index] = { ...next[index], value };
			return next;
		});
	}, []);

	// A row Nova minted (`option_N` / "Option N") has a value nobody chose,
	// so the first label it is given also names the value, the way the SA
	// does (`prefer_not_to_say` for "Prefer not to say"). Once either side
	// has been edited by hand the two are independent: the value is data
	// and a later label change must never rewrite it.
	const saveLabel = useCallback(
		(index: number, label: ProseTemplate) => {
			const next = draft.map((option, optionIndex) => {
				if (optionIndex !== index) return option;
				if (!isMintedPlaceholder(option)) return { ...option, label };
				const taken = new Set(
					draft
						.filter((_, otherIndex) => otherIndex !== index)
						.map((other) => other.value),
				);
				return {
					...option,
					label,
					value: suggestSelectOptionValue(
						proseTemplateText(label),
						option.value,
						taken,
					),
				};
			});
			setDraft(next);
			commit(next);
		},
		[draft, commit],
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
		// Mint the persisted identity once. Array order remains display order.
		const next: DraftOption[] = [
			...draft,
			{
				id: nextDraftId++,
				uuid: asUuid(crypto.randomUUID()),
				value: `option_${num}`,
				label: proseText(`Option ${num}`),
			},
		];
		setDraft(next);
		commit(next);
		setFocusIndex(next.length - 1);
	}, [draft, commit]);

	/**
	 * Commit when focus leaves the entire option group.
	 *
	 * The check runs in the next frame (rAF) because `blur` fires
	 * before React processes the focus move to the new element:
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
				className={`${INSPECTOR_LABEL_CLS} mb-1.5 block p-0`}
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
							<fieldset
								className="flex-1 min-w-0 border-0 p-0 m-0"
								onBlur={(event) => event.stopPropagation()}
							>
								<RefLabelInput
									label="Label"
									value={opt.label}
									onSave={(label) => saveLabel(i, label)}
									autoFocus={focusIndex === i || (autoFocus && i === 0)}
								/>
							</fieldset>
							<input
								value={opt.value}
								onChange={(e) => updateValue(i, e.target.value)}
								onKeyDown={handleKeyDown}
								placeholder="value"
								aria-label={`Stored value for ${
									projectProse(opt.label).trim() || `option ${i + 1}`
								}`}
								className="w-24 shrink-0 text-[13px] font-mono px-3 min-h-11 rounded-lg bg-nova-deep/50 border border-white/[0.06] focus:outline-none focus:ring-1 focus:border-nova-violet/40 focus:ring-nova-violet/30 text-nova-text-muted transition-colors"
								autoComplete="off"
								data-1p-ignore
							/>
						</div>
						<button
							type="button"
							onClick={() => removeOption(i)}
							disabled={draft.length <= 2}
							aria-label={`Remove ${
								projectProse(opt.label).trim() || `option ${i + 1}`
							}`}
							className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg text-nova-text-muted transition-colors hover:bg-nova-rose/10 hover:text-nova-rose disabled:cursor-not-allowed disabled:opacity-30"
						>
							<Icon icon={tablerTrash} width="16" height="16" />
						</button>
						<div className="basis-full pl-1">
							<MediaSlot
								value={opt.media}
								onChange={(media) => setOptionMedia(i, media)}
								kinds={MEDIA_KINDS}
								// The UUID is the authored identity. Values are mutable
								// wire projections and never address option media.
								slotKey={`option:${slotKeyBase}:${opt.uuid}`}
								ariaLabel={projectProse(opt.label).trim() || `Option ${i + 1}`}
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
 * The `as F["optionsSource" & keyof F]` cast is needed because the generic
 * `onChange(next: F[K])` is an indexed-access write; every kind that
 * declares `optionsSource` carries the same discriminated union.
 */
export function OptionsEditor<F extends Field>(
	props: FieldEditorComponentProps<F, "optionsSource" & keyof F>,
) {
	const { field, value, onChange, autoFocus } = props;
	const source = value as SelectOptionsSource;
	/* The widget's `onSave` has no inline channel of its own, so the
	 * adapter holds the gate's finding and renders it beneath the rows:
	 * the section dispatches through the inline (no-toast) flavor on the
	 * promise that every editor presents its own rejections. Cleared on
	 * the next save that lands. */
	const [rejection, setRejection] = useState<string | null>(null);
	if (source.kind === "lookup") {
		return (
			<div
				data-field-id="options"
				className="rounded-lg border border-white/[0.06] bg-nova-deep/35 px-3 py-2.5"
			>
				<p className={INSPECTOR_LABEL_CLS}>Options</p>
				<p className="mt-1 text-xs leading-relaxed text-nova-text-muted">
					These choices come from a Project data table. Change the table,
					columns, or row filter in the table-source editor.
				</p>
			</div>
		);
	}
	return (
		<div data-field-id="options">
			<OptionsEditorWidget
				options={source.options}
				slotKeyBase={field.uuid}
				autoFocus={autoFocus}
				onSave={(next) => {
					const outcome = onChange({
						kind: "inline",
						options: next,
					} as F["optionsSource" & keyof F]);
					setRejection(outcome.ok ? null : (outcome.messages[0] ?? null));
					// The widget gates its committed-key ref on this: a refusal
					// must keep the user's draft rows on screen.
					return outcome;
				}}
			/>
			<RejectionInline message={rejection} />
		</div>
	);
}
