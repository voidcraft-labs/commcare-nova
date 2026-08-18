Small status / metadata chip, a full pill (radius-4xl, 22px tall) of soft borderless tint. Violet is the neutral accent; emerald / amber / rose carry semantic state. Amber = warning / recovering ("Trying again"), never in-progress; working states use the violet family.

```jsx
<Badge variant="emerald">Ready</Badge>
<Badge variant="violet" working>Generating</Badge>
<Badge variant="amber">Trying again</Badge>
<Badge variant="rose">Failed</Badge>
<Badge>3 forms</Badge>
```

Variants: `muted` (default), `violet`, `emerald`, `amber`, `rose`. Badge text: sentence case, no punctuation.
