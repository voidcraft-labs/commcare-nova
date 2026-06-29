/**
 * Help menu — a header dropdown (styled like the Project switcher) that groups
 * the Docs and Give-Feedback links behind one control so the top bar stays
 * uncluttered. Both open in a new tab.
 */

"use client";

import { Popover } from "@base-ui/react/popover";
import { Icon } from "@iconify/react/offline";
import tablerBook from "@iconify-icons/tabler/book";
import tablerChevronDown from "@iconify-icons/tabler/chevron-down";
import externalLinkIcon from "@iconify-icons/tabler/external-link";
import tablerHelpCircle from "@iconify-icons/tabler/help-circle";
import tablerMessage from "@iconify-icons/tabler/message";
import Link from "next/link";
import { useState } from "react";
import { POPOVER_POPUP_CLS, POPOVER_POSITIONER_GLASS_CLS } from "@/lib/styles";

const FEEDBACK_FORM_URL =
	"https://docs.google.com/forms/d/e/1FAIpQLSdUHQuE9kYhG-py9pojdCDc5ChSrl2LnhLofY4kDlOQi6ghGw/viewform";

/* Both links open in a new tab. Only the Docs URL differs by env: dev serves
 * the docs in-tree at `/docs` (so local edits preview), while prod points at the
 * `docs.commcare.app` subdomain — the main host doesn't serve `/docs` under the
 * multi-host routing. `process.env.NODE_ENV` is inlined by Next at build time. */
const DOCS_HREF =
	process.env.NODE_ENV === "development"
		? "/docs"
		: "https://docs.commcare.app/";

const ITEM_CLS =
	"flex w-full items-center gap-2.5 px-3 py-2 text-sm text-nova-text transition-colors hover:bg-white/[0.06] cursor-pointer";

export function HelpMenu() {
	const [open, setOpen] = useState(false);

	return (
		<Popover.Root open={open} onOpenChange={setOpen}>
			<Popover.Trigger
				aria-label="Help"
				className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-nova-text-muted transition-colors hover:text-nova-text hover:bg-white/5 focus-visible:ring-2 focus-visible:ring-nova-violet focus-visible:outline-none cursor-pointer"
			>
				<Icon
					icon={tablerHelpCircle}
					width="16"
					height="16"
					className="shrink-0"
				/>
				<span className="font-medium">Help</span>
				<Icon
					icon={tablerChevronDown}
					width="14"
					height="14"
					className="shrink-0"
				/>
			</Popover.Trigger>

			<Popover.Portal>
				<Popover.Positioner
					side="bottom"
					align="end"
					sideOffset={6}
					className={POPOVER_POSITIONER_GLASS_CLS}
				>
					<Popover.Popup className={POPOVER_POPUP_CLS}>
						<div style={{ minWidth: "200px" }}>
							<Link
								href={DOCS_HREF}
								target="_blank"
								rel="noopener noreferrer"
								onClick={() => setOpen(false)}
								className={`${ITEM_CLS} rounded-t-xl`}
							>
								<Icon
									icon={tablerBook}
									width="16"
									height="16"
									className="shrink-0 text-nova-text-muted"
								/>
								<span className="flex-1 text-left">Docs</span>
								<Icon
									icon={externalLinkIcon}
									width="14"
									height="14"
									className="shrink-0 text-nova-text-muted"
								/>
							</Link>
							<Link
								href={FEEDBACK_FORM_URL}
								target="_blank"
								rel="noopener noreferrer"
								onClick={() => setOpen(false)}
								className={`${ITEM_CLS} rounded-b-xl`}
							>
								<Icon
									icon={tablerMessage}
									width="16"
									height="16"
									className="shrink-0 text-nova-text-muted"
								/>
								<span className="flex-1 text-left">Give Feedback</span>
								<Icon
									icon={externalLinkIcon}
									width="14"
									height="14"
									className="shrink-0 text-nova-text-muted"
								/>
							</Link>
						</div>
					</Popover.Popup>
				</Popover.Positioner>
			</Popover.Portal>
		</Popover.Root>
	);
}
