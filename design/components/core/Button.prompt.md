The action button. Buttons are soft keycaps: a crown gradient lit from above, a 3px darker side wall (`--key-wall`), and real travel on press: the cap sinks 3px as the wall collapses. The skin changes in one frame (crown gradients can't tween; fill, shadow, and travel land together); only opacity eases. One size only: 44px tall at `--radius-xl`; `size="icon"` is the same 44px as a square for icon-only buttons. The 44px hit-target floor is the button; there is no small/medium/large ladder.

```jsx
<Button variant="primary" glow>Get started</Button>
<Button variant="secondary">Cancel</Button>
<Button variant="destructive">Confirm delete</Button>
<Button variant="ghost-destructive">Remove</Button>
<Button variant="field">Saves to… patient</Button>
<Button size="icon" aria-label="Settings">⚙</Button>
```

Variants: `primary` (default: the luminous lilac keycap with dusk text; in Nova, light is action and no fill carries white text), `secondary`, `outline`, `ghost`, `ghost-destructive`, `ghost-action`, `field`, `destructive`, `warning` (amber keycap, dusk text), `link`. `outline` is the quiet page-level action ("Start with a blank app"); it rests on the DEFAULT hairline and brightens on hover, because resting on the bright edge reads as permanently hovered. Ghost and link stay text-only (no crown, no wall, a 1px press nudge) so keycaps gain contrast against them; `ghost-destructive` (rose) and `ghost-action` (violet) are ghost's semantic siblings for inline actions where a keycap would shout — same anatomy, the hue is the only difference. `field` is a trigger that PRESENTS as a field (holds a value, opens a menu): it wears the Input's anatomy — 12px radius, violet wash on the violet-tinted border, hover lifting one step toward light — and grows rather than truncating. Hover brightens the crown one perceptual step (never dims) with a glow swell on primary; disabled = opacity 0.6 (`--disabled-opacity`). Focus ring is keyboard-only (`:focus-visible`); a mouse press never leaves a standing ring or outline. `glow` upgrades the primary's standing glow to the strong halo for hero CTAs.
