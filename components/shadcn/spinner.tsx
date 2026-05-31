import { Icon } from "@iconify/react/offline";
import tablerLoader2 from "@iconify-icons/tabler/loader-2";
import { cn } from "@/lib/utils";

// Nova mandates Tabler glyphs via `@iconify/react/offline` (synchronous render,
// no empty-span hydration flash). The spinning ring is Tabler's `loader-2` with
// the standard `animate-spin` utility — the CSS owns the motion, the icon is
// just the glyph. `icon` is omitted from the public props: the glyph is fixed,
// so callers render `<Spinner />` and only override styling.
type SpinnerProps = Omit<React.ComponentProps<typeof Icon>, "icon">;

function Spinner({ className, ...props }: SpinnerProps) {
	return (
		<Icon
			icon={tablerLoader2}
			role="status"
			aria-label="Loading"
			className={cn("size-4 animate-spin", className)}
			{...props}
		/>
	);
}

export { Spinner };
