// components/builder/shared/cards/MatchesPatternCard.tsx
//
// Renders the `matches-pattern` predicate: a value, read as text, contains
// a match for a regular expression. It is JavaRosa `regex()` and runs only
// on the device's Java Pattern engine, so the registry offers it solely in
// a Search field's required condition and check (`PredicateEditContext
// .patternMatching`). The match is unanchored: `^` and `$` test the whole
// answer.
//
// The pattern's Java syntax is not checked here. The main thread carries no
// Pattern engine for user-authored patterns (`lib/preview/CLAUDE.md`), so
// the card pins what the schema pins, a nonblank pattern, and the running
// Search screen reports an unparseable one when the check first runs.

"use client";
import { useEffect, useId, useRef, useState } from "react";
import { FieldError } from "@/components/shadcn/field";
import { Input } from "@/components/shadcn/input";
import {
	absenceSubjectConstraint,
	input,
	matchesPattern,
	PATTERN_MAX_LENGTH,
	type Predicate,
	prop,
	sessionContext,
	tableColumn,
} from "@/lib/domain/predicate";
import {
	caseDataInScope,
	type PredicateEditContext,
	tableRowInScope,
} from "../editorSchemas";
import { appendSlot, type EditorPath } from "../path";
import { ExpressionPicker } from "../primitives/ExpressionPicker";
import { PredicateVerbMenu } from "./PredicateVerbMenu";

/** A recognizable starting pattern: digits only, anchored to the whole
 *  answer. The author replaces it; it exists so the seed is a complete,
 *  valid condition rather than a blank the gate refuses. */
const SEED_PATTERN = "^[0-9]+$";

export function matchesPatternDefault(
	ctx: PredicateEditContext,
): Extract<Predicate, { kind: "matches-pattern" }> {
	if (tableRowInScope(ctx)) {
		const column = ctx.tableScope?.columns[0];
		if (ctx.tableScope === undefined || column === undefined) {
			throw new Error(
				"A table-row pattern condition requires one active-table column.",
			);
		}
		return matchesPattern(
			tableColumn(ctx.tableScope.tableId, column.id),
			SEED_PATTERN,
		);
	}
	if (!caseDataInScope(ctx)) {
		// The Search screen: the first named sibling answer is the natural
		// subject. With none, a REAL always-present session value stands in
		// (never an invented field name); the author swaps it from the picker.
		const first = ctx.knownInputs[0];
		return matchesPattern(
			first === undefined ? sessionContext("username") : input(first.uuid),
			SEED_PATTERN,
		);
	}
	const ct = ctx.caseTypes.find((c) => c.name === ctx.currentCaseType);
	const property = ct?.properties[0];
	return matchesPattern(
		prop(ctx.currentCaseType, property?.name ?? ""),
		SEED_PATTERN,
	);
}

interface MatchesPatternCardProps {
	readonly value: Extract<Predicate, { kind: "matches-pattern" }>;
	readonly onChange: (next: Predicate) => void;
	readonly path: EditorPath;
}

export function MatchesPatternCard({
	value,
	onChange,
	path,
}: MatchesPatternCardProps) {
	return (
		<div className="space-y-2">
			<div className="grid grid-cols-1 @md:grid-cols-[1.4fr_auto] gap-2 items-start">
				<ExpressionPicker
					value={value.left}
					onChange={(left) => onChange(matchesPattern(left, value.pattern))}
					path={appendSlot(path, "left")}
					constraint={absenceSubjectConstraint()}
					presentation="subject"
					variant="nested"
				/>
				<PredicateVerbMenu value={value} onChange={onChange} />
			</div>
			<PatternInput
				value={value.pattern}
				onChange={(pattern) => onChange(matchesPattern(value.left, pattern))}
			/>
			<div className="text-[13px] leading-relaxed text-nova-text-muted">
				A Java regular expression, checked on the device once the field has an
				answer. It matches anywhere in the answer, so start with ^ and end with
				$ to test the whole thing
			</div>
		</div>
	);
}

interface PatternInputProps {
	readonly value: string;
	readonly onChange: (next: string) => void;
}

/** Draft-then-commit text: the committed pattern is never blank (the
 *  schema refuses one), so an emptied box keeps the saved pattern and
 *  says so until the author types again. */
function PatternInput({ value, onChange }: PatternInputProps) {
	const inputRef = useRef<HTMLInputElement>(null);
	const errorId = useId();
	const [draft, setDraft] = useState(value);
	const [error, setError] = useState<string>();
	useEffect(() => {
		if (value !== draft && document.activeElement !== inputRef.current) {
			setDraft(value);
			setError(undefined);
		}
	}, [value, draft]);
	const commit = () => {
		const problem = patternProblem(draft);
		if (problem !== undefined) {
			setError(problem);
			return;
		}
		setError(undefined);
		if (draft === value) return;
		onChange(draft);
	};
	return (
		<div>
			<Input
				ref={inputRef}
				type="text"
				value={draft}
				onChange={(event) => {
					const next = event.target.value;
					setDraft(next);
					if (error !== undefined && patternProblem(next) === undefined) {
						setError(undefined);
					}
				}}
				onBlur={commit}
				onKeyDown={(event) => {
					if (event.key === "Enter") {
						event.preventDefault();
						commit();
					}
				}}
				autoComplete="off"
				autoCapitalize="off"
				autoCorrect="off"
				spellCheck={false}
				data-1p-ignore
				aria-label="Pattern"
				aria-invalid={error !== undefined || undefined}
				aria-describedby={error !== undefined ? errorId : undefined}
				className={`nova-focusable h-auto min-h-11 w-full border bg-nova-deep/50 px-3 font-mono text-sm text-nova-text md:text-sm dark:bg-nova-deep/50 ${
					error !== undefined ? "border-nova-rose/40" : "border-white/[0.06]"
				}`}
			/>
			{error !== undefined ? (
				<FieldError
					id={errorId}
					className="mt-2 text-[13px] leading-5 text-nova-rose"
				>
					{error}
				</FieldError>
			) : null}
		</div>
	);
}

function patternProblem(draft: string): string | undefined {
	if (draft === "") {
		return "Type the pattern to match. The saved pattern stays until you do";
	}
	if (draft.length > PATTERN_MAX_LENGTH) {
		return `Keep the pattern to ${PATTERN_MAX_LENGTH} characters`;
	}
	return undefined;
}
