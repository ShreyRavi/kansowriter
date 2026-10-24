---
name: Kansowriter
colors:
  paper:
    ground: "#F5F0E6"
    surface: "#FBF8F1"
    ink: "#272320"
    muted: "#6E655B"
    hairline: "#E3DACB"
    track: "#E9E2D4"
    selected: "#EFE9DC"
    accent: "#5E6E3A"
    accentHover: "#48562C"
    selection: "#5E6E3A38"
    shadow: "rgba(39, 35, 32, 0.35)"
  night:
    ground: "#1B1917"
    surface: "#23201D"
    ink: "#E8E1D5"
    muted: "#A39A8E"
    hairline: "#2E2A26"
    track: "#2E2A26"
    selected: "#2A2622"
    accent: "#B5BF86"
    accentHover: "#CBD4A2"
    selection: "#B5BF8647"
    shadow: "rgba(0, 0, 0, 0.55)"
type:
  writing: "'Newsreader', Georgia, 'Times New Roman', serif"
  sans: "'Instrument Sans', system-ui, sans-serif"
  mono: "'IBM Plex Mono', ui-monospace, monospace"
  ui: 13px
  row: 14px
  uiSmall: 12px
  key: 11px
  body: 21px
  bodyPhone: 19px
  title: 34px
  titlePhone: 28px
  landing: 30px
  wordmark: 17px
  lineSerif: "1.7"
  lineSans: "1.65"
  lineMono: "1.6"
rounded:
  key: 3px
  row: 4px
  panel: 6px
  sheet: 16px
space:
  pageTop: 160px
  pageBottom: 120px
  gutter: 24px
  paragraph: 28px
  paragraphPhone: 22px
  measure: 680px
  sidebar: 340px
  palette: 620px
  target: 44px
motion:
  chromeFadeDelay: 3000ms
  chromeFade: 200ms
  goalSettle: 600ms
  feedback: 2000ms
---

# Kansowriter design system

The visual source is the Calm Writer design canvas (renamed Kansowriter). `src/ui/tokens.css` is generated from the front matter above by `npm run tokens`; CI fails if it drifts (`npm run tokens:check`).

## Principles
- The page acts like paper. Chrome fades 3 s after the first keystroke and returns on mouse move, tap, Esc or keyboard focus.
- One accent, used only for the progress line, links and focus.
- No cards, no decorative shadows. Overlays (sidebar, palette, send panel) get one soft offset shadow.
- Minimum UI text 13px; palette rows and the search field 14px (`row`); key-hint chips 11px.
- Overlay shadows use the theme's `shadow` color, so night overlays still lift off the ground.

## Components
| Component | Spec |
|---|---|
| Header | 20px 24px padding, 13px UI, 44px icon buttons, 18px 1.5-stroke icons: ☰ drafts, focus, theme, send (envelope), ⌘K |
| Progress line | 2px, full width, pinned to the bottom edge; accent on track; settles to full over 600 ms at goal |
| Notice strip | 40px above the progress line, surface, hairline top, 13px ink text, one text action right; one at a time |
| Palette row | 44px min, 4px radius, label left, value + key chip right; in-row editing; inline destructive confirm |
| Sidebar row | title 17px Newsreader 500, when 12px, 2-line excerpt 13px, words 12px; selected row background |
| Search field | 40px, magnifier icon, clear ✕ when filled, hidden label |
| Reader | 680px column, hidden controls row, date line top-left, end-state link |
| Send panel | 620px bottom panel (phone: sheet), primary Copy link / Download letter file |

## Browser surfaces
Selection uses `selection`; caret 2px ink; focus-visible ring 2px accent, 2px offset; thin scrollbars in hairline; links underline offset 3px.
