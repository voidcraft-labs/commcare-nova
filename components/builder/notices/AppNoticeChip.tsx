/**
 * The quiet chip in the header band that says this app has updates to
 * review: a ghost `Button` holding a violet `Badge`, counting the notices
 * this member has not dismissed. Nothing opens by itself; the chip opens
 * the dialog, and renders nothing once every notice is dismissed.
 */
"use client";

import { useState } from "react";
import { Badge } from "@/components/shadcn/badge";
import { Button } from "@/components/shadcn/button";
import { useAppId } from "@/lib/session/hooks";
import { AppNoticeDialog } from "./AppNoticeDialog";
import { useAppNotices } from "./AppNoticesContext";
import { appNoticeChipLabel } from "./appNoticeModel";

export function AppNoticeChip() {
	const appId = useAppId();
	const { notices, forget } = useAppNotices();
	const [open, setOpen] = useState(false);
	const label = appNoticeChipLabel(notices);
	if (appId === undefined || label === null) return null;
	return (
		<>
			<Button
				type="button"
				variant="ghost"
				className="px-2"
				onClick={() => setOpen(true)}
			>
				<Badge variant="violet">{label}</Badge>
			</Button>
			<AppNoticeDialog
				appId={appId}
				notices={notices}
				open={open}
				onOpenChange={setOpen}
				onDismissed={forget}
			/>
		</>
	);
}
