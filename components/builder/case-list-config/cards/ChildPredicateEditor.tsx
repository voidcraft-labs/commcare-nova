// components/builder/case-list-config/cards/ChildPredicateEditor.tsx
//
// Dispatch shell for a single predicate node — looks up the
// schema entry for `value.kind`, delegates rendering to the
// matched card, and frames the card with a kind-replacing menu so
// authors can swap a clause's operator without re-creating the
// surrounding structure.
//
// This is the recursive entry point used by every card that holds
// a nested clause (`not.clause`, `when-input-present.clause`,
// `exists.where`, `and.clauses[i]`, `or.clauses[i]`). The
// PredicateCardEditor at the top of the tree mounts the same
// shell at the root.

"use client";
import { Menu } from "@base-ui/react/menu";
import { Icon } from "@iconify/react/offline";
import { useRef } from "react";
import type { Predicate } from "@/lib/domain/predicate";
import {
	MENU_ITEM_CLS,
	MENU_POPUP_CLS,
	MENU_POSITIONER_CLS,
} from "@/lib/styles";
import { useEditorErrorsAt, usePredicateEditContext } from "../editorContext";
import {
	type PredicateCardSchema,
	type PredicateEditContext,
	predicateCardSchemaList,
	predicateCardSchemas,
} from "../editorSchemas";
import type { EditorPath } from "../path";
import { CardShell } from "../primitives/CardShell";

interface ChildPredicateEditorProps {
	readonly value: Predicate;
	readonly onChange: (next: Predicate) => void;
	readonly path: EditorPath;
	/**
	 * Optional remove handler — when provided, the card surfaces a
	 * "Delete" item in its kebab menu. Cards inside an `and`/`or`
	 * clause list, under a `not` wrapper, etc. carry the affordance;
	 * the top-level editor passes `undefined` (the root card cannot
	 * be deleted, only replaced).
	 */
	readonly onRemove?: () => void;
	/**
	 * Display variant — the top-level card uses `"normal"`; nested
	 * children inside a logical group use `"nested"` so the parent
	 * group's accent doesn't fight the child's surface.
	 */
	readonly variant?: "normal" | "nested";
	/**
	 * Optional ref-callback the parent installs on the card shell's
	 * grip handle for native drag binding. When undefined, the grip
	 * does not render — only cards inside an `and` / `or` clause
	 * list carry a drag affordance.
	 */
	readonly dragHandleRef?: (el: HTMLElement | null) => void;
}

/**
 * Render one predicate as a card. Looks up the registry entry by
 * `value.kind` and dispatches to the matching card component;
 * routes operator-level errors (path === self) to the shell's
 * error footer; passes a kind-replacing menu in the kebab.
 */
export function ChildPredicateEditor({
	value,
	onChange,
	path,
	onRemove,
	variant = "normal",
	dragHandleRef,
}: ChildPredicateEditorProps) {
	const operatorErrors = useEditorErrorsAt(path);
	const schema = predicateCardSchemas[value.kind];
	const Component = schema.component as React.ComponentType<{
		value: Predicate;
		onChange: (next: Predicate) => void;
		path: EditorPath;
	}>;

	return (
		<CardShell
			icon={schema.icon}
			label={schema.label}
			variant={variant}
			onRemove={onRemove}
			dragHandleRef={dragHandleRef}
			errors={operatorErrors}
			kindAccent={
				<KindReplaceMenu currentKind={value.kind} onChange={onChange} />
			}
		>
			<Component value={value} onChange={onChange} path={path} />
		</CardShell>
	);
}

interface KindReplaceMenuProps {
	readonly currentKind: Predicate["kind"];
	readonly onChange: (next: Predicate) => void;
}

/**
 * Menu that replaces the current card's predicate with a different
 * kind. The replacement uses the target schema's `defaultValue(...)`
 * factory so the new predicate is well-typed and visible — the
 * author edits from there.
 *
 * The menu lists every kind, marking the current one with a violet
 * dot. Authors switching from `eq` to `between` keep the property
 * picker they already chose only when the underlying card preserves
 * it; the simple "swap to default" semantic is the structural
 * canonical case for a kind change.
 */
function KindReplaceMenu({ currentKind, onChange }: KindReplaceMenuProps) {
	const triggerRef = useRef<HTMLButtonElement>(null);
	const ctx = usePredicateEditContext();
	const editCtx: PredicateEditContext = {
		caseTypes: ctx.caseTypes,
		currentCaseType: ctx.currentCaseType,
		knownInputs: ctx.knownInputs,
	};

	const replaceWith = <K extends Predicate["kind"]>(
		schema: PredicateCardSchema<K>,
	) => {
		onChange(schema.defaultValue(editCtx));
	};

	return (
		<Menu.Root>
			<Menu.Trigger
				ref={triggerRef}
				aria-label="Change card type"
				className="group flex items-center gap-1 px-1.5 py-0.5 text-[10px] uppercase tracking-wider rounded text-nova-text-muted/60 hover:text-nova-violet-bright hover:bg-white/[0.04] transition-colors cursor-pointer"
			>
				<span>Change</span>
				<svg
					aria-hidden="true"
					width="8"
					height="8"
					viewBox="0 0 10 10"
					className="shrink-0 transition-transform group-data-[popup-open]:rotate-180"
				>
					<path
						d="M2 3.5L5 6.5L8 3.5"
						stroke="currentColor"
						strokeWidth="1.4"
						fill="none"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			</Menu.Trigger>
			<Menu.Portal>
				<Menu.Positioner
					side="bottom"
					align="end"
					sideOffset={4}
					anchor={triggerRef}
					className={MENU_POSITIONER_CLS}
					style={{ maxHeight: 320 }}
				>
					<Menu.Popup
						className={`${MENU_POPUP_CLS} max-h-80 overflow-y-auto min-w-[18rem]`}
					>
						{predicateCardSchemaList.map((s, i) => {
							const isCurrent = s.kind === currentKind;
							const isApplicable = s.applicable(editCtx);
							const last = predicateCardSchemaList.length - 1;
							const corners =
								i === 0 && i === last
									? "rounded-xl"
									: i === 0
										? "rounded-t-xl"
										: i === last
											? "rounded-b-xl"
											: "";
							const cls = [
								corners,
								MENU_ITEM_CLS,
								isCurrent ? "text-nova-violet-bright bg-nova-violet/10" : "",
								isApplicable ? "" : "opacity-40",
							].join(" ");
							return (
								<Menu.Item
									key={s.kind}
									onClick={() => replaceWith(s)}
									disabled={!isApplicable && !isCurrent}
									className={cls}
								>
									<Icon
										icon={s.icon}
										width="14"
										height="14"
										className={
											isCurrent
												? "text-nova-violet-bright"
												: "text-nova-text-muted"
										}
									/>
									<span className="flex-1 text-left min-w-0">
										<div className="truncate">{s.label}</div>
										<div
											className={`text-[10px] truncate ${
												isCurrent
													? "text-nova-violet-bright/60"
													: "text-nova-text-muted"
											}`}
										>
											{s.description}
										</div>
									</span>
								</Menu.Item>
							);
						})}
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	);
}
