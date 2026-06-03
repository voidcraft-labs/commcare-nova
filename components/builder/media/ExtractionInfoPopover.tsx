// components/builder/media/ExtractionInfoPopover.tsx
//
// A small "info" affordance that explains feature extraction in plain language:
// the assistant works from a structured extract of each document, not the raw
// file. Heads off the "the doc clearly says X, why didn't the assistant see it?"
// confusion by pointing the user at the per-document "What the AI reads" preview.

"use client";

import { Icon } from "@iconify/react/offline";
import tablerInfoCircle from "@iconify-icons/tabler/info-circle";
import {
	Popover,
	PopoverContent,
	PopoverDescription,
	PopoverHeader,
	PopoverTitle,
	PopoverTrigger,
} from "@/components/shadcn/popover";

export function ExtractionInfoPopover() {
	return (
		<Popover>
			<PopoverTrigger
				className="inline-flex size-4 items-center justify-center rounded-full text-nova-text-muted transition-colors hover:text-nova-text focus-visible:outline-1 focus-visible:outline-nova-violet-bright"
				aria-label="What does the assistant read from a document?"
			>
				<Icon icon={tablerInfoCircle} className="size-4" />
			</PopoverTrigger>
			<PopoverContent className="w-80">
				<PopoverHeader>
					<PopoverTitle>What the assistant reads</PopoverTitle>
				</PopoverHeader>
				<PopoverDescription>
					Nova reads a structured{" "}
					<span className="text-nova-text">extract</span> of each document — the
					requirements it can pull out — and the assistant works from that, not
					the raw file. Open any document and switch to{" "}
					<span className="text-nova-text">What the AI reads</span> to see
					exactly what it got. If something's missing there, add it in the chat.
				</PopoverDescription>
			</PopoverContent>
		</Popover>
	);
}
