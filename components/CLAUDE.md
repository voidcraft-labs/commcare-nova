# components — cross-component frontend conventions

The conventions every React component in the app obeys — builder, chat, preview, landing, docs. Builder-specific behavior (the flipbook, drag-and-drop, the inspector rail, the case-list workspace) lives in `components/builder/CLAUDE.md`; the shadcn-derived primitives live in `components/shadcn` (vendoring UI swaps every icon to the project's set and restyles to the theme).

## Icons

Always `@iconify/react/offline` — the default `@iconify/react` export hydrates via effects and renders an empty span for 1–3 frames. Icon data is imported synchronously (the field/module/form kind metadata in `lib/domain` carries `IconifyIcon` object data, not an id string). A missing Tabler icon goes in the project's extras file with SVG from tabler.io.

## Inputs

Every `<input>` / `<textarea>` gets `autoComplete="off"` and `data-1p-ignore` (keeps password managers off non-credential fields).

## Floating elements

Use `@base-ui/react` (never raw `@floating-ui/react` in app code). One floating-tree coordinator owns dismiss + focus, so a `Menu.Root` with submenus needs a `Menu.Trigger` to establish the tree. Put glass / elevated styles on the **positioner**, not the popup — `will-change: transform` on the positioner creates a compositing boundary that breaks a descendant `backdrop-filter`. Option dropdowns use the menu primitive for ARIA; searchable pickers use autocomplete in uncontrolled mode and commit on item-press. Never `createPortal` a fixed-position element to `body` — it causes SSR hydration mismatches, and fixed positioning doesn't need a portal anyway. Floating surfaces come in two tiers: frosted glass and a near-opaque elevated tier that stacks above glass (glass-on-glass loses blur).

## Animation + DOM listeners

Animate with `motion/react` (never `framer-motion`). Time-bounded animations clear their state via `onAnimationEnd` filtered on `e.animationName`, not a timer. Click-outside / Escape / observer listeners clean up through React 19 ref-callback cleanup, not `useEffect`.

## RSC + auth

Pages are Server Components; the server layout is the auth gate (`requireAuth` / `requireAdminAccess` in an RSC parent, props down). Client code must NEVER re-gate on session state — push `'use client'` down to small leaves. The Better Auth client disables refetch-on-focus (the default briefly nulls session data on tab switch, which a re-gating client would misread as signed-out).

## Theme

Dark "Violet Monochrome": violet is the single non-semantic accent; success / warning / error hues are reserved for semantic states, never decoration. Every color is a CSS custom property in `globals.css`; never hardcode one — if a one-off color appears, promote it to a token (reuse one, or add a new `--nova-*`). Z-index is a semantic token scale — use the Tailwind classes that reference it.

**Contrast is calibrated into the tokens (WCAG 2.2 AA, 4.5:1 — the theme is dark-only, so every text token must clear it on every surface).** Two rules keep it that way:

- **Violet has two roles.** `--nova-violet` is the *fill* (it's dark enough to carry white text — primary buttons, badges; hover lifts to `--nova-violet-hover`, still white-safe). `--nova-violet-bright` is the *text/link* color. Never swap them: violet-as-text must be `bright` (the fill is too dark to read on a dark surface), and white text must never sit on `violet-bright` (too light). The other accents (rose/emerald/amber/orchid) are all *light* — as a fill they carry **dark** text (`text-nova-void`), never white.
- **Don't fade text with opacity.** `text-nova-*/NN` and `opacity-*` on a text element drop it below AA on dark surfaces — use a solid token (`text` → `secondary` → `muted`) for de-emphasis instead. Opacity dimming is only acceptable on genuinely inactive/disabled affordances (which WCAG exempts).
