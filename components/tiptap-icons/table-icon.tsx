import { memo } from "react";
import { TiptapSvg, type TiptapIconProps } from "./TiptapSvg";

/** Table insert icon. */
export const TableIcon = memo((props: TiptapIconProps) => (
	<TiptapSvg
		fill="none"
		stroke="currentColor"
		strokeWidth="2"
		strokeLinecap="round"
		strokeLinejoin="round"
		{...props}
	>
		<rect x="3" y="3" width="18" height="18" rx="2" />
		<line x1="3" y1="9" x2="21" y2="9" />
		<line x1="3" y1="15" x2="21" y2="15" />
		<line x1="9" y1="3" x2="9" y2="21" />
		<line x1="15" y1="3" x2="15" y2="21" />
	</TiptapSvg>
));

TableIcon.displayName = "TableIcon";
