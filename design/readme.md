# CommCare Nova design system

> A warm light for building CommCare apps from conversation.

**CommCare Nova** is a web app that generates [CommCare](https://www.commcarehq.org/) applications from natural-language conversation. You describe what you need (workflows, who collects data, what cases to track) and Nova builds a fully structured CommCare app: forms, case management, logic, and all. It is built by **Dimagi**, and sign-in is gated to authorized Dimagi accounts.

**Nova** is the agent you talk to; **CommCare Nova** is the product. The distinction matters, because the whole interface takes its temperature from her. CommCare HQ ("CommCare Classic") earned years of user frustration, and Nova exists as the answer: a product whose deepest feature is *being excellent to the people using it*. Valid-by-construction app building, patient explanations, no dead ends. The design system's job is to make every screen feel the way Nova sounds.

The product is a single Next.js service serving three surfaces:

- **`commcare.app`**, the builder app. A chat-driven Solutions Architect agent converses, generates, and edits the app blueprint live; a structure tree and form preview sit alongside the conversation.
- **`docs.commcare.app`**, the public documentation site.
- **`mcp.commcare.app`**, an MCP API exposing the agent's tools to external clients such as Claude Code.

---

## This document and the code

This design system is the intent; the codebase is the implementation. `app/globals.css` carries the `--nova-*` tokens, `lib/styles.ts` the interaction-state model and floating-surface chrome, `app/layout.tsx` the three Google fonts, and `components/shadcn/` the generic shadcn-on-Base-UI primitives, all restyled to Nova. Where a value here and the implementation disagree, this document is right and the code is the thing to change (`components/CLAUDE.md` § Design-system authority). The retired neural signal display (`components/chat/SignalGrid.tsx` and friends) survives only in dev-only test pages; do not recreate it.

The system also lives as a Claude Design project of the same name, where design exploration happens; this folder is the copy the repo reads.

---

## The Nova brand in one breath

**A kind, brilliant presence in a warm dusk. Vibrant yet calm.** Working with Nova should feel like building something hard next to someone patient and quietly delighted to help. She's present, she never rushes you, and the room is soft: a plum twilight lit by her lilac glow and a low wash of dawn. The cosmos is Nova's *inspiration*, not her costume. It survives as atmosphere (a night-sky palette, a breathing star of a logo, lavender code syntax) and as occasional small winks inside the experience, never as cockpits, control panels, etched bezels, or machinery.

The feelings to hit: **vibrant yet calm, present, patient, friendly, open. A warm, feminine energy.**
The feelings to never produce: **technical, stiff, tight, confusing, overwhelming, angry, pushy, masculine, forceful.**
If a screen reads like equipment to operate, it isn't Nova yet. If it reads like company while you work, it is.

## The design posture: UX before everything

Nova's craft shows up as ergonomics first, aesthetics second:

- **Comfortable targets.** 44px (`--hit-target`) is the floor for menu items, composer controls, dialog actions, and icon buttons near text. **Controls share one 44px height**: button = input = toggle, each in exactly one size (the toggle's *visible* track is a lighter 32px pill inside its 44px hit area, so a solid pill doesn't outweigh bordered fields). The hit-target floor *is* the control; there is no small/medium/large ladder anywhere.
- **Calm status, always.** "System is working" is one plain-language row (a spinner plus "Building your app" / "Your app is ready"), plus a **generation progress card** on the canvas during builds (Set Up → Build → Done stepper over a violet gradient track). Waits get reassurance ("Still building. Big apps take a minute or two."); recovery says "Trying again" in amber; the error status is plain and honest ("Couldn't build your app"), with the chat offering the next step. No console theatrics, ever.
- **Soft, round geometry.** Inputs and cards at 12px (`--radius-lg`); buttons, dialogs, menus, and popovers at 18px (`--radius-xl`); the composer at 24px; badges are full pills. Genuinely round stays reserved for toggles and the brand dot.
- **A perceptual interaction model.** State distance is measured in perceptual steps, so every control's hover reads as the same amount of change. **Hover is always more light, never less**: solid fills brighten one step (`color-mix(in oklch, base, white 10%)`, the derived `*-hover` tokens; oklch holds the hue so nothing washes out, and dusk text gains contrast as the fill lifts), and CTAs add a glow swell. Foreground icon and text controls climb a 3-rung ladder (secondary → text → disabled). **Disabled is opacity 0.6 everywhere** (`--disabled-opacity`, calibrated so keycap labels hold ≥3.6:1 and secondary-base text ≥3:1 on every surface), keeps pointer events, and shows `cursor: not-allowed` with hover restyles gated off. **Buttons are soft keycaps**: a crown gradient lit from above over a 3px darker side wall (the `--nova-key-*` / `--nova-wall-*` tokens, `--key-wall` tall), so press is real travel and the cap sinks 3px as the wall collapses. Text-only controls (ghost, link, icon buttons) stay flat and keep a 1px press nudge, which is exactly what makes the keycaps read as actionable next to them. A keycap's SKIN changes in one frame (crown gradients can't tween, so fill, border, shadow, and travel are pinned to land together; only opacity eases): what reads as travel is the sunk cap being held, not the journey down. **Selected is a state, not a button**: tabs, sidebar destinations, and rail icons share one skin (violet tint at 15%, violet-bright text, and a hairline drawn INSIDE via inset shadow (`--nova-violet-hairline`) so selecting never changes size) and still answer hover one step toward light (tint to 25%), never by dimming; radius follows the neighbors (segments/rail icons take the button's 18px, rows the menu item's 12px). Menu and popover rows highlight with a quiet `rgba(255,255,255,0.06)` wash. "Add something here" is an empty place, not a solid control: flat and DASHED (`.nova-add-slot`), brightening to violet on hover. Focus is ONE treatment in three classes: `.nova-focusable` (violet-bright border + soft 3px ring, keyboard only), `.nova-focusable-inset` (the same ring drawn inward, for rows inside clipped or scrolling parents), `.nova-focusable-within` (a wrapper lit by the control inside it).
- **Two-tier floating surfaces.** L1 `nova-glass`: frosted glass (`blur(10px)`, a faint lit rim). L2 `nova-float-elevated`: near-opaque (`--nova-overlay`), stacking *above* glass, because glass-on-glass loses its blur. Tooltips are compact `--nova-overlay` chips.
- **Calibrated contrast.** Every text token clears WCAG AA on every surface in the stack, and **no fill carries white text**: every accent fill (the action lilac, dawn, emerald, amber) is luminous and carries dusk text (`--nova-action-ink`). Never fade text with opacity; step down the solid ladder instead.

---

## Content fundamentals

**Nova's voice.** Nova speaks like a kind expert sitting beside you: present, patient, warm, and completely plain-spoken. She says "I" and means it, says "you" and never mixes in "my", and never hides behind jargon. She is a collaborator, not a wizard, a wall of settings, or a salesperson. Her energy is vibrant yet calm. Never pushy, never clipped, never scolding.

- **Invite, never instruct.** "What would you like to build?" is an open door, not a form to fill. Prefer "you can" and "would you like" over imperatives; never "you must", never "invalid".
- **Take responsibility, offer the next step.** Errors are Nova's to own; the status row is plain and honest ("Couldn't build your app", "Couldn't update your app") and the chat offers the recovery. Never blame the person, never dead-end them.
- **Reassure during waits.** Long operations get patient company ("Still building. Big apps take a minute or two."), not spinners in silence or percent counters.
- **Celebrate quietly.** "Your app is ready". Warmth, not fireworks. Exclamation points almost never.
- **Explain consequences, calmly.** Destructive flows state what happens and how to undo, never alarm or guilt: the delete tooltip reads "Move to recently deleted", the confirm button "Confirm delete".

**Casing.** The wordmark and product name are **always lowercase**: `commcare nova`. Everything else (titles, headings, labels, menu items, buttons) uses sentence case ("Build your first app", "Move to Project"), never Title Case. Data-domain labels mirroring user content (form names like "Register New Case") are the exception. There are **no etched console labels anymore**: the old UPPERCASE-mono chrome (`HIDDEN`, `LIVE`) is retired, and status tags are quiet sentence-case sans ("Hidden") or pill badges.

**UX-writing mechanics:**
- **Scannable and short.** Specific headings; no filler. Use contractions ("can't", not "cannot", unless caution needs the emphasis of "do not").
- **No em dashes.** Not in UI copy, not in docs, not in code comments. A comma, a colon, or a new sentence carries the aside.
- **Skip periods on single-line text**: labels, tooltips, placeholders, single-sentence dialog body. Keep them on multi-sentence copy ("Could not delete. Check your connection and try again.").
- **No ellipsis in buttons, menu items, or placeholders, ever.** That includes a button's in-progress label: "Creating blank app", not "Creating blank app…" (the spinner or status row carries progress). Ellipsis is for standalone *action in progress* status text only: "Deleting…", "Moving to Field Ops…".
- **Spell things out.** No Latin abbreviations, no caps blocks, "and" over "&" in running text.

**Do and don't (canonical pairs):**

| Do | Don't | The rule |
|---|---|---|
| Tell me about the app you'd like to build | Enter app requirements | Invite, never instruct |
| Couldn't build your app | Build failed: invalid configuration | Own the error in plain language; the chat offers the next step |
| Build your first app | Build Your First App | Sentence case everywhere |
| Still building. Big apps take a minute or two. | Still building — big apps take a minute or two | No em dashes; a new sentence carries the aside |
| What would you like to change? | Ask for changes… | No ellipsis in placeholders |
| Creating blank app | Creating blank app… | No ellipsis in buttons, even mid-work; the spinner shows progress. Standalone status text is ellipsis's one home ("Deleting…") |
| Move to recently deleted → Confirm delete | Are you sure you want to delete this?! | Explain consequences calmly, with the undo path |
| You can't edit while a build is running | Editing is not permitted at this time. | Contractions, "you", no period on a single line |
| Could not delete. Check your connection and try again. | | Multi-sentence copy keeps its periods |
| Search by name, ID, or phone number | Search by name, ID, etc. | Spell things out |

**Tone examples (canonical):**
- Welcome intro: *"What would you like to build?"* / *"Tell me about the people you support, the work they do, and what you need to keep track of"*
- Composer placeholders: *"Tell me about the app you'd like to build"* and *"What would you like to change?"*
- Activity status: *"Sending message"*, *"Planning your app"*, *"Setting up your app"*, *"Building your app"*, *"Finishing your app"*, *"Reading your documents"*, *"Updating your app"* (post-build edits), *"Your app is ready"* / *"Your app is updated"*, *"Trying again"* (recovering, amber), *"Couldn't build your app"* / *"Couldn't update your app"* (error, rose)
- Blank-app escape hatch: *"Start with a blank app"* → *"Build it yourself, with Nova here whenever you want a hand"*
- Error (restricted access): *"Sign-in is restricted to authorized Dimagi accounts."*
- Network error pattern: *"Could not delete. Check your connection and try again."*

**Punctuation & detail.** The middle dot `·` is the metadata separator ("2 modules · 5 forms", set in the sans like all UI text). Counts are always pluralized correctly ("1 module", "3 forms"). Numbers appear sparingly and always mean something; no vanity stats.

**Emoji:** none. Status and emotion are carried by the semantic hues and Tabler line icons, never emoji or decorative Unicode.

---

## Visual foundations

**Palette: "Twilight & first light."** A four-step surface stack of warm plum dusk: `#171221` (page) → `#1d1729` (wells, sidebars) → `#251d34` (cards) → `#2f2543` (raised/hover), plus `--nova-overlay` (near-opaque floating tier) and `--nova-glass` (frosted L1). All four steps share one warm hue; the dark is an evening room, never a cold blue void. Text is warm lavender-white `#f1edf7`, stepping to `#a89fc2` (secondary) and `#978cb3` (muted, still AA on every surface). **Lilac `#9678f2` (`--nova-violet`) is the single non-semantic accent**: borders, focus, active state, the logo, and glow. `#b6a0fb` (violet-bright) is violet *text and links*, the focus ring, and, as **`--nova-action`**, the primary CTA fill. In Nova, **light is action**: the primary button is the brightest thing on the page, a luminous lilac fill carrying **dusk text** (`--nova-action-ink` = `--nova-void`, 8.2:1). There are no white-text fills and no separate "blue'd" button hue anywhere in the system. **Dawn `#f5b0a5` is Nova's second light**: the warm peach-rose of first light, used *only as light* (the logomark's dawn crescent, the low warm bloom on hero surfaces, rare quiet celebrations), never a border, control fill, or state. It sits deliberately apart from both orchid (cooler, code + presence) and the error rose (deeper). Semantic hues are soft and quiet, reserved for state, never decoration: emerald `#86cebc` (success), apricot amber `#eaa06a` (warning/recovering; sunset caution, not mustard), rose `#d4708f` (error; a *tinted* fill with rose text for destructive actions, not a solid alarm). Orchid `#cda0d4` belongs to code strings and peer presence; it is not an accent. **Peer-presence hues** (periwinkle `#928fd6`, iris `#7e79b9`, lavender `#dfdeed`) are decorative collaboration colors drawn from the XPath syntax family. **Code / XPath syntax** has its own 12-step palette ("lavender milk bath", the `--nova-code-*` tokens): every syntax color lives in the purple/lavender/orchid family, differentiated by lightness and warmth.

**Type.** Three Google families: **Outfit** for display (600 and 700, gently snug tracking −0.015em), **Plus Jakarta Sans** for all UI body and labels, and **JetBrains Mono** strictly for code and data values (field ids, `#form/` refs, formulas). Mono never sets UI labels; nothing in the chrome is uppercase-tracked.

**Borders & cards.** Borders are lilac at low alpha (`rgba(150,120,242,0.17)`), brightening to `0.34` on hover and focus; controls REST on the default hairline (inputs, the outline button) so hover still has something to say. A selected row or segment draws its hairline INSIDE (`--nova-violet-hairline`, inset shadow) so selecting never changes size. A card is `--nova-surface` with a 1px lilac-tinted border at `--radius-lg` (12px); hover lifts the border to `--nova-border-bright`. Depth comes from surface-stack contrast and the border, soft and ambient like paper in low light; nothing recessed or machined.

**The atmosphere.** Nova's warmth is ambient light: the **first-light bloom** (`nova-bloom`), a lilac glow overhead and a low dawn-rose wash on the horizon, behind hero surfaces; a whole-viewport **film-grain noise** overlay (`nova-noise`) at `opacity: 0.015`; and **breath** (`nova-breathe`, 3.6s), the slow presence pulse of the logomark’s limb light. No photographic imagery, no illustrations, no instrument panels.

**Glow & light.** Page-level CTAs and active elements emit a violet glow (`--nova-glow-violet`, stronger on hover); `--nova-glow-dawn` exists for rare warm hero moments. Glow is the brand's substitute for elevation: light, not shadow, signals "alive / active."

**Focus.** Keyboard focus = violet-bright border + a soft 3px ring at 45% alpha (`--focus-ring`). Selection is violet at 0.32 alpha with white text.

**Motion.** Unhurried and gentle: things settle, never snap. Entrances fade and rise 10 to 20px on `cubic-bezier(0.16,1,0.3,1)` over 0.6 to 0.8s. Press is real travel: keycap buttons sink 3px (`--key-wall`) as their wall collapses; text-only controls nudge `translateY(1px)`. Menus and popovers scale-fade from 0.95 to 0.97. Default UI transitions are 0.2s; ambient motion (breath, blooms) is slow enough to ignore. Respect `prefers-reduced-motion` (near-zero durations, not `none`, so lifecycles still complete).

**Z-index** is a semantic token scale (`--z-ground` 10 → `--z-system` 9999); tooltips sit above modals.

---

## Iconography

- **System:** [Iconify](https://iconify.design/) with the **Tabler** icon set: line icons, ~1.75px stroke, rounded joins, 24px grid. In HTML mocks, load Tabler from the Iconify CDN:
  ```html
  <span class="iconify" data-icon="tabler:sparkles"></span>
  <script src="https://code.iconify.design/3/3.1.1/iconify.min.js"></script>
  ```
  Common glyphs: `tabler:sparkles` (generate), `tabler:apps`, `tabler:trash`, `tabler:loader-2` (spinner), `tabler:external-link`, `tabler:arrow-right` (composer submit), `tabler:paperclip` (attach), `tabler:settings`, `tabler:eye-off` (hidden field), `tabler:folder-symlink` (move to Project).
- **The logo** is the **first light sphere** logomark: a dusk world whose limb catches first light, followed by `commcare nova` in Outfit bold, two-tone: "commcare" in `--nova-text`, "nova" in `--nova-violet-bright` (no gradient). At rest the DAWN moves, not the mark: the warm arc on the lower-right limb widens and narrows like a sunrise lamp coming up (two animations on unrelated periods, so the wave has no audible loop point); nothing spins, blinks, or resizes. Hover lights the RIM (brighter, sharper), and only when the lockup sits inside a link or button. Five sizes: `sm`/`md`/`lg`/`hero` hold the illustration's proportion; `chrome` is the app header (a 44px mark, the header's control band, beside 32px type, so the lockup is exactly as tall as a button). Marks under 32px flatten automatically into the flat sibling. See `components/core/Logo.prompt.md` and the implementation in `components/ui/Logo.tsx`.
- **App favicon:** `app/favicon.ico`, exported from the flat logomark (`variant="flat"`: violet body, bold dawn crescent; the only raster brand asset).
- **No emoji, no decorative Unicode.**

---

## What's in here

**Tokens** (`tokens/`)
- `colors.css`: the `--nova-*` twilight surface/text/accent/dawn/action/semantic system, peer-presence hues, the `--nova-code-*` XPath syntax palette, glass tokens, focus ring, z-index scale
- `typography.css`: font families, type scale, weights, tracking (mono = code and data only)
- `spacing.css`: spacing scale, the soft radius scale (sm→4xl pill), 44px hit target, ambient shadows and floating-tier rims, the interaction-state constants, motion easings including `--duration-breathe`
- `fonts.css`: Google Fonts (`@import`)
- `base.css`: body defaults, scrollbar, ambient light (`nova-noise`, `nova-bloom`, `nova-breathe`), the `nova-shimmer` skeleton sweep, the floating-surface classes (`nova-glass`, `nova-float-elevated`), interaction conventions, reduced motion

**Primitive contracts** (`components/core/*.prompt.md`): what each core control is and how it behaves, one file per primitive. The implementations live in the app:

| Contract | Implementation |
|---|---|
| `Button.prompt.md` | `components/shadcn/button.tsx` (the contract's `primary` is the code's `default` variant) |
| `Badge.prompt.md` | `components/shadcn/badge.tsx` |
| `Input.prompt.md` | `components/shadcn/input.tsx` |
| `Toggle.prompt.md` | `components/shadcn/switch.tsx` |
| `Card.prompt.md` | `components/ui/AppCard.tsx` |
| `Logo.prompt.md` | `components/ui/Logo.tsx` (plus the logo CSS in `app/globals.css`) |
| `SectionPager.prompt.md` | `components/preview/form/sections/` (`SectionHeading.tsx`, `SectionPage.tsx`, `SectionPagerControls.tsx`, the `useSectionPaging.ts` hook) and the submit row in `components/preview/screens/FormScreen.tsx` |

---

## Substitutions & notes

- **`tokens/fonts.css` is the Google Fonts `@import`** naming the exact families and weights; a throwaway HTML mock can link it directly. The app itself loads the same three families through `app/layout.tsx`.
- **HTML mocks load Tabler icons from the Iconify CDN** (the snippet under Iconography). App code uses `@iconify/react/offline`; see `components/CLAUDE.md` § Icons.

---

## Folder manifest

| Path | What |
|---|---|
| `readme.md` | This guide: the brand, the voice, the visual foundations |
| `tokens/` | `colors.css` · `typography.css` · `spacing.css` · `fonts.css` · `base.css` |
| `components/core/` | Per-primitive contracts (`*.prompt.md`) |

## Deep link authoring

Deep links are named destinations in App setup, with their own URL-selected
details and direct shortcuts from destination settings. Authoring copy describes
what opens and which case selections it needs. Link ID edits explain their effect
on shared links before the author applies them. A form's display-condition bypass
names the visible effect and never promises broader access.

Local testing belongs beside authoring and uses Preview's real Project cases.
External link generation belongs to a selected Publishing target and asks for
that HQ project space's case IDs. Its evidence reads “Released build checked” with
a time; it makes no guarantee about the build HQ later chooses for a recipient.
