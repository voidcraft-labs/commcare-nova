// components/builder/shared/ClearConditionButton.tsx
//
// Removing a condition is authored work leaving the app, and it changes
// who is offered the thing it guards — so it is confirmed before it
// commits, wherever it is offered. Sharing the control is what keeps
// that true: the same words on the settings row and on the condition
// screen, rather than one surface asking and the other not.

"use client";

import { useRef, useState } from "react";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/shadcn/alert-dialog";
import { Button } from "@/components/shadcn/button";

export interface ClearConditionButtonProps {
	/** The outcome, in the author's verb: "Always show". */
	readonly label: string;
	/** The decision as a question: "Always show this module?". */
	readonly title: string;
	/** What changes, and that it is undoable. */
	readonly consequence: string;
	readonly onConfirm: () => void;
	readonly disabled?: boolean;
	/** Where focus lands after the dialog closes — normally whatever
	 *  control replaces this one once the condition is gone. */
	readonly finalFocus?: () => HTMLElement | null;
	readonly className?: string;
}

export function ClearConditionButton({
	label,
	title,
	consequence,
	onConfirm,
	disabled = false,
	finalFocus,
	className = "",
}: ClearConditionButtonProps) {
	const triggerRef = useRef<HTMLButtonElement>(null);
	const [confirming, setConfirming] = useState(false);
	return (
		<>
			<Button
				ref={triggerRef}
				type="button"
				variant="destructive"
				size="xl"
				disabled={disabled}
				onClick={() => setConfirming(true)}
				className={`shrink-0 px-3 text-[14px] ${className}`}
			>
				{label}
			</Button>
			<AlertDialog open={confirming} onOpenChange={setConfirming}>
				<AlertDialogContent
					finalFocus={() => finalFocus?.() ?? triggerRef.current}
					className="text-left"
				>
					<AlertDialogHeader>
						<AlertDialogTitle>{title}</AlertDialogTitle>
						<AlertDialogDescription>{consequence}</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							onClick={() => {
								onConfirm();
								setConfirming(false);
							}}
						>
							{label}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}
