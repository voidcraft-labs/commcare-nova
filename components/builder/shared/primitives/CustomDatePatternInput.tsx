// components/builder/shared/primitives/CustomDatePatternInput.tsx
//
// One date-style authoring surface shared by case-list columns and the
// `format-date` expression card. The common path is a small preset choice.
// Choosing Custom progressively reveals one pattern input, a live example,
// and an optional plain-language piece builder. Imported JavaRosa patterns
// stay byte-for-byte intact until the author changes that one input.

"use client";

import { Icon } from "@iconify/react/offline";
import tablerChevronDown from "@iconify-icons/tabler/chevron-down";
import {
	type FocusEvent,
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { Button } from "@/components/shadcn/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/shadcn/collapsible";
import { Input } from "@/components/shadcn/input";
import {
	type CommCareDatePatternParseResult,
	parseCommCareDatePattern,
} from "@/lib/domain/commCareDatePattern";
import { formatCommCareDate } from "@/lib/preview/xpath/dateFormatting";
import { XPathDate } from "@/lib/preview/xpath/types";

/** A memorable sample with leading-zero and time pieces that differ clearly. */
const DATE_STYLE_EXAMPLE = XPathDate.fromJSDate(
	new Date(2026, 6, 7, 9, 5, 6, 9),
);

/** A preset's stable key, person-facing label, and stored pattern value. */
export interface DatePatternPreset {
	readonly id: string;
	readonly label: string;
	readonly pattern: string;
}

interface CustomDatePatternInputProps {
	readonly value: string;
	readonly onChange: (next: string) => void;
	readonly presets: readonly DatePatternPreset[];
	/** A real pattern to start from when Custom is first selected. */
	readonly customSeed?: string;
}

/**
 * Presets plus one progressively disclosed custom editor. The custom branch
 * never normalizes a saved pattern, so arbitrary supported imports round-trip
 * unchanged. Preset values may be semantic ids (`short`) or concrete patterns;
 * the shared Preview formatter resolves both.
 */
export function CustomDatePatternInput({
	value,
	onChange,
	presets,
	customSeed = "%d-%b-%Y",
}: CustomDatePatternInputProps) {
	const isPreset = presets.some((preset) => preset.pattern === value);

	return (
		<div className="space-y-2">
			<PresetRow
				value={value}
				onChange={onChange}
				presets={presets}
				isPreset={isPreset}
				customSeed={customSeed}
			/>
			{isPreset ? (
				<DatePatternExample pattern={value} />
			) : (
				<CustomEditor value={value} onChange={onChange} />
			)}
		</div>
	);
}

interface PresetRowProps {
	readonly value: string;
	readonly onChange: (next: string) => void;
	readonly presets: readonly DatePatternPreset[];
	readonly isPreset: boolean;
	readonly customSeed: string;
}

function PresetRow({
	value,
	onChange,
	presets,
	isPreset,
	customSeed,
}: PresetRowProps) {
	const baseClass =
		"h-auto min-h-11 min-w-0 w-full whitespace-normal rounded-md px-2 py-2 text-center text-sm active:translate-y-0";
	const activeClass = "bg-nova-violet/10 text-nova-violet-bright";
	const idleClass =
		"text-nova-text-muted not-disabled:hover:bg-white/[0.04] not-disabled:hover:text-nova-text dark:not-disabled:hover:bg-white/[0.04]";

	return (
		<fieldset
			className="grid grid-cols-2 gap-1 rounded-md border border-white/[0.06] bg-nova-deep/50 p-1"
			aria-label="Date style"
		>
			{presets.map((preset) => {
				const isActive = isPreset && value === preset.pattern;
				return (
					<Button
						type="button"
						variant="ghost"
						size="xl"
						key={preset.id}
						onClick={() => {
							if (!isActive) onChange(preset.pattern);
						}}
						className={`${baseClass} ${isActive ? activeClass : idleClass}`}
						aria-pressed={isActive}
					>
						{preset.label}
					</Button>
				);
			})}
			<Button
				type="button"
				variant="ghost"
				size="xl"
				onClick={() => {
					if (isPreset) onChange(customSeed);
				}}
				className={`${baseClass} ${!isPreset ? activeClass : idleClass}`}
				aria-pressed={!isPreset}
			>
				Custom
			</Button>
		</fieldset>
	);
}

interface CustomEditorProps {
	readonly value: string;
	readonly onChange: (next: string) => void;
}

function CustomEditor({ value, onChange }: CustomEditorProps) {
	const inputRef = useRef<HTMLInputElement>(null);
	const previousValueRef = useRef(value);
	const errorId = useId();
	const inputId = useId();
	const [draft, setDraft] = useState(value);
	const [pendingCaret, setPendingCaret] = useState<number | null>(null);
	const [showError, setShowError] = useState(false);
	const problem = datePatternProblem(draft);
	const isInvalid = showError && problem !== null;

	useEffect(() => {
		if (previousValueRef.current === value) return;
		previousValueRef.current = value;
		setDraft(value);
		setShowError(false);
	}, [value]);

	useLayoutEffect(() => {
		if (pendingCaret === null) return;
		inputRef.current?.focus();
		inputRef.current?.setSelectionRange(pendingCaret, pendingCaret);
		setPendingCaret(null);
	}, [pendingCaret]);

	const commit = useCallback(() => {
		const nextProblem = datePatternProblem(draft);
		if (nextProblem !== null) {
			setShowError(true);
			return;
		}
		setShowError(false);
		if (draft !== value) onChange(draft);
	}, [draft, onChange, value]);

	const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
		const nextTarget = event.relatedTarget;
		const componentRoot = event.currentTarget.parentElement;
		if (nextTarget instanceof Node && componentRoot?.contains(nextTarget)) {
			return;
		}
		commit();
	};

	const insertPiece = (piece: string) => {
		const start = inputRef.current?.selectionStart ?? draft.length;
		const end = inputRef.current?.selectionEnd ?? start;
		const next = `${draft.slice(0, start)}${piece}${draft.slice(end)}`;
		setPendingCaret(start + piece.length);
		setDraft(next);
		if (datePatternProblem(next) === null) setShowError(false);
	};

	return (
		<div className="space-y-2" onBlurCapture={handleBlur}>
			<div className="space-y-1.5">
				<label
					htmlFor={inputId}
					className="block text-[13px] font-medium text-nova-text-secondary"
				>
					Custom date style
				</label>
				<Input
					id={inputId}
					ref={inputRef}
					type="text"
					value={draft}
					onChange={(event) => {
						const next = event.target.value;
						setDraft(next);
						if (datePatternProblem(next) === null) setShowError(false);
					}}
					onKeyDown={(event) => {
						if (event.key !== "Enter") return;
						event.preventDefault();
						commit();
					}}
					autoComplete="off"
					data-1p-ignore
					placeholder="Choose date pieces below"
					aria-describedby={isInvalid ? errorId : undefined}
					aria-invalid={isInvalid || undefined}
					className="h-auto min-h-11 w-full rounded-md border border-white/[0.06] bg-nova-deep/50 px-3 font-mono text-sm text-nova-text placeholder:text-nova-text-muted focus-visible:border-nova-violet/40 focus-visible:ring-nova-violet/30 aria-invalid:border-nova-rose/40 aria-invalid:focus-visible:border-nova-rose/60 aria-invalid:focus-visible:ring-nova-rose/30 md:text-sm dark:bg-nova-deep/50"
				/>
				{isInvalid ? (
					<p id={errorId} className="text-[13px] leading-snug text-nova-rose">
						{problem}
					</p>
				) : null}
			</div>

			<DatePatternExample pattern={problem === null ? draft : null} />
			<DatePieceBuilder onInsert={insertPiece} />
		</div>
	);
}

function DatePatternExample({ pattern }: { readonly pattern: string | null }) {
	// The formatter's time-zone token is intentionally device-local. Match the
	// first client render to SSR, then calculate the example in the browser so a
	// `%Z` example never hydrates with the server's zone.
	const [mounted, setMounted] = useState(false);
	useEffect(() => setMounted(true), []);

	const example =
		mounted && pattern !== null
			? formatCommCareDate(DATE_STYLE_EXAMPLE, pattern)
			: null;
	const text = !mounted
		? "\u00a0"
		: example?.kind === "formatted"
			? `“${example.text}”`
			: "Finish the style to see an example";

	return (
		<div className="rounded-lg border border-white/[0.06] bg-nova-deep/30 px-3 py-2">
			<div className="text-xs text-nova-text-muted">Example</div>
			<output
				aria-live="polite"
				className="mt-0.5 block min-w-0 break-words text-sm text-nova-text-secondary"
			>
				{text}
			</output>
		</div>
	);
}

interface DatePiece {
	readonly token: string;
	readonly label: string;
	readonly example: string;
}

const DATE_PIECES: readonly DatePiece[] = [
	{ token: "%Y", label: "Year", example: "2026" },
	{ token: "%y", label: "Short year", example: "26" },
	{ token: "%B", label: "Month name", example: "July" },
	{ token: "%b", label: "Short month", example: "Jul" },
	{ token: "%m", label: "Month number", example: "07" },
	{ token: "%n", label: "Month without leading zero", example: "7" },
	{ token: "%d", label: "Day", example: "07" },
	{ token: "%e", label: "Day without leading zero", example: "7" },
	{ token: "%A", label: "Weekday", example: "Tuesday" },
	{ token: "%a", label: "Short weekday", example: "Tue" },
];

const TIME_AND_OTHER_PIECES: readonly DatePiece[] = [
	{ token: "%H", label: "Hour", example: "09" },
	{ token: "%h", label: "Hour without leading zero", example: "9" },
	{ token: "%M", label: "Minute", example: "05" },
	{ token: "%S", label: "Second", example: "06" },
	{ token: "%3", label: "Milliseconds", example: "009" },
	{ token: "%w", label: "Weekday number", example: "2" },
	{ token: "%Z", label: "Time zone", example: "-07" },
	{ token: "%%", label: "Percent sign", example: "%" },
];

function DatePieceBuilder({
	onInsert,
}: {
	readonly onInsert: (piece: string) => void;
}) {
	return (
		<Collapsible>
			<CollapsibleTrigger
				render={
					<Button
						type="button"
						variant="outline"
						size="xl"
						className="group w-full justify-between whitespace-normal px-3 text-left"
					/>
				}
			>
				Choose date pieces
				<Icon
					icon={tablerChevronDown}
					className="size-4 shrink-0 text-nova-text-muted transition-transform group-data-[panel-open]:rotate-180"
				/>
			</CollapsibleTrigger>
			<CollapsibleContent className="pt-2">
				<div className="space-y-3 rounded-lg border border-white/[0.06] bg-nova-deep/30 p-2.5">
					<p className="text-[13px] leading-relaxed text-nova-text-muted">
						Choose pieces, then type any spaces, punctuation, or words between
						them
					</p>
					<DatePieceGroup
						label="Date"
						pieces={DATE_PIECES}
						onInsert={onInsert}
					/>
					<DatePieceGroup
						label="Time and more"
						pieces={TIME_AND_OTHER_PIECES}
						onInsert={onInsert}
					/>
				</div>
			</CollapsibleContent>
		</Collapsible>
	);
}

function DatePieceGroup({
	label,
	pieces,
	onInsert,
}: {
	readonly label: string;
	readonly pieces: readonly DatePiece[];
	readonly onInsert: (piece: string) => void;
}) {
	return (
		<fieldset className="space-y-1.5">
			<legend className="text-xs font-medium text-nova-text-secondary">
				{label}
			</legend>
			<div className="grid grid-cols-2 gap-1.5">
				{pieces.map((piece) => (
					<Button
						type="button"
						variant="ghost"
						size="xl"
						key={piece.token}
						onClick={() => onInsert(piece.token)}
						aria-label={`Insert ${piece.label.toLowerCase()}, shown as ${piece.example}`}
						className="h-auto min-h-11 min-w-0 justify-start whitespace-normal border border-white/[0.06] px-2.5 py-1.5 text-left"
					>
						<span className="min-w-0">
							<span className="block break-words text-[13px] text-nova-text">
								{piece.label}
							</span>
							<span className="block break-words text-xs font-normal text-nova-text-muted">
								{piece.example}
							</span>
						</span>
					</Button>
				))}
			</div>
		</fieldset>
	);
}

function datePatternProblem(pattern: string): string | null {
	if (pattern.length === 0) {
		return "Enter a custom style or choose a date piece";
	}
	const parsed = parseCommCareDatePattern(pattern);
	if (parsed.kind === "parsed") return null;
	return unsupportedPatternMessage(parsed);
}

function unsupportedPatternMessage(
	problem: Extract<
		CommCareDatePatternParseResult,
		{ kind: "unsupported-pattern" }
	>,
): string {
	return problem.escape === undefined
		? "Finish the date piece after % or remove it"
		: `${problem.escape} isn’t a date piece. Choose another piece or remove it`;
}
