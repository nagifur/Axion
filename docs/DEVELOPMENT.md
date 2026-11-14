# Development and Content Guide

Technical reference for maintaining the Axion website and authoring its content.
For character submissions, start with the [content templates](../templates/README.md).

## Local Development

Install Node.js and npm. The deployment workflow uses Node.js 20.
From the repository root, run:

```sh
npm ci
npm run dev
```

The development server is usually available at [http://localhost:4321](http://localhost:4321).
Astro reports the exact URL in the terminal.

Keep the direct `sharp` dependency compatible with Astro's `sharp` dependency
so npm installs a single version. Loading different native versions in the same
process can break image processing on Windows with
`colourspace: parameter space not set`. After dependency changes, restart the
development server so it loads the updated native libraries.

| Command | Description |
| --- | --- |
| `npm run dev` | Start the local development server with hot reload. |
| `npm run build` | Build the production site into `dist/`. |
| `npm run preview` | Preview the production build locally after building. |

Pushes to `main` trigger a production build and deployment to GitHub Pages through
[GitHub Actions](../.github/workflows/deploy.yml). The workflow can also be run manually.

## Content Structure

Most database entries are Markdown files in [`src/content/`](../src/content/):

```text
src/content/
|-- articles/    # News and world-information articles
|-- entities/    # Captured entities and their profiles
|-- pages/       # Static Markdown pages
|-- personnel/   # Personnel profiles
`-- synthetics/  # Synthetic profiles
```

Each collection has a schema in [`src/content.config.ts`](../src/content.config.ts).
When adding or editing an entry, keep its frontmatter consistent with that schema.
Set `draft: true` on articles, personnel, entities, or synthetics that should not
appear in the published database. Draft files committed to this public repository
are still publicly readable; this is not a privacy setting.

The submit page requires a name (or entity number / report title) and author for
every file, plus an employee ID for personnel or a synthetic ID for synthetics.
These fields must be filled before submitting, downloading, or copying a file.
IDs can be edited below the profile image and are exported as strings to preserve
leading zeroes. An entity's ID is its filename slug, generated from its entity
number. When writing YAML manually, quote IDs with leading zeroes (for example,
`employeeID: "0001"`).

To mark a personnel, entity, or synthetic profile as hunted by Axion (fired and
wanted, escaped containment, etc.), add a `wanted` block to its frontmatter. The
profile then shows a red alert banner, a stamp over the profile image, a tag in
the database list, and a stamp on its social share image:

```yaml
wanted:
  status: Escaped # Headline text, e.g. Wanted or Escaped (defaults to Wanted)
  reason: Breached containment. Believed to be hiding in the city.
  instruction: If sighted, do not engage. Contact Axion Security immediately. # Optional; this is the default
```

Remove the block once the character is captured or cleared.

Images are stored in [`src/assets/images/`](../src/assets/images/), while files
that need to be served directly are stored in [`public/`](../public/).

### Article Images

Place article images in `src/assets/images/<article-slug>/`, where the slug is
the Markdown filename without `.md`. For example, `magic-system.md` uses
`src/assets/images/magic-system/`.

Insert an image on its own line, separated from surrounding text by blank lines:

```markdown
::image{file="nagi-explaining-magic.gif" alt="Nagi explaining magic" caption="Nagi explaining magic" align="center"}
```

The folder is inferred from the article filename. To use another image folder,
add `folder="actual-folder-name"`; `folder="slug"` is a literal folder name, not
a placeholder. Alignment supports `full` (the default), `center`, `left`, and
`right`. Captions are optional.

Images are bundled with build-generated URLs without re-encoding, preserving
animated GIFs. Existing files in `public/images/articles/<article-slug>/` remain
supported, but assets take priority. Missing images cause an explicit rendering
error. Report submission ZIPs include images under `src/assets/images/`.

### Math Notation

Markdown bodies support LaTeX-style math, rendered locally with KaTeX (no external
rendering service). Use `$...$` inline:

```markdown
The density is $\rho_M \approx 1.2 \times 10^8 \,\mathrm{p}/\mathrm{m}^3$.
```

For a centered equation, place `$$` on separate lines:

```markdown
$$
\rho_M \approx \frac{1.2 \times 10^8 \,\mathrm{p}}{\mathrm{m}^3}
$$
```

Use `^` for exponents, `_` for subscripts, and braces for multiple characters
(`10^{-8}`, `x_{total}`). The submission body preview also supports inline math
and standalone `$$` blocks. Backtick code spans show math syntax literally.

## Project Layout

```text
src/
|-- components/  # Shared Astro components
|-- content/     # Markdown content entries
|-- lib/         # Markdown plugins and shared helpers
`-- pages/       # File-based Astro routes
public/          # Static files, fonts, icons, and site scripts/styles
scripts/         # Maintenance scripts
```

### Facility Map Art

The facility map art in [`public/facility/`](../public/facility/) is generated
from pixel-art PNGs with [`scripts/pixel-png-to-svg.mjs`](../scripts/pixel-png-to-svg.mjs).
For example, from the repository root:

```sh
node scripts/pixel-png-to-svg.mjs public/Level_0.png public/facility/level-0.svg
```

### Live Monitoring Simulation

[`/monitoring`](../src/pages/monitoring.astro) is a small in-browser simulation of the
facility, watched through security cameras. Every room folder becomes a camera; all
rooms are simulated at once and people walk between connected rooms. Characters are
built at build time from non-draft personnel files:
height sets sprite size, `colorTint` colours the name tag, and traits such as *Sleepy*,
*Clumsy*, *Anti-Social*, or *Can phase through objects* change how they behave.
Wanted characters are left out. Entities with a *Shapeshifting* ability can sneak in
disguised as staff.

Staff start, arrive, and choose rooms only on floors at or below their profile's
`accessLevel`. `Admin` can visit every floor; unknown or redacted clearances use
level 1. This applies to connected doors, elevators, and ghost arrivals.
Impostors ignore clearance limits, and emergency exit routes remain unrestricted.
Explicit scripted moves are not blocked by this planning preference.

Rooms expose a live `darkness` value: 0 on Level 0 or with at least one working,
switched-on light, otherwise 1. Unlit underground cameras are dimmed by 55%,
including props and people. Darkness adds a 1.2% trip chance per walking second
on top of the clumsy trait's 0.6%; impostors still do not trip. At their next
decision, agents are more likely to move rooms or leave, without the usual
minimum stay. Clearance rules and motion-sensor lighting are unchanged.

| File | Purpose |
| --- | --- |
| [`src/sim_assets/`](../src/sim_assets/) | Pixel art: `characters/`, `props/` (shared), and one folder per room in `rooms/`. |
| [`src/lib/sim/sprites.ts`](../src/lib/sim/sprites.ts) | What is inside each shared sprite: character frames, prop seats and blocked areas. |
| [`src/lib/sim/prop.ts`](../src/lib/sim/prop.ts) | Placed props and their live state (on/off, broken). |
| [`src/lib/sim/navMap.ts`](../src/lib/sim/navMap.ts) | Reads and checks nav maps at build time. |
| [`src/lib/sim/roomLoader.ts`](../src/lib/sim/roomLoader.ts) | Loads every room folder at build time and connects their doors. |
| [`src/lib/sim/room.ts`](../src/lib/sim/room.ts) | Room geometry: walkable floor, exits, seats, and path finding. |
| [`src/lib/sim/roster.ts`](../src/lib/sim/roster.ts) | Profile → character conversion, trait rules, and per-character overrides. |
| [`src/lib/sim/agent.ts`](../src/lib/sim/agent.ts) | Character tasks (walk, nap, chat, doors, elevator) and decision making. |
| [`src/lib/sim/world.ts`](../src/lib/sim/world.ts) | All rooms and people: arrivals, moving between rooms, elevators. |
| [`src/lib/sim/events.ts`](../src/lib/sim/events.ts) | Random events, A1 announcements, and achievements. |

Add `?debug` to the URL to show buttons that trigger events, speed up time, and open
the prop editor (see [Placing Props With the Editor](#placing-props-with-the-editor)).
Achievements and the last camera watched are stored in the visitor's browser (`localStorage`).

#### Character Sprite Sheet

[`characters/char_spritesheet.png`](../src/sim_assets/characters/char_spritesheet.png)
uses untrimmed **96 × 96 pixel cells**, with one animation per row, top to bottom:

| Row | Animation | Frames |
| --- | --- | --- |
| 1 | Walking front | 4 |
| 2 | Walking back | 4 |
| 3 | Walking right | 4 |
| 4 | Idle right | 2 |
| 5 | Idle front | 2 |
| 6 | Idle back | 2 |
| 7 | Sitting right | 2 |
| 8 | Sitting front | 2 |
| 9 | Talking right | 2 |

Frames run left to right; unused cells remain transparent. Keep the ground baseline
at the cell's bottom and the body centered on x = 48. Left-facing animations mirror
the right-facing rows. Walking uses the dominant movement direction and advances
every 8 room pixels traveled; idle, sitting, and talking frames alternate every
0.6 simulation seconds. Characters sit only while using a reserved chair or bench,
including while napping there; the speaker in a conversation uses the talking pose.
Seated characters are drawn in front of their seat's prop.
There is no sitting-back or talking-front/back artwork, so those facings use idle frames.
Frame coordinates and timing are defined in [`sprites.ts`](../src/lib/sim/sprites.ts).
The renderer crops each frame before scaling it, so neighboring animation rows cannot
bleed into characters or their highlight outlines at fractional sizes.

#### Adding a Room

Each room is a folder in [`src/sim_assets/rooms/`](../src/sim_assets/rooms/):

```text
rooms/level-1-offices/
|-- room.png        # The room art. Leave the elevator opening transparent.
|-- navMap.png      # Same size as room.png, painted with the colours below.
|-- room.json       # Name, camera label, and where props are placed.
`-- prototype.png   # Optional mockup; not used by the site.
```

Paint the nav map with a hard pencil at 100% opacity, anti-aliasing off, and save
it as PNG. Keep it as a layer in the same art file as the room so it stays aligned.

| Colour | Hex | Meaning |
| --- | --- | --- |
| Green | `#05FF00` | Floor: where feet can stand (not where bodies are). |
| Blue | `#0074FF` | Door. Must touch the floor; named by the wall it's in (see below). |
| Pink | `#FF00E7` | Elevator opening (at most one per room). Must touch the floor. |
| Red or transparent | `#FF0000` | Blocked. |

Don't paint furniture on the nav map. Place props in `room.json` instead; each prop
type in `sprites.ts` brings its own seats and blocked floor area:

```json
{
  "name": "Offices",
  "level": 1,
  "camera": "CAM 1-01",
  "props": [
    { "type": "bench", "x": 62, "y": 118 },
    { "type": "chair", "x": 415, "y": 122, "flip": true }
  ]
}
```

Prop `x`/`y` is the cropped artwork's top-left corner in room pixels, not the padded
sheet cell's corner. Everything painted in
`room.png` is drawn behind characters; anything that should cover people walking past
(a railing near the camera, a foreground pillar) must be a prop instead.

Any image in [`src/sim_assets/props/`](../src/sim_assets/props/) can be placed by its
file name (`plant.png` → `"type": "plant"`) as plain decoration. To give a prop seats
or floor that people walk around, add it to `PROP_TYPES` in
[`sprites.ts`](../src/lib/sim/sprites.ts).

#### Prop State

While the simulation runs, every placed prop is a `Prop` object
([`prop.ts`](../src/lib/sim/prop.ts)) with state that can change. What a prop can do comes
from its `PROP_TYPES` entry:

| Flag | Meaning |
| --- | --- |
| `switchable` | Can be on or off (lights). A room's switchable props come on as soon as someone is in it, and go off once it has been empty for a minute (`LIGHTS_OFF_SECONDS` in [`room.ts`](../src/lib/sim/room.ts)). |
| `breakable` | Can break. Nobody picks a seat on a broken prop, and anyone sitting on it or walking to it gives up. |

`room.json` can set how a prop starts. Only props whose type allows it may use these:

```json
{ "type": "light", "x": 83, "y": 34, "on": false },
{ "type": "chair", "x": 317, "y": 122, "broken": true }
```

Code changes state with `prop.setOn()`, `prop.break()` and `prop.repair()`.

#### Prop Sprite Sheets

The shared props use **96 × 96 pixel cells**, with frames running left to right.
`PROP_SPRITES` in [`sprites.ts`](../src/lib/sim/sprites.ts) declares the artwork-sized
source rectangles inside those cells. Keep every animation frame's crop the same
size and alignment, including room for glow or other effects. This keeps placements,
mirroring, seats, and blocked floor independent of transparent sheet padding.

A single rectangle is a still prop. Multiple rectangles form a looping animation;
`frameSeconds` controls the duration of each frame (defaults to one second).
The light currently alternates its two frames every 0.6 simulation seconds:

```ts
light: {
  frames: [
    { x: 28, y: 39, w: 40, h: 17 },
    { x: 124, y: 39, w: 40, h: 17 },
  ],
  frameSeconds: 0.6,
  states: {
    off: { frames: [{ x: 28, y: 135, w: 40, h: 17 }] },
  },
},
```

`states` holds the frames for a prop's other looks: `off` (switched off) and `broken`.
They follow the same rules as `frames` and must be cropped to the same size. Put them
on their own row of the sheet; the light's second row is its off look. A prop whose sheet
has no art for a look yet keeps its normal frames, except broken lights, which use `off`.

Frames can also come from other rows; include the row offset in `y`. Elevator door
and arrow sprites have their own crops in the same registry. The editor palette uses
the first frame, while placement previews and pixel picking use the current frame.
Animations share simulation time, so pausing the feed freezes them too.
Images without `PROP_SPRITES` metadata retain the full-image, still-decoration behavior.
Add metadata for any new grid sheet so its padding and extra cells are not rendered.

#### Placing Props With the Editor

Instead of working out pixels by hand, open `/monitoring?debug`, go to the room's
camera and press **Edit props**:

1. Pick a prop from the palette and click the feed to place it (it stands where you click).
2. Drag props to move them. Arrow keys nudge the selected prop by 1px (Shift: 10px),
   **F** flips it, **B** makes it start broken, **O** makes a light start off,
   **Delete** removes it, **Esc** cancels.
3. Press **Copy** and replace the `"props"` list in the room's `room.json` with it.

While editing, the feed shows the walkable floor (green), floor blocked by props (red),
seats (blue dots) and the position of the selected prop. Changes apply to the running
simulation straight away but are not saved anywhere until pasted into `room.json`;
reloading the page discards them.

#### Connecting Rooms

Doors are named by the wall they are in, which is worked out from where the green
floor touches them:

| Name | Wall | Paint it |
| --- | --- | --- |
| `west` / `east` | Left / right side wall | On the slanted side wall, touching the floor's edge. |
| `north` | Back wall | On the back wall, with the floor directly below it. |
| `south` | Front edge, towards the camera | A blue strip along the bottom edge, directly below the floor. |

A thin strip is all a south door needs, since the wall it's in isn't visible. Make
it as wide as the opening people should walk through. When one wall has several doors
they are numbered left to right as they appear in the image: `west-1`, `west-2`. In
`room.json`, `exits` says which room each door leads to:

```json
"exits": {
  "west": "level-1-pipeRoom",
  "north": "level-4-trophyRoom",
  "east-2": { "room": "level-1-recRoom", "door": "west-1" }
}
```

The short form (`"west": "level-1-pipeRoom"`) comes out of the other room's opposite
door (`east` for `west`, `south` for `north`), or its only door. Use the long form for
numbered doors or anything else. A connection only needs to be written in one of the
two rooms; the way back is added automatically, and the build stops if the two rooms
disagree. Doors without an exit lead off camera to the rest of the facility, so people
still arrive and leave through them (as they do through elevators).

People step into north doors facing away from the camera and walk out of the picture
through south doors facing it, using the back and front walking animations.

#### Connecting Floors With Elevators

An elevator connects many floors, so instead of linking pairs of rooms, each room
names the **shaft** its elevator belongs to. Every room with the same shaft name is a
stop of the same lift:

```json
"elevators": { "elevator": "main" }
```

The key is the elevator's name from the nav map (`elevator`), so the format stays the
same if a room ever gets more than one. Add `"elevators"` to the room on each floor; a
separate lift elsewhere just uses another shaft name, e.g. `"service"`. A shaft can
stop only once per level. Elevators also keep leading off camera, since the shaft
continues to floors that aren't filmed. Level numbers grow going down, so a ride from
Level 1 to Level 2 shows the down arrow. Keep elevator openings in the same place on
every floor so the shaft lines up.

Cameras are shown as a floor plan: a floor selector (L1, L2, …) next to the selected
floor's rooms, laid out on a grid by how their doors connect: west/east doors place
rooms side by side and north/south doors stack them, with north at the top. Changing
floors shows the camera last watched there, otherwise the room on the same elevator
shaft. Every camera uses the same pixel scale, so narrower rooms appear centred. The
first camera shown is `INITIAL_ROOM` in [`monitoring.astro`](../src/pages/monitoring.astro).

The build stops with the file and pixel position if a nav map uses an unknown colour,
has floor patches that can't be reached, has an exit that doesn't touch the floor, or
doesn't match the size of `room.png`, and names the problem if an exit points to a
door or room that doesn't exist, or an elevator or shaft is set up wrong.
