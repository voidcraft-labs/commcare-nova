# components: cross-component frontend conventions

The conventions every React component in the app obeys: builder, chat, preview, landing, docs. Builder-specific behavior (the flipbook, drag-and-drop, the inspector rail, the case-list workspace) lives in `components/builder/CLAUDE.md`.

## Design-system authority

The **CommCare Nova design system** leads. It is a Claude Design project
(`719bad67-96ae-4c3a-8d35-f5c2029c9f51`, readable through the claude_design MCP)
and it owns the palette, the type scale, the control anatomy, the interaction
model, the brand, and the voice. Where it and this codebase disagree, the design
system is right and the code is the thing to change. Its `tokens/*.css` are the
values of record; its `readme.md` is the intent; the `components/core/*.prompt.md`
files are each primitive's contract.

**Google Material 3** remains useful background for foundations, adaptive
layout, accessibility, and content hierarchy, and **Apple HIG** for platform
polish, but neither overrides a Nova rule, and neither is permission to copy
another product's authoring model or component catalog.

The project owner's current Material 3 distillation is available to Codex at
`/Users/braxtonperry/work/personal/docs/material3_design_system.md`. That path is
an execution reference, not a repo or build dependency. A supervisor or reviewer
with access reads the relevant sections while preparing a UI slice and records
every concrete new rule here or in the nearest subtree `CLAUDE.md`. Implementers
then follow the repo-recorded contract; no shipped decision or delegated task may
require undocumented access to a personal file.

Precedence is: accessibility and semantic behavior; the feature's explicit Nova
product/UX contract; the Nova design system's tokens, components, and voice;
Material 3; then Apple HIG polish. In practice:

- use semantic HTML, landmarks/headings, logical DOM and focus order, visible
  keyboard focus, and trigger-to-surface focus entry/return;
- design adaptive behavior, not a scaled desktop canvas: review compact, medium,
  expanded, large, and extra-large widths and deliberately show/hide, reflow, or
  swap panes and navigation;
- give every control the one 44px height (`--hit-target`); it is a floor for
  pointer targets and the exact height of buttons, inputs, and toggles alike,
  with adequate spacing and keyboard alternatives;
- represent enabled, disabled, hover, focus, pressed, selected, and dragged
  states consistently with the established Nova semantic tokens and more than
  color alone; and
- use restrained motion to explain state or spatial relationship, respect
  reduced motion, stabilize loading layouts, and make exits faster than entries.

`components/shadcn` remains the implementation source of generic controls. M3
guidance shapes their use and Nova's system; it does not bypass the wrappers or
introduce one-off Android-styled controls.

## Primitives come from `components/shadcn`

`components/shadcn` (shadcn on Base UI, restyled to Nova) is the ONE source of generic controls, button, badge, input, select, switch, checkbox, tooltip (`SimpleTooltip` for the everyday `content`+child case; `TooltipProvider` mounts ONCE in `(app)/layout.tsx`), dialog, alert-dialog, drawer, dropdown-menu, popover, skeleton, spinner, tabs, date-picker (`DatePicker`, the Button + Popover + Calendar composition as ONE component; feature code never assembles that popover itself and never renders a native `<input type="date">`/`"datetime-local"`, whose browser picker pops over Nova's theme), time-field (`TimeField`, locale-clock text entry, example "2:30 PM"; its strict parse/format pair lives in `lib/ui/clockTime.ts`). Never hand-roll one, never use a native `<select>`/`<dialog>`/checkbox, and never reach for raw `@base-ui/react` when a wrapper exists; a missing primitive lands via `npx shadcn add <name>` and then gets the Nova pass (icons → Tabler/iconify, `nova-*` tokens, disabled/hover rules below), the CLI writes registry-stock files, so re-adding with `--overwrite` reverts the Nova pass; restore it from git if that happens. Composites (checkbox-cards, pickers, editable rows) compose these primitives rather than duplicating them.

**A primitive rendered inside the previewed app has to be re-pointed at the `--pv-*` palette, and the override needs a `dark:` twin.** `app/layout.tsx` puts `dark` on `<html>` permanently, so a primitive's own `dark:bg-input/30` / `dark:border-input` is always live and a bare `bg-*`/`border-*` passed from a call site loses to it, pass both variants (`components/preview/form/fields/DateField.tsx` carries the worked example). Only re-point what actually differs: `--ring` and `--destructive` already resolve to the violet and rose the preview uses, so focus and error states need nothing. A token remap scoped to `.preview-theme` would retire these strings, but that wrapper also holds Nova chrome, so it is its own change.

A button-acting part (`Button`, any `*Trigger` / `*Close`) whose `render` prop swaps in a non-`<button>`, e.g. `render={<Link/>}` for a link styled as a button, must also pass `nativeButton={false}` (Base UI's documented pattern; its dev warning fires otherwise). The check is against the final DOM element, so `render={<Button/>}` into a trigger needs nothing.

## Icons

Always `@iconify/react/offline`: the default `@iconify/react` export hydrates via effects and renders an empty span for 1–3 frames. Icon data is imported synchronously (the field/module/form kind metadata in `lib/domain` carries `IconifyIcon` object data, not an id string). A missing Tabler icon goes in the project's extras file with SVG from tabler.io. This applies INSIDE `components/shadcn` too, vendored components get every library icon (lucide) swapped to Tabler.

## Inputs

Every `<input>` / `<textarea>` gets `autoComplete="off"` and `data-1p-ignore` (keeps password managers off non-credential fields).

A label + control + helper-text + error stack is `Field` / `FieldLabel` / `FieldDescription` / `FieldError` from `components/shadcn/field.tsx` (`FieldGroup` for the stack, `FieldSet` + `FieldLegend` for a named group, a fieldset's legend is also what names the group for a screen reader, and for a Playwright `getByRole("group", { name })`). Hand-rolling that as `div` + `Label` + `p` re-invents the type scale and spacing per surface, which is how one dialog ended up a notch smaller than the rest of the app.

**No call site raises a control to the touch floor, because there is nothing to raise.** `Button`, `Input`, `Textarea`, `SelectTrigger`, and `Switch` are each exactly 44px in their one size; none takes a `size` prop except `Button`'s `size="icon"`, which is the same 44px as a square. A `SelectTrigger` that has to show a long authored value across several lines passes `wrapValue`, which swaps its fixed height for `min-h-11` and keeps the value and chevron centred; that is the only height variation in the set.

Authored names, labels, and selected values must remain legible in narrow surfaces. Let the containing row/control grow and wrap (`overflow-wrap: anywhere` for imported values with no natural breaks); do not silently truncate distinct choices into the same-looking label. A genuinely fixed compact surface needs an equally accessible full-value disclosure for pointer and keyboard users.

## Dialogs

**Only the middle of a dialog scrolls.** `DialogContent` / `AlertDialogContent` is a flex COLUMN that caps its own height; the header and footer are `shrink-0` and the content between them goes in `DialogBody` / `AlertDialogBody`, which takes the remaining height and scrolls inside it. Wrap it, a dialog whose middle is left bare falls back to scrolling the whole panel, which puts the actions below the fold and carries the title and the close button off the top, so the user has to scroll back up to dismiss what they opened.

Three rules make that hold everywhere:

- **A wrapper between the panel and the header/footer defeats it.** `shrink-0` only reaches direct flex children, so a dialog whose panel holds a single `<form>` (or any grouping div) has to put `flex min-h-0 flex-1 flex-col` on THAT element and the body inside it.
- **A confirmation with no middle is handled for you.** A header sitting directly on the footer becomes the scroller itself (`[&:has(+[data-slot=…-footer])]` in both primitives), so the question scrolls and the choice stays, no call-site change and no second scrollbar when a body IS present.
- **The body's negative inline margin is load-bearing.** It cancels the panel's `p-5` and re-applies it to the content, putting the scroll track hard against the panel's inside edge rather than floating 20px in. The panels also set `[scrollbar-gutter:auto]`, because the app-wide `stable` gutter would otherwise reserve a second dead strip on a panel that no longer scrolls. A panel with its own padding (`p-0` + custom chrome) passes `className="mx-0 px-0"`.

## Floating elements

Use the `components/shadcn` wrappers (`dropdown-menu`, `select`, `popover`, `tooltip`) everywhere, including predicate cards and searchable pickers; never import their raw `@base-ui/react` counterparts in feature code. Rich menus with frozen search or footer regions compose the shared `DropdownMenuPortal`, `DropdownMenuPositioner`, and `DropdownMenuPopup` exports rather than rebuilding those layers. They source their chrome from `lib/styles.ts` (`MENU_*` / `POPOVER_*`), so ordinary and rich menus cannot drift. `MENU_ITEM_BASE` owns the item BOX, its 44px floor, padding, wrapping, and vertical centering: an item already grows for a second line (a description or a disabled reason) and centers its content at any height, so a call site that re-states `min-h-11`/`py-*` or re-aligns with `items-start` only reintroduces the top-heavy one-line item that centralizing fixed. Style the item's CONTENT, never its box. Those chrome constants carry `nova-floating`: any scroll area inside a floating surface drops the app-wide reserved scrollbar gutter (`globals.css`) so a short list sits flush with the popup edge, never re-add a per-popup gutter workaround; a floating scroll area that genuinely wants a reserved gutter opts back in with `[scrollbar-gutter:stable]`. A roomy `DropdownMenuContent` or `DropdownMenuSubContent` sets `preferredMinWidth` instead of a `min-w-*` class; the wrapper caps that preference against Base UI's collision-safe available width so a menu can't escape a narrow canvas. Never use `@floating-ui/react` in app code. One floating-tree coordinator owns dismiss + focus, so a dropdown with submenus needs a trigger to establish the tree. Put glass / elevated styles on the **positioner**, not the popup, `will-change: transform` on the positioner creates a compositing boundary that breaks a descendant `backdrop-filter`. **Surface and stacking plane are separate axes: the `MENU_*` / `POPOVER_*` constants describe a surface and carry no `z-*`, so every positioner states its plane itself with `FLOATING_LAYER_CLS`.** These elements portal to `document.body` and therefore stack in the ROOT context against dialogs, one that declares no plane paints by DOM order and reads as "the menu opened but nothing appeared". `FLOATING_LAYER_CLS` is `z-modal`, co-planar with dialogs, so a select or popover opened INSIDE a dialog floats above it and portal order (later mount paints later) settles ties; `z-tooltip` is the one deliberate step above. The tiers *below* it (`z-popover`, `z-popover-top`) are for in-flow overlays that stack inside an ancestor rather than escaping to the body, reaching for one on a positioner is what put an XPath validation alert behind the dialog hosting the field. A source sweep in `lib/__tests__/styles.test.ts` fails any positioner that declares no plane. Option dropdowns use the menu primitive for ARIA (selects open BELOW the trigger, `alignItemWithTrigger` stays off; a translucent glass popup over its own trigger reads as a smear); searchable pickers use autocomplete in uncontrolled mode and commit on item-press, except when the input value must be set programmatically (the GPS picker's address search is controlled with `mode="none"` so a pin-drag's reverse-geocode can overwrite the box and so an async server list replaces local filtering). A real text input nested inside a dropdown must use `handleMenuSearchInputKeyDown` from `lib/ui/menuSearchInput`: Base UI's printable-key typeahead otherwise prevents the browser's text insertion, while navigation, activation, Escape, and Tab still need to reach the menu. Never `createPortal` a fixed-position element to `body`, it causes SSR hydration mismatches, and fixed positioning doesn't need a portal anyway. Floating surfaces come in two tiers: frosted glass and a near-opaque elevated tier that stacks above glass (glass-on-glass loses blur).

## Animation + DOM listeners

Animate with `motion/react` (never `framer-motion`). Time-bounded animations clear their state via `onAnimationEnd` filtered on `e.animationName`, not a timer. Click-outside / Escape / observer listeners clean up through React 19 ref-callback cleanup, not `useEffect`.

## RSC + auth

Pages are Server Components; the server layout is the auth gate (`requireAuth` / `requireAdminAccess` in an RSC parent, props down). Client code must NEVER re-gate on session state, push `'use client'` down to small leaves. The Better Auth client disables refetch-on-focus (the default briefly nulls session data on tab switch, which a re-gating client would misread as signed-out).

A client leaf that branches its render on `useAuth().isPending` will hydration-mismatch: the auth client resolves the session synchronously client-side (`isPending` false on first paint) while SSR has none (`isPending` true), so server and client first-render differ. Gate the first render on a `mounted` flag (see `AccountMenu`).

## Theme

Dark "Twilight and first light": a four-step warm plum surface stack (`#171221` page → `#1d1729` wells → `#251d34` cards → `#2f2543` raised), lit by Nova's lilac and a low wash of dawn. Violet is the single non-semantic accent; emerald / amber / rose are reserved for semantic state, never decoration; dawn and orchid are light and presence, never controls. Every color is a CSS custom property in `globals.css`; never hardcode one, if a one-off color appears, promote it to a token (reuse one, or add a new `--nova-*`). Z-index is a semantic token scale, use the Tailwind classes that reference it. `cn` is taught that scale (`lib/utils.ts::Z_INDEX_SCALE`), so passing a later `z-*` token genuinely REPLACES an earlier one; add any new `--z-index-*` key there too, or the drift test in `lib/__tests__/utils.test.ts` fails. Without that list tailwind-merge keeps both classes and generated-stylesheet order (alphabetical by token name) picks the winner, which is how a Select popup meant for `z-modal` sat at `z-popover-top` and rendered behind the dialog that opened it, open but invisible.

**Contrast is calibrated into the tokens (WCAG 2.2 AA, 4.5:1; the theme is dark-only, so every text token must clear it on every surface).** The rules that keep it that way:

- **Light is action.** `--nova-action` (the luminous lilac `--nova-violet-bright`) is the primary CTA fill, and it is the brightest thing on the page. There is no separate "blue'd" button hue. `--nova-violet` stays the brand accent: borders, glow, the logo, violet-tinted fills, selected states, dots.
- **No fill carries white text.** Every accent fill (action lilac, dawn, emerald, amber, rose, orchid) is luminous and takes dusk text, `--nova-action-ink` (which is `--nova-void`, 8.2:1 under the CTA). `text-white` on a fill is always wrong.
- **Dawn is light, never a control.** `--nova-dawn` is the logomark's crescent, the low warm bloom behind hero surfaces, and rare quiet celebration. Never a border, never a fill, never semantic.
- **Don't fade text with opacity.** `text-nova-*/NN` and `opacity-*` on a text element drop it below AA on dark surfaces; step down the solid ladder (`text` → `secondary` → `muted`) instead. Opacity dimming is only for genuinely disabled affordances, which WCAG exempts.

**Interaction states** are measured in *perceptual lightness* (oklab/oklch L, because WCAG relative luminance is not perceptually uniform, so a fixed luminance step looks uneven across colors). The model is color-independent:

- **Hover is always more light, never less.** A solid fill hovers to the base mixed one step (10%) toward white in oklch: the `--*-hover` tokens are `color-mix(in oklch, <base>, white 10%)`. The oklch mix holds the hue so nothing washes out, and dusk text gains contrast as the fill lifts. CTAs add a glow swell. A hover that dims or fades is a bug.
- **Buttons are soft keycaps.** A crown gradient lit from above over a darker side wall `--key-wall` (3px) tall, and press is real travel: the cap sinks as the wall collapses. The whole anatomy lives in the `.nova-keycap-*` classes in `globals.css`; `components/shadcn/button.tsx` only picks a variant and lays out the label. Ghost and link stay flat text-tier with a 1px press nudge, which is exactly what makes the keycaps read as actionable beside them.
- **One control height, no ladder.** Button = input = toggle = 44px (`--hit-target`), each in exactly one size. `size="icon"` is that same 44px as a square. The floor also covers menu items, composer controls, dialog actions, and icon buttons near text. **If a layout seems to need a smaller button, change the layout, never the button.**
- **A className on a Button sets layout, never anatomy.** Width, margin, and grid placement are fine; height, padding, radius, color, and shadow are the variant's job. The same rule covers a `*Trigger` whose `render` is a Button: its className merges onto that Button, so anatomy spelled there is the same override one step removed. **If a layout looks like it needs a smaller control, change the layout** — a strip that can't hold four real-sized tabs scrolls sideways, an action that can't sit beside a heading takes its own row.
- **The variants, and what each is for.** The design system names seven (`default` the lilac keycap, `secondary`, `outline`, `destructive`, `warning`, `ghost`, `link`). Nova adds three, and between them they cover everything that used to be reached by overriding: `ghost-destructive` and `ghost-action` are ghost's semantic siblings, identical anatomy with the hue as the only difference, for the inline icon and text actions whose intent is destructive or constructive and where a rose or lilac keycap would shout; `field` is a trigger that PRESENTS a value and opens a menu (the expression-card pickers, "which case does this change", the date picker), wearing the input's anatomy instead of a crown and growing rather than truncating an authored name.
- **Four shapes are not Buttons at all**, and live as shared treatments in `lib/styles.ts` because each was previously re-spelled at every call site: `DISCLOSURE_ROW_CLS` (a "More settings" trigger that spans its container and reveals rather than acts), `LIST_ROW_CLS` / `LIST_ROW_INTERACTIVE_CLS` (the primary target filling a card row edge to edge — pick by whether the row around it already lights up, because two nested hovers is a seam), `POPOVER_ROW_CLS` (a choice in a popover, sharing the real menu-item box), and `selectableRowCls` / `selectableSegmentCls` / `selectableIconCls` (a control that holds a SELECTED state — three boxes over one skin, so a selected tab and a selected sidebar row read as the same idea in different geometry).
- **A state the primitive already draws needs no branch.** `aria-invalid` and `disabled` are styled by the button itself; passing the attribute and then also spelling out a rose border or a dimmed label says it twice and lets the two drift.
- **Foreground icon/text controls** climb a 3-rung ladder: idle `text-nova-text-secondary` → hover `text-nova-text` → disabled = idle at `--disabled-opacity`.
- **Disabled = `opacity-(--disabled-opacity)` (0.6) everywhere**, one value, calibrated so keycap labels hold ≥3.6:1 and secondary-base text ≥3:1 on every surface in the stack. Don't reintroduce 30/40/50.
- **Disabled keeps pointer events and shows `cursor-not-allowed`; hover effects are gated so they never fire while disabled** (`not-disabled:hover:` / `not-data-[disabled]:hover:`). `pointer-events-none` would silence the cursor; an ungated hover restyle on a disabled control falsely signals interactivity. The shadcn button/select/switch already encode this, and hand-rolled interactive elements must too.
- **One keyboard focus ring, keyboard-only.** Violet-bright border plus a soft 3px ring at 45% alpha. Anything focusable that is not already a Button, Input, Textarea, or Select wears `.nova-focusable` (or `.nova-focusable-inset` inside a clipping parent, `.nova-focusable-within` on a wrapper) rather than inventing a ring. A mouse press never leaves a standing ring.
- **Radius is soft everywhere.** Inputs and cards 12px (`rounded-lg`); buttons, dialogs, menus, and popovers 18px (`rounded-xl`); the composer 24px; badges are full pills. Genuinely round is reserved for toggles and the brand dot.
- **Motion settles, never snaps.** Default UI transitions are 0.2s; entrances fade and rise on `--ease-out`; ambient motion (the 3.6s breath, blooms) is slow enough to ignore. Reduced motion uses near-zero durations, not `none`, so lifecycles still complete.

**Voice.** Sentence case everywhere except the product name, which is always lowercase `commcare nova`. No em dashes, in UI copy or docs or code comments; a comma, a colon, or a new sentence carries the aside. No ellipsis in buttons, menu items, or placeholders, including in-progress labels ("Creating blank app", not "Creating blank app…"). Skip the period on single-line labels, tooltips, placeholders, and one-sentence dialog bodies. Use contractions, spell out Latin abbreviations, write "and" not "&", and use `·` as the metadata separator. Errors take responsibility and offer the next step. No emoji.
