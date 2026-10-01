# Training Tab & Standalone Training Page

## Overview

Add a Training tab to the Grow Sales app with flashcard-style training content for door-to-door sales reps. Content covers smokescreens, objections, and ISP-specific aces. Content is stored in Supabase and editable from the Corporate view. A standalone `training.html` page (no auth required) provides a shareable link for use in external apps.

## Data Model

### Supabase table: `training_cards`

| Column | Type | Default | Notes |
|---|---|---|---|
| `id` | uuid | `gen_random_uuid()` | Primary key |
| `category` | text | — | One of: `smokescreens`, `objections`, `aces` |
| `subcategory` | text | null | For aces: the ISP name (e.g. "AT&T", "Brightspeed"). Null for other categories. |
| `front` | text | — | The smokescreen/objection text, or the ace title |
| `back` | text | — | The response/talking point |
| `sort_order` | integer | 0 | Controls display order within category/subcategory |
| `created_at` | timestamptz | `now()` | Auto-set on insert |

### Row-Level Security

- **SELECT**: Allow for all (anon + authenticated). No auth needed so the standalone page works.
- **INSERT/UPDATE/DELETE**: Restrict to authenticated users with admin role (same pattern used elsewhere in the app).

## In-App Training Tab

### Bottom bar

- New tab added to the bottom bar after the existing tabs.
- Icon: 📖
- Label: "Training"
- New `<div class="tab-section" data-section="training">` for the content area.

### Category picker (default view)

When the Training tab is active, show three tappable category cards:

1. **Smokescreens** — common deflections and what to say
2. **Objections** — real concerns and how to handle them
3. **ISP Aces** — selling points by provider

Each card has the category name and a count of cards in that category.

### Category detail view

Tapping a category navigates into it. A back arrow at the top returns to the category picker.

#### View toggle

Two mode buttons at the top:
- **Guide** (default) — scrollable list view
- **Practice** — flashcard flip mode

#### Guide mode

- All cards displayed in a scrollable list ordered by `sort_order`.
- Each card: `front` text displayed bold/prominent, `back` text displayed below in normal weight.
- For the **aces** category: ISP filter chips at the top (one per unique `subcategory`). Tapping a chip filters to that ISP. "All" chip selected by default.

#### Practice (flashcard) mode

- Shows one card at a time.
- Card displays `front` text. Tap the card to flip and reveal `back` text.
- Previous/Next buttons (or swipe) to navigate between cards.
- Progress indicator: "3 / 12".
- Shuffle button to randomize order.
- For aces: same ISP filter chips as guide mode.

### Corporate edit UI

When `VIEW === 'Corporate'`:

- An "Edit Training" button appears at the top of the training tab.
- Clicking opens a modal with a list of all cards grouped by category.
- Each card row shows front text, category, subcategory, and action buttons (edit, delete, reorder).
- "Add Card" button opens a form:
  - Category: dropdown (smokescreens, objections, aces)
  - Subcategory: text input (shown only when category is "aces")
  - Front: textarea
  - Back: textarea
- Edit opens the same form pre-filled.
- Delete confirms before removing.
- Reorder: drag handle or up/down arrows to change `sort_order`.
- All changes write directly to Supabase via the existing `sbWrite` helper.

## Standalone Page: `training.html`

### Purpose

A separate HTML page that can be shared via link. No login required. Anyone with the URL can view training content.

### URL structure

- `training.html` — shows category picker
- `training.html#smokescreens` — jumps directly to smokescreens
- `training.html#objections` — jumps directly to objections
- `training.html#aces` — jumps directly to aces
- `training.html#aces/att` — jumps to aces filtered to AT&T (subcategory slug)

### Behavior

- On load, fetches all rows from `training_cards` via Supabase REST API (anon key, public read).
- Renders the same guide + practice UI as the in-app tab.
- Uses the same CSS variables and styling as the main app for brand consistency.
- Responsive: works on mobile and desktop.
- No bottom bar, no login prompt, no app chrome — just the training content with the Grow logo at top.
- Reads `location.hash` on load to deep-link into a category.

### PWA / meta

- Standalone page does NOT need to be part of the PWA or service worker scope.
- Basic meta tags (viewport, theme-color, title) for a clean mobile experience.

## Styling

- Match existing app design language: same CSS variables, glass effects, pill styles.
- Flashcard: rounded card with subtle shadow, flip animation via CSS `transform: rotateY(180deg)` with `perspective`.
- Category cards: similar to the KPI cards in the overview tab.
- Keep it clean and fast — no external dependencies beyond the Supabase JS client already in use.

## Implementation Notes

- The `training_cards` table needs to be created in Supabase with RLS policies before the frontend code works.
- The standalone page uses the same Supabase anon key already embedded in `index.html`.
- No new npm dependencies needed — everything is vanilla JS/CSS like the rest of the app.
- The training tab data is fetched once on tab activation and cached in memory for the session.
