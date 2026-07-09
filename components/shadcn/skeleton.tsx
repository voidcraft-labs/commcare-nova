import { cn } from "@/lib/utils";

/**
 * Skeleton loading placeholder.
 *
 * Nova chrome: instead of shadcn's flat `animate-pulse`, a horizontal
 * gradient sweep from `--nova-surface` through a faint violet-tinted
 * highlight — a pulse against Nova's dark surfaces is nearly invisible,
 * while the shimmer reads clearly. Size (and `rounded-full` for circles)
 * comes from `className`.
 *
 * Server component — composable into `loading.tsx` files and Suspense
 * fallbacks without a client boundary.
 */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="skeleton"
			aria-hidden="true"
			className={cn(
				"animate-shimmer rounded-md bg-[linear-gradient(90deg,var(--nova-surface)_0%,var(--nova-violet-wash)_40%,var(--nova-surface)_80%)] bg-[length:200%_100%]",
				className,
			)}
			{...props}
		/>
	);
}

export { Skeleton };
