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
  openFile: 17px
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
  sendPanel: 620px
  endLink: 48px
  target: 44px
  tool: 32px
  dock: 48px
  checkBox: 0.78em
motion:
  chromeFadeDelay: 3000ms
  chromeFade: 200ms
  goalSettle: 600ms
  feedback: 2000ms
  endLinkDelay: 1500ms
  endLinkFade: 400ms
  tooltipDelay: 500ms
  tooltipFade: 120ms
---

# Kansowriter design system

The visual source is the Calm Writer design canvas (renamed Kansowriter). `src/ui/tokens.css` and `src/ui/theme-colors.ts` are generated from the front matter above by `npm run tokens`; CI fails if either drifts (`npm run tokens:check`).

## Principles
- The page acts like paper. Chrome fades 3 s after the first keystroke and returns on mouse move, tap, Esc or keyboard focus.
- One accent, used only for the progress line, links and focus.
- No cards, no decorative shadows. Overlays (sidebar, palette, send panel) get one soft offset shadow.
- Minimum UI text 13px; palette rows and the search field 14px (`row`); key-hint chips 11px.
- Overlay shadows use the theme's `shadow` color, so night overlays still lift off the ground.

## Components
| Component | Spec |
|---|---|
| Header | 20px 24px padding, 13px UI, 44px icon buttons, 18px 1.5-stroke icons: ☰ drafts + title left, formatting toolbar centred (desktop), focus, theme, send (envelope), ⌘K right |
| Tooltip | header and toolbar icon buttons: the button's name + shortcut ("Focus mode ⌘⇧P", "Bold ⌘B"), 12px sans on an ink chip, `row` radius, 6px below the button (edge-aligned at the header's sides); shows on hover or keyboard focus after `tooltipDelay`, fades in over `tooltipFade`, hides at once; never on touch screens; the aria-label stays the accessible name (no native `title`) |
| Format toolbar | `role=toolbar`, one Tab stop (←/→ between buttons); groups: style menu \| bullet, numbered, checklist, quote \| B I U S, split by 1px × 18px hairlines; `tool` (32px) buttons, 44px on coarse pointers; B I U S are 17px Newsreader glyphs drawn in their own style; pressed (`aria-pressed`) = `selected` background + ink; disabled 45% opacity (read-only tab, damaged draft); Tooltip = name + shortcut; a click never moves focus or the selection; fades with the chrome |
| Style menu | button: current style 13px + 10px chevron, 100px min (dock: content width); menu: surface, hairline, `panel` radius, overlay shadow, 44px `menuitemradio` rows previewing Title / Heading / Subheading / Normal in Newsreader, key chip right, ✓ on the current one |
| Format dock | phones (< 800px, coarse < 1024px, landscape phones): `dock` (48px) row of 44px targets, surface + hairline top, pinned to the visual viewport's bottom edge (above the on-screen keyboard; above a notice when no keyboard is open); shown only while the text has focus; scrolls sideways, never the page |
| Checklist box | `checkBox` square, 1.5px muted border, `row` radius; checked = ink fill with a ground tick, item text muted; drawn in place of `[ ]` / `[x]` off the caret line (the line's `- ` hidden too); `role=checkbox`; ⌘↵ toggles the caret's lines; display-only in the reader |
| Progress line | 2px, full width, pinned to the bottom edge; accent on track; settles to full over 600 ms at goal |
| Notice strip | 40px above the progress line, surface, hairline top, 13px ink text, one text action right; one at a time |
| Palette row | 44px min, 4px radius, label left, value + key chip right; in-row editing; inline destructive confirm |
| Sidebar row | title 17px Newsreader 500, when 12px, 2-line excerpt 13px, words 12px; selected row background |
| Search field | 40px, magnifier icon, clear ✕ when filled, hidden label |
| Reader | 680px column, hidden controls row (play/pause, scrubber, Skip to the end), date line top-left, 2px replay line, end-state link 48px below the text after 1.5 s (`endLinkFade`, none under reduced motion); empty state: "Open a letter file" 17px Newsreader (`openFile`) with a drop zone; reduced motion keeps the replay (static caret, no animated chrome) |
| Send panel | 620px bottom panel 24px above the edge (phone: sheet, `rounded.sheet` top corners, max 60vh), live preview above, Replay / Final text only, start slider, size note, privacy line, primary Copy link / Download letter file |

## Formatting
Buttons and shortcuts write plain Markdown; syntax shows only on the caret line. Underline is `<u>…</u>`, the one piece of HTML styled (as a decoration; all other HTML stays text). Shortcuts (Mod = ⌘ / Ctrl): B bold, I italic, U underline, ⇧X strikethrough, ⇧7 numbered, ⇧8 bullet, ⇧9 checklist, ' quote, ↵ check, ⇧1 title, ⇧H heading, ⇧J subheading (Ctrl ⇧G off Apple), ⇧B normal. Title isn't ⇧T (typewriter, and the browser's reopen-tab); Ctrl ⇧J is the browser console.

## Browser surfaces
Selection uses `selection`; caret 2px ink; focus-visible ring 2px accent, 2px offset; thin scrollbars in hairline; links underline offset 3px.
