"use client";

import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";
import { Icon } from "@iconify/react/offline";
import tablerCircle from "@iconify-icons/tabler/circle";
import tablerCircleDotFilled from "@iconify-icons/tabler/circle-dot-filled";
import {
	type KeyboardEvent,
	type ReactElement,
	type ReactNode,
	useId,
} from "react";

import { selectableRowCls } from "@/lib/styles";
import { cn } from "@/lib/utils";

const NEXT_KEYS: Readonly<Record<string, 1 | -1>> = {
	ArrowDown: 1,
	ArrowUp: -1,
	ArrowRight: 1,
	ArrowLeft: -1,
};

/**
 * The arrow keys move through every row, an unavailable one included.
 *
 * Base UI's composite skips any item that is `aria-disabled` unless the group
 * names its disabled indices, which `RadioGroup` does not expose, so a row
 * that cannot be chosen would drop out of the arrow keys. The group moves
 * focus itself and prevents Base UI's handler (`preventBaseUIHandler`, its
 * documented way to take over an event). Focus does the rest: the item's own
 * focus handler moves the roving tab stop, and selects the row only where it
 * is not read-only and the group has marked the arrow key's touch.
 */
function moveAmongRows(event: KeyboardEvent<HTMLDivElement>): void {
	if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
	const step = NEXT_KEYS[event.key];
	if (step === undefined) return;
	const group = event.currentTarget;
	const rows = Array.from(
		group.querySelectorAll<HTMLElement>('[data-slot="radio-group-item"]'),
	).filter((row) => !row.matches(":disabled"));
	const focused = document.activeElement;
	const current = focused instanceof HTMLElement ? rows.indexOf(focused) : -1;
	if (current === -1) return;
	const rtl = getComputedStyle(group).direction === "rtl";
	const horizontal = event.key === "ArrowLeft" || event.key === "ArrowRight";
	const direction = horizontal && rtl ? -step : step;
	const next = rows[(current + direction + rows.length) % rows.length];
	(event as { preventBaseUIHandler?: () => void }).preventBaseUIHandler?.();
	event.stopPropagation();
	event.preventDefault();
	// As Base UI's own composite does: focus once React has committed the
	// group's `touched`, which the item's focus handler reads to choose.
	queueMicrotask(() => next?.focus());
}

/**
 * One choice among a few full-width rows, each with a label and lines under
 * it. The group owns the value (`value`, `defaultValue`, `onValueChange`) and
 * the arrow keys; name it with `aria-labelledby` or `aria-label`.
 */
function RadioGroup<Value>({
	className,
	onKeyDown,
	...props
}: Omit<RadioGroupPrimitive.Props<Value>, "className"> & {
	readonly className?: string;
}): ReactElement {
	return (
		<RadioGroupPrimitive<Value>
			data-slot="radio-group"
			className={cn("flex w-full flex-col gap-1", className)}
			onKeyDown={(event) => {
				onKeyDown?.(event);
				if (!event.defaultPrevented) moveAmongRows(event);
			}}
			{...props}
		/>
	);
}

/**
 * One row. `children` is the label. The row wears the selectable-row skin,
 * grows past the 44px floor for its lines, and wraps every word rather than
 * truncating one: two choices never read alike.
 *
 * `disabled` is left off on purpose. A row that cannot be chosen takes
 * `unavailableReason`: it stays focusable and reachable by the arrow keys,
 * is `aria-disabled`, keeps its pointer events with `cursor-not-allowed`, a
 * press changes nothing, and the reason is drawn under the row and joined to
 * its accessible description.
 */
function RadioGroupItem<Value>({
	className,
	children,
	description,
	unavailableReason,
	readOnly,
	"aria-describedby": describedBy,
	...props
}: Omit<
	RadioPrimitive.Root.Props<Value>,
	"disabled" | "className" | "aria-labelledby"
> & {
	readonly className?: string;
	/** The lines under the label, part of the row and of its accessible description. */
	readonly description?: ReactNode;
	/**
	 * Why this row cannot be chosen. Given, the row is `aria-disabled`, a press
	 * changes nothing, and this text is drawn under the row and joined to its
	 * description.
	 */
	readonly unavailableReason?: ReactNode;
}): ReactElement {
	const id = useId();
	const labelId = `${id}-label`;
	const descriptionId = `${id}-description`;
	const reasonId = `${id}-reason`;
	const hasDescription = description !== undefined && description !== null;
	const unavailable =
		unavailableReason !== undefined && unavailableReason !== null;
	const describedByIds =
		[
			describedBy,
			hasDescription ? descriptionId : undefined,
			unavailable ? reasonId : undefined,
		]
			.filter((part) => part !== undefined && part !== "")
			.join(" ") || undefined;
	return (
		<RadioPrimitive.Root<Value>
			data-slot="radio-group-item"
			// The label alone names the row; its lines describe it. Without an
			// explicit name the row's whole text, reason included, would be read
			// as its name.
			aria-labelledby={labelId}
			aria-describedby={describedByIds}
			aria-disabled={unavailable || undefined}
			// Base UI's own `readOnly` keeps the row focusable while refusing a
			// press, a Space and the select-on-arrow focus; `aria-disabled` says
			// why to assistive technology.
			readOnly={unavailable || readOnly}
			className={(state) =>
				cn(
					selectableRowCls(state.checked, { focus: "inset", unavailable }),
					"group/radio",
					className,
				)
			}
			{...props}
		>
			{/* The box keeps the shared row's centring, so a one-line row sits
			    centred. Its content is one block that sets the mark, one line
			    tall, beside the label's first line, so a taller row keeps the
			    mark at the top of its text and not in the row's middle. */}
			<span className="flex min-w-0 flex-1 items-start gap-2.5">
				<span
					aria-hidden="true"
					className={cn(
						"flex h-5 shrink-0 items-center [&>svg]:size-4",
						unavailable && "opacity-(--disabled-opacity)",
					)}
				>
					<Icon
						icon={tablerCircle}
						className="text-nova-text-muted group-data-[checked]/radio:hidden"
					/>
					<Icon
						icon={tablerCircleDotFilled}
						className="hidden text-nova-violet-bright group-data-[checked]/radio:block"
					/>
				</span>
				<span className="flex min-w-0 flex-1 flex-col gap-0.5 [overflow-wrap:anywhere]">
					<span
						id={labelId}
						className={cn(unavailable && "opacity-(--disabled-opacity)")}
					>
						{children}
					</span>
					{hasDescription ? (
						<span
							id={descriptionId}
							className={cn(
								"text-[13px] font-normal text-nova-text-muted",
								unavailable && "opacity-(--disabled-opacity)",
							)}
						>
							{description}
						</span>
					) : null}
					{unavailable ? (
						<span
							id={reasonId}
							className="text-[13px] font-normal text-nova-text-secondary"
						>
							{unavailableReason}
						</span>
					) : null}
				</span>
			</span>
		</RadioPrimitive.Root>
	);
}

export { RadioGroup, RadioGroupItem };
