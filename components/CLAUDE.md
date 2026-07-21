# components — cross-component frontend conventions

The conventions every React component in the app obeys — builder, chat, preview, landing, docs. Builder-specific behavior (the flipbook, drag-and-drop, the inspector rail, the case-list workspace) lives in `components/builder/CLAUDE.md`.

## Primitives come from `components/shadcn`

`components/shadcn` (shadcn on Base UI, restyled to Nova) is the ONE source of generic controls — button, badge, input, select, switch, checkbox, tooltip (`SimpleTooltip` for the everyday `content`+child case; `TooltipProvider` mounts ONCE in `(app)/layout.tsx`), dialog, alert-dialog, drawer, dropdown-menu, popover, skeleton, spinner, tabs, date-picker (`DatePicker` — the Button + Popover + Calendar composition as ONE component; feature code never assembles that popover itself and never renders a native `<input type="date">`/`"datetime-local"`, whose browser picker pops over Nova's theme), time-field (`TimeField` — locale-clock text entry, example "2:30 PM"; its strict parse/format pair lives in `lib/ui/clockTime.ts`). Never hand-roll one, never use a native `<select>`/`<dialog>`/checkbox, and never reach for raw `@base-ui/react` when a wrapper exists; a missing primitive lands via `npx shadcn add <name>` and then gets the Nova pass (icons → Tabler/iconify, `nova-*` tokens, disabled/hover rules below) — the CLI writes registry-stock files, so re-adding with `--overwrite` reverts the Nova pass; restore it from git if that happens. Composites (checkbox-cards, pickers, editable rows) compose these primitives rather than duplicating them.

A button-acting part (`Button`, any `*Trigger` / `*Close`) whose `render` prop swaps in a non-`<button>` — e.g. `render={<Link/>}` for a link styled as a button — must also pass `nativeButton={false}` (Base UI's documented pattern; its dev warning fires otherwise). The check is against the final DOM element, so `render={<Button/>}` into a trigger needs nothing.

## Icons

Always `@iconify/react/offline` — the default `@iconify/react` export hydrates via effects and renders an empty span for 1–3 frames. Icon data is imported synchronously (the field/module/form kind metadata in `lib/domain` carries `IconifyIcon` object data, not an id string). A missing Tabler icon goes in the project's extras file with SVG from tabler.io. This applies INSIDE `components/shadcn` too — vendored components get every library icon (lucide) swapped to Tabler.

## Inputs

Every `<input>` / `<textarea>` gets `autoComplete="off"` and `data-1p-ignore` (keeps password managers off non-credential fields).

Authored names, labels, and selected values must remain legible in narrow surfaces. Let the containing row/control grow and wrap (`overflow-wrap: anywhere` for imported values with no natural breaks); do not silently truncate distinct choices into the same-looking label. A genuinely fixed compact surface needs an equally accessible full-value disclosure for pointer and keyboard users.

## Floating elements

Use the `components/shadcn` wrappers (`dropdown-menu`, `select`, `popover`, `tooltip`) everywhere, including predicate cards and searchable pickers; never import their raw `@base-ui/react` counterparts in feature code. Rich menus with frozen search or footer regions compose the shared `DropdownMenuPortal`, `DropdownMenuPositioner`, and `DropdownMenuPopup` exports rather than rebuilding those layers. They source their chrome from `lib/styles.ts` (`MENU_*` / `POPOVER_*`), so ordinary and rich menus cannot drift. Those chrome constants carry `nova-floating`: any scroll area inside a floating surface drops the app-wide reserved scrollbar gutter (`globals.css`) so a short list sits flush with the popup edge — never re-add a per-popup gutter workaround; a floating scroll area that genuinely wants a reserved gutter opts back in with `[scrollbar-gutter:stable]`. A roomy `DropdownMenuContent` or `DropdownMenuSubContent` sets `preferredMinWidth` instead of a `min-w-*` class; the wrapper caps that preference against Base UI's collision-safe available width so a menu can't escape a narrow canvas. Never use `@floating-ui/react` in app code. One floating-tree coordinator owns dismiss + focus, so a dropdown with submenus needs a trigger to establish the tree. Put glass / elevated styles on the **positioner**, not the popup — `will-change: transform` on the positioner creates a compositing boundary that breaks a descendant `backdrop-filter`. Option dropdowns use the menu primitive for ARIA (selects open BELOW the trigger — `alignItemWithTrigger` stays off; a translucent glass popup over its own trigger reads as a smear); searchable pickers use autocomplete in uncontrolled mode and commit on item-press — except when the input value must be set programmatically (the GPS picker's address search is controlled with `mode="none"` so a pin-drag's reverse-geocode can overwrite the box and so an async server list replaces local filtering). A real text input nested inside a dropdown must use `handleMenuSearchInputKeyDown` from `lib/ui/menuSearchInput`: Base UI's printable-key typeahead otherwise prevents the browser's text insertion, while navigation, activation, Escape, and Tab still need to reach the menu. Never `createPortal` a fixed-position element to `body` — it causes SSR hydration mismatches, and fixed positioning doesn't need a portal anyway. Floating surfaces come in two tiers: frosted glass and a near-opaque elevated tier that stacks above glass (glass-on-glass loses blur).

## Animation + DOM listeners

Animate with `motion/react` (never `framer-motion`). Time-bounded animations clear their state via `onAnimationEnd` filtered on `e.animationName`, not a timer. Click-outside / Escape / observer listeners clean up through React 19 ref-callback cleanup, not `useEffect`.

## RSC + auth

Pages are Server Components; the server layout is the auth gate (`requireAuth` / `requireAdminAccess` in an RSC parent, props down). Client code must NEVER re-gate on session state — push `'use client'` down to small leaves. The Better Auth client disables refetch-on-focus (the default briefly nulls session data on tab switch, which a re-gating client would misread as signed-out).

A client leaf that branches its render on `useAuth().isPending` will hydration-mismatch: the auth client resolves the session synchronously client-side (`isPending` false on first paint) while SSR has none (`isPending` true), so server and client first-render differ. Gate the first render on a `mounted` flag (see `AccountMenu`).

## Theme

Dark "Violet Monochrome": violet is the single non-semantic accent; success / warning / error hues are reserved for semantic states, never decoration. Every color is a CSS custom property in `globals.css`; never hardcode one — if a one-off color appears, promote it to a token (reuse one, or add a new `--nova-*`). Z-index is a semantic token scale — use the Tailwind classes that reference it.

**Contrast is calibrated into the tokens (WCAG 2.2 AA, 4.5:1 — the theme is dark-only, so every text token must clear it on every surface).** The rules that keep it that way:

- **Brand violet ≠ CTA fill.** `--nova-violet` (#8b5cf6) is the brand *accent* only — borders, glows, the logo, violet-tinted fills, selected states, dots. It is never a fill behind white text (white on it is 4.23:1). White-text CTAs use **`--nova-action`** (indigo, distinct from the brand yet cohesive). Violet *text/links* use `--nova-violet-bright`. The previewed CommCare app keeps violet for its own buttons via `--pv-accent` (a white-safe darkened violet) — that's the user's app, not Nova chrome.
- **Light accents carry dark text.** rose / emerald / amber / orchid (and violet-bright) are light — as a fill they take **dark** text (`text-nova-void`), never white.
- **Don't fade text with opacity.** `text-nova-*/NN` and `opacity-*` on a text element drop it below AA on dark surfaces — use a solid token (`text` → `secondary` → `muted`) for de-emphasis instead. Opacity dimming is only for genuinely inactive/disabled affordances (which WCAG exempts).

**Interaction states** are measured in *perceptual lightness* (oklab L — WCAG relative luminance is not perceptually uniform, so a fixed luminance/contrast step looks uneven across colors). The model is color-independent:

- **Solid-fill hover** = the base mixed one step (14%) toward black in oklab — `--*-hover` tokens are derived with `color-mix(in oklab, <base>, black 14%)`, so every fill's hover reads as the same perceptual darken regardless of color. (Fills darken, not lighten: white text can't survive lightening a light fill.)
- **Foreground icon/text controls** use a 3-rung ladder ~0.3 oklab L apart at each step: idle `text-nova-text-muted` → hover `text-nova-text` → disabled = idle at `opacity-40`.
- **Disabled = `opacity-40` everywhere** (one value; opacity is the universal, color-independent "inactive" signal). Don't reintroduce 30/50/60.
- **Disabled keeps pointer events and shows `cursor-not-allowed`; hover effects are gated so they never fire while disabled** (`not-disabled:hover:` / `not-data-[disabled]:hover:`). `pointer-events-none` would silence the cursor; an ungated hover restyle on a disabled control falsely signals interactivity. The shadcn button/select/switch already encode this — hand-rolled interactive elements must too.
