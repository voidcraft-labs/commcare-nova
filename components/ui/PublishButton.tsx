/** The named header action that opens Nova's unified publish dialog. */

"use client";

import { Icon } from "@iconify/react/offline";
import tablerRocket from "@iconify-icons/tabler/rocket";
import { Button } from "@/components/shadcn/button";

export function PublishButton({ onClick }: { readonly onClick: () => void }) {
	return (
		<Button type="button" variant="outline" onClick={onClick}>
			<Icon icon={tablerRocket} width={18} height={18} />
			Publish
		</Button>
	);
}
