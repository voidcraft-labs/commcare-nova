import { memo } from "react";
import { TiptapSvg, type TiptapIconProps } from "./TiptapSvg";

/** Generic heading icon (H). */
export const HeadingIcon = memo((props: TiptapIconProps) => (
	<TiptapSvg {...props}>
		<path
			d="M6 3C6.55228 3 7 3.44772 7 4V11H17V4C17 3.44772 17.4477 3 18 3C18.5523 3 19 3.44772 19 4V20C19 20.5523 18.5523 21 18 21C17.4477 21 17 20.5523 17 20V13H7V20C7 20.5523 6.55228 21 6 21C5.44772 21 5 20.5523 5 20V4C5 3.44772 5.44772 3 6 3Z"
			fill="currentColor"
		/>
	</TiptapSvg>
));

HeadingIcon.displayName = "HeadingIcon";
