import tablerSourceCode from "@iconify-icons/tabler/source-code";
import { memo } from "react";
import { TiptapIcon, type TiptapIconProps } from "./TiptapSvg";

export const CodeBlockIcon = memo(({ className }: TiptapIconProps) => (
	<TiptapIcon icon={tablerSourceCode} className={className} />
));

CodeBlockIcon.displayName = "CodeBlockIcon";
