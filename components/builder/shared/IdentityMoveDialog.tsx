// components/builder/shared/IdentityMoveDialog.tsx
//
// The builder's one identity-move dialog. A builder edit, undo or redo, or
// the replay of edits a publish overtook, whose admitted batch moves where
// CommCare HQ keeps answers a published app already keeps does not commit:
// it waits in the session store's `pendingIdentityMove`, and this dialog
// states each move before anything
// changes. Make the change commits the waiting batch through `commitStated`
// (as that history step for an undo or a redo, and as one new edit for the
// replay of edits a publish overtook); Cancel, or Leave it for that replay,
// drops it, so nothing reaches the document or the reconciler. While it
// waits, every other builder write is refused (`builderWriteAdmission`).

"use client";

import { Button } from "@/components/shadcn/button";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/shadcn/dialog";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import type { PendingIdentityMove } from "@/lib/doc/pendingIdentityMove";
import {
	useClearPendingIdentityMove,
	usePendingIdentityMove,
} from "@/lib/session/hooks";
import { IdentityMoveList, identityMoveLead } from "./IdentityMoveList";

const TITLE = "This changes where CommCare HQ keeps some answers";

export function IdentityMoveDialog() {
	const pending = usePendingIdentityMove();
	const clear = useClearPendingIdentityMove();
	return (
		<Dialog
			open={pending !== null}
			onOpenChange={(open) => {
				if (!open) clear();
			}}
		>
			{pending !== null && (
				<IdentityMoveDialogContent pending={pending} onCancel={clear} />
			)}
		</Dialog>
	);
}

function IdentityMoveDialogContent({
	pending,
	onCancel,
}: {
	readonly pending: PendingIdentityMove;
	readonly onCancel: () => void;
}) {
	/* The announcing flavor: a batch the freshest document now refuses is
	 * announced as the error toast, and the dialog closes either way. */
	const { commitStated } = useBlueprintMutations();
	return (
		<DialogContent
			className="text-left sm:max-w-lg"
			showCloseButton={false}
			data-identity-move-dialog
		>
			<DialogHeader>
				<DialogTitle className="font-display tracking-tighter">
					{TITLE}
				</DialogTitle>
				<DialogDescription className="text-left">
					{identityMoveLead(pending.origin)}
				</DialogDescription>
			</DialogHeader>
			<DialogBody>
				<IdentityMoveList moves={pending.moves} />
			</DialogBody>
			<DialogFooter className="flex-col-reverse sm:flex-row">
				<Button type="button" variant="outline" onClick={onCancel}>
					{pending.origin === "conflict" ? "Leave it" : "Cancel"}
				</Button>
				<Button
					type="button"
					onClick={() => {
						commitStated(pending.batch, pending.origin);
					}}
				>
					Make the change
				</Button>
			</DialogFooter>
		</DialogContent>
	);
}
