// components/builder/case-list-config/cards/column/CalculatedColumnCard.tsx
//
// Renders the `calculated` Column kind: an author-defined
// `Expression` that yields a derived per-row value
// (e.g. "days since last visit", "concatenated full name").
// Calculated columns have NO `field` slot; the expression is the
// source. The wire emitter lowers the expression into a Postgres
// expression / on-device XPath fragment.
//
// Slots:
//   - `header`: column display label.
//   - `expression`: a `Expression` AST edited through the
//     shared `ExpressionCardEditor`. Cross-family recursion (`if.cond`
//     / `count.where` carrying Expression operands) flows naturally
//     through that editor's existing context plumbing.
//
// Header + expression are the only authored fields. The card mounts
// inside `ColumnEditor`'s kind-dispatch alongside the other column
// cards, so the surrounding `CardShell` chrome (icon / kind label /
// kind-replace menu) is identical to every other kind's card.

"use client";
import { v4 } from "uuid";
import {
	INSPECTOR_LABEL_CLS,
	SegmentedRow,
} from "@/components/builder/inspector/inspectorChrome";
import { ExpressionSlotEditor } from "@/components/builder/shared/ExpressionSlotEditors";
import { BlurCommitTextInput } from "@/components/builder/shared/primitives/BlurCommitTextInput";
import { Button } from "@/components/shadcn/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/shadcn/select";
import { useAppSettings } from "@/lib/doc/hooks/useAppSettings";
import { useModule } from "@/lib/doc/hooks/useEntity";
import type { Column } from "@/lib/domain";
import {
	type Expression,
	literal,
	term,
	walkExpressionNodes,
} from "@/lib/domain/expression";
import { resolveSearchResultDetailText } from "@/lib/domain/searchResultDetail";
import { asUuid } from "@/lib/domain/uuid";
import type { ColumnEditContext } from "../../columnEditorSchemas";

interface CalculatedColumnCardProps {
	readonly value: Extract<Column, { kind: "calculated" }>;
	readonly onChange: (next: Column) => void;
	readonly ctx: ColumnEditContext;
	readonly errors?: readonly string[];
}

/**
 * Calculated column card. Routes every mutation through
 * `calculatedColumn` so the constructed shape always matches the
 * schema. Mounts the shared `ExpressionCardEditor` for the
 * expression slot: the same editor surface every other
 * Expression authoring site uses, so a calc-column's
 * expression UI is identical to (e.g.) a search-input's default
 * value editor.
 */
export function CalculatedColumnCard({
	value,
	onChange,
	ctx,
}: CalculatedColumnCardProps) {
	const appSettings = useAppSettings();
	const module = useModule(ctx.moduleUuid);
	const searchResult = value.searchResultDetail;
	const offered = (module?.caseListConfig?.searchInputs ?? []).filter(
		(prompt) =>
			module &&
			resolveSearchResultDetailText({ appSettings }, module, value, {
				inputUuid: prompt.uuid,
				prefix: searchResult?.prefix ?? "",
				suffix: searchResult?.suffix ?? "",
			}),
	);
	const selectedPrompt = offered.find(
		(prompt) => prompt.uuid === searchResult?.inputUuid,
	);
	const localText =
		value.expression.kind === "term" &&
		value.expression.term.kind === "literal" &&
		typeof value.expression.term.value === "string"
			? value.expression.term.value
			: undefined;
	const usesDefaultHeader = value.header.trim() === "";
	const setHeader = (header: string) => onChange({ ...value, header });
	const setExpression = (expression: Expression) =>
		onChange({ ...value, expression });
	const { showAs, texts, ...plain } = value;
	const used = new Set<string>();
	walkExpressionNodes(value.expression, (node) => {
		if (node.kind === "case-text") used.add(node.textUuid);
	});
	const pieces = texts ?? [];

	return (
		<div className="space-y-4">
			{pieces.length === 0 && searchResult === undefined && (
				<SegmentedRow
					legend="Show as"
					options={[
						{ value: "plain", label: "Plain text" },
						{ value: "formatted-text", label: "Formatted text" },
						{ value: "translated", label: "Translated text" },
					]}
					value={texts !== undefined ? "translated" : (showAs ?? "plain")}
					onChange={(mode) => {
						if (mode === "translated") onChange({ ...plain, texts: [] });
						else if (mode === "formatted-text")
							onChange({ ...plain, showAs: mode });
						else onChange(plain);
					}}
				/>
			)}
			<div className="[&_input]:!text-[14px]">
				<div className="mb-2 flex items-baseline justify-between gap-3">
					<div className={INSPECTOR_LABEL_CLS}>Label</div>
					{usesDefaultHeader ? (
						<span className="text-[12px] leading-4 text-nova-text-muted">
							Default
						</span>
					) : null}
				</div>
				<BlurCommitTextInput
					value={usesDefaultHeader ? "Calculated value" : value.header}
					onCommit={setHeader}
					ariaLabel="Display label"
				/>
			</div>
			{texts !== undefined && (
				<div className="space-y-2">
					<div className={INSPECTOR_LABEL_CLS}>Translated text</div>
					{pieces.map((piece, index) => (
						<div key={piece.uuid} className="flex items-center gap-2">
							<BlurCommitTextInput
								ariaLabel={`Translated text ${index + 1}`}
								value={piece.label}
								onCommit={(label) =>
									onChange({
										...value,
										texts: pieces.map((item) =>
											item.uuid === piece.uuid ? { ...item, label } : item,
										),
									})
								}
							/>
							<Button
								variant="ghost"
								type="button"
								disabled={used.has(piece.uuid)}
								title={
									used.has(piece.uuid)
										? "This calculation uses this text"
										: undefined
								}
								aria-label={`Remove text ${index + 1}`}
								onClick={() =>
									onChange({
										...value,
										texts: pieces.filter((item) => item.uuid !== piece.uuid),
									})
								}
							>
								Remove
							</Button>
						</div>
					))}
					<Button
						variant="outline"
						type="button"
						onClick={() =>
							onChange({
								...value,
								texts: [...pieces, { uuid: asUuid(v4()), label: "" }],
							})
						}
					>
						Add translated text
					</Button>
				</div>
			)}
			{(offered.length > 0 || searchResult !== undefined) && (
				<div className="space-y-3">
					<div className={INSPECTOR_LABEL_CLS}>Submitted Search answer</div>
					<Select
						value={searchResult?.inputUuid ?? "none"}
						onValueChange={(inputUuid) => {
							if (inputUuid === "none") {
								const { searchResultDetail: _branch, ...ordinary } = value;
								onChange(ordinary);
								return;
							}
							const prompt = offered.find((item) => item.uuid === inputUuid);
							if (prompt)
								onChange({
									...value,
									searchResultDetail: {
										inputUuid: prompt.uuid,
										prefix: searchResult?.prefix ?? "",
										suffix: searchResult?.suffix ?? "",
									},
								});
						}}
					>
						<SelectTrigger aria-label="Submitted Search answer">
							<SelectValue>{selectedPrompt?.label ?? "None"}</SelectValue>
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="none">None</SelectItem>
							{offered.map((prompt) => (
								<SelectItem key={prompt.uuid} value={prompt.uuid}>
									{prompt.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					{searchResult && (
						<div className="space-y-2">
							<BlurCommitTextInput
								ariaLabel="Text before the answer"
								value={searchResult.prefix}
								onCommit={(prefix) =>
									onChange({
										...value,
										searchResultDetail: { ...searchResult, prefix },
									})
								}
							/>
							<BlurCommitTextInput
								ariaLabel="Text after the answer"
								value={searchResult.suffix}
								onCommit={(suffix) =>
									onChange({
										...value,
										searchResultDetail: { ...searchResult, suffix },
									})
								}
							/>
							<BlurCommitTextInput
								ariaLabel="Text outside Search results"
								value={localText ?? ""}
								onCommit={(text) => setExpression(term(literal(text)))}
							/>
						</div>
					)}
				</div>
			)}
			{searchResult === undefined && (
				<div className="space-y-3 rounded-lg border border-white/[0.04] bg-nova-deep/30 p-3.5">
					<div className={INSPECTOR_LABEL_CLS}>Calculation</div>
					{ctx.moduleUuid === undefined ? (
						<p role="status">This field is no longer available.</p>
					) : (
						<ExpressionSlotEditor
							slot={{
								entity: "module",
								uuid: ctx.moduleUuid,
								slot: "case_list_column_expression",
								member: { columnUuid: value.uuid },
							}}
							candidate={{ entity: "column", value }}
							value={value.expression}
							onChange={setExpression}
							caseTypes={ctx.caseTypes}
							currentCaseType={ctx.currentCaseType}
							userProperties={ctx.userProperties}
						/>
					)}
				</div>
			)}
		</div>
	);
}
