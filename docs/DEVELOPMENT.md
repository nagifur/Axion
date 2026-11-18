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

Character frontmatter supports optional `stats` capacity overrides; see the
[stats authoring reference](../templates/README.md#optional-simulation-stats).
[`stats.ts`](../src/lib/sim/stats.ts) defines the defaults: HP and stamina 100,
magic 0 (disabled), hunger and thirst 100. Each spawned agent gets its own
`stats` pools with `current` and `max`; HP/stamina/magic start full and needs
start at zero. `agent.hasMagic` is true only with a positive magic capacity.
Impostors use their entity profile's stats, not the copied staff profile's.
The selected-agent panel updates live values without rebuilding the file.
There is no automatic drain, recovery, damage, death, or AI behavior change yet;
values last only for that agent instance, not across spawns or reloads.
All three character collections validate optional stat blocks, including
synthetics that do not yet spawn in monitoring.

Drag a sprite or name tag to physically pick up an agent. Dropping on open floor
repositions them, on a free chair or bench seat starts the usual seated activity,
and on another agent starts a conversation. Lights can be toggled; other unseated
props are inspected. The held agent pauses while the rest of the facility continues.
Dropping above non-green nav-map pixels makes the agent fall straight down with
gravity until their feet touch the first green pixel, then play the usual trip
reaction. If there is no green below, they fall fully out of view and respawn on
nearby walkable floor. Falling agents cannot be picked up or pulled into chats.
Broken or occupied props, blocked floor, and drops outside the feed are rejected
without changing the original task or position. Hold over a floor or camera button for
450ms to switch feeds while carrying an agent, then drop into the new room.
Floor buttons use the same remembered-camera/elevator-shaft selection as normal
clicks. The agent stays in their original room until a valid drop, which transfers
them and releases their old seat/conversation. Player transfers can cross floors
regardless of clearance, like other explicit scripted moves. A carrying label
follows the cursor outside the feed. Physical transfers update motion-sensor
lighting immediately, even while paused. Esc, pointer cancellation, or losing focus
cancels a pickup and leaves the agent in their original room.
Doorway and elevator transitions cannot be
picked up. Paused feeds accept drops, with tasks starting when the feed resumes.
Player drops do not trigger the file-selection ping (or reveal disguised entities);
ordinary clicks still do. Drop resolution lives in
[`agentDrag.ts`](../src/lib/sim/agentDrag.ts).

Staff start, arrive, and choose rooms only on floors at or below their profile's
`accessLevel`. `Admin` can visit every floor; unknown or redacted clearances use
level 1. This applies to connected doors, elevators, and ghost arrivals.
Physical passage doors also check their own clearance before opening or allowing a
crossing, including arrivals and work routes. Impostors ignore clearance limits,
and people leaving can always use exit routes. Explicit player transfers remain
unrestricted.

Staff follow the viewer's local clock (simulation speed does not speed up the day).
Edit [`schedule.ts`](../src/lib/sim/schedule.ts) to change `DEFAULT_SCHEDULE`:
work is 08:00-17:00, lunch 12:00-13:00, and short breaks 10:00-10:15 and
15:00-15:15. Unmatched times are free time. The first matching block wins,
so keep lunch and breaks before the work block. Times use `HH:MM`, starts
are inclusive, ends exclusive, and a block can cross midnight. Invalid
times or zero-duration blocks throw an error.

`SCHEDULE_OVERRIDES` uses personnel filename slugs and replaces the entire
default routine for that character. For example, to give Sypher a night shift:

```ts
export const SCHEDULE_OVERRIDES: Record<string, readonly ScheduleBlock[]> = {
  sypher: [
    { start: '02:00', end: '02:15', period: 'break' },
    { start: '22:00', end: '06:00', period: 'work' },
  ],
};
```

During work, staff mostly stay on their highest accessible floor with rooms;
Admin can work anywhere. Initial placement and arrivals favor those floors,
and staff elsewhere prefer clearance-safe door/elevator routes back to work.
They spend longer working at chairs or standing in the work area until dedicated
workstation props are added. Lunch and breaks favor resting/socializing; free
time allows more wandering. Traits still apply, including occasional naps.
The personnel panel shows the current schedule period separately from the
current activity. New periods take effect as plans finish, rather than
interrupting doorways, elevator rides, or conversations. Darkness and emergency
exits still take priority; impostors are not compelled to follow staff work floors.
Schedules do not change the existing time-based population targets.

With `?debug`, the **Time** button cycles the clock through Live, 09:00 work,
10:05 break, 12:30 lunch, 18:00 free time, and 02:00 night. The overridden
clock keeps running from the chosen time and affects schedules, population, and
the on-screen clock. Idle staff re-plan immediately. Overridden time does not
unlock the night-shift directive.

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
| [`src/lib/sim/schedule.ts`](../src/lib/sim/schedule.ts) | Editable daily routine, breaks, and per-character schedule overrides. |
| [`src/lib/sim/agent.ts`](../src/lib/sim/agent.ts) | The `Agent` class: position, stats, carried item, and its task queue. |
| [`src/lib/sim/planning.ts`](../src/lib/sim/planning.ts) | Decision making: which task an idle agent picks next (`planNext`). |
| [`src/lib/sim/tasks.ts`](../src/lib/sim/tasks.ts) | Basic tasks: walking, waiting, napping, falling, tripping, and prop breakage. |
| [`src/lib/sim/itemTasks.ts`](../src/lib/sim/itemTasks.ts) | Item tasks: using, picking up, setting down, and getting items from dispensers. |
| [`src/lib/sim/conversation.ts`](../src/lib/sim/conversation.ts) | Chats between two agents: meeting points, turns, and speech bubbles. |
| [`src/lib/sim/transport.ts`](../src/lib/sim/transport.ts) | Leaving and entering rooms through doors and elevators, and leaving the facility. |
| [`src/lib/sim/world.ts`](../src/lib/sim/world.ts) | All rooms and people: arrivals, departures, and the per-frame update. |
| [`src/lib/sim/routing.ts`](../src/lib/sim/routing.ts) | Which rooms an agent may visit and which door or floor leads toward work or the exit. |
| [`src/lib/sim/elevator.ts`](../src/lib/sim/elevator.ts) | Elevator cars: requests, door timing, and passenger layout. |
| [`src/lib/sim/passages.ts`](../src/lib/sim/passages.ts) | Live state of passage doors between rooms (locks, panels, who is passing). |
| [`src/lib/sim/random.ts`](../src/lib/sim/random.ts) | The single source of randomness (`random`, `chance`, `pick`, ...). Use it instead of `Math.random`; `setRandomSource` swaps in a seeded generator. |
| [`src/lib/sim/events.ts`](../src/lib/sim/events.ts) | Random events, A1 announcements, and achievements. |
| [`src/lib/sim/render.ts`](../src/lib/sim/render.ts) | Asset loading and drawing a camera feed onto a canvas. |
| [`src/lib/sim/monitor.ts`](../src/lib/sim/monitor.ts) | Boots the monitoring page: cameras, drag and drop, and the frame loop. Its panels live in `monitorFile.ts` (personnel file), `monitorTags.ts` (name tags), `monitorDebug.ts` and `monitorEditor.ts` (`?debug` tools), and `monitorProgress.ts` (saved progress). |

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
| 10 | Tripped / fallen down right | 2 |
| 11 | Holding an item right | 2 |
| 12 | Using an item right | 6 |

Frames run left to right; unused cells remain transparent. Keep the ground baseline
at the cell's bottom and the body centered on x = 48. Left-facing animations mirror
the right-facing rows. Walking uses the dominant movement direction and advances
every 8 room pixels traveled; stationary frames advance every 0.6 simulation seconds.
Trips and landings use the prone frames throughout recovery. Standing agents carrying
an item use the holding frames, and item actions play the six-frame use sequence from
the beginning. Those poses have right-facing art only; they mirror for left and use
the right-facing art when the agent was facing front or back. Walking, sitting, and
talking retain their own poses while carrying an item. Characters sit only while using
a reserved chair or bench, including while napping there; the speaker in a conversation
uses the talking pose. Seated characters are drawn in front of their seat's prop.
There is no sitting-back or talking-front/back artwork, so those facings use idle frames
unless a standing character is holding an item.
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
| Blue | `#0074FF` | Passage, with or without a physical door. Must touch the floor; named by its wall (see below). |
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
    { "type": "bench", "x": 62, "y": 114 },
    { "type": "chair", "x": 403, "y": 105, "flip": true }
  ]
}
```

Prop `x`/`y` is the cropped artwork's top-left corner in room pixels, not the padded
sheet cell's corner. Everything painted in
`room.png` is drawn behind characters; anything that should cover people walking past
(a railing near the camera, a foreground pillar) must be a prop instead.

Images in [`src/sim_assets/props/`](../src/sim_assets/props/) can be placed by file
name (`plant.png` → `"type": "plant"`) as plain decoration, except for the reserved
elevator and passage-door artwork. To give a prop seats or floor that people walk
around, add it to `PROP_TYPES` in [`sprites.ts`](../src/lib/sim/sprites.ts).

#### Prop State

While the simulation runs, every placed prop is a `Prop` object
([`prop.ts`](../src/lib/sim/prop.ts)) with state that can change. What a prop can do comes
from its `PROP_TYPES` entry, or automatically detected power-off and broken artwork:

| Flag | Meaning |
| --- | --- |
| `switchable` | Can be switched on or off manually, including through the editor. |
| `electric` | Electrical equipment: emits recurring sparks while broken, even when switched off. Defaults to false; lights and vending machines opt in. This does not enable switching or breakage by itself. |
| `automaticPowerOff` | Opts a switchable prop into occupancy-controlled power: on when someone enters, off after the room has been empty for `LIGHTS_OFF_SECONDS` in [`room.ts`](../src/lib/sim/room.ts). Defaults to false; only lights enable it currently. Set `automaticPowerOff: true` in the prop's `PROP_TYPES` entry to opt in another type. |
| `breakable` | Can break. Nobody picks a seat on a broken prop, and anyone sitting on it or walking to it gives up. |
| `impactArea` | Optional artwork-relative rectangle used to measure distance from a tripping agent; defaults to the whole frame and is mirrored for flipped props. |
| `dispenses` | Item type agents can get from the prop while it works and, if switchable, is on (see [Dispensers](#dispensers-vending-machines)). |
| `breakParticles` | One or more particle sets and optional artwork-relative emission area to use when the prop breaks (see [Breakage Particles](#breakage-particles)). |

`room.json` can set how a prop starts. Only props whose type allows it may use these:

```json
{ "type": "light", "x": 83, "y": 34, "on": false },
{ "type": "chair", "x": 297, "y": 105, "broken": true }
```

Code changes state with `prop.setOn()`, `prop.break()` and `prop.repair()`.

Breakable props have a 1% chance to break per use (`PROP_BREAK_CHANCE` in
[`prop.ts`](../src/lib/sim/prop.ts)), shared by autonomous and drag-and-drop interactions.
The roll happens when seated use starts, when a valid dispenser attempt finishes,
or when a manual switch/inspection starts, never on every simulation tick or preview.
When an agent trips or lands after a fall, there is also a 10% chance to break the
nearest intact breakable prop whose impact area is within 12 room pixels of their
feet (`TRIP_PROP_BREAK_CHANCE` and `TRIP_PROP_REACH` in [`tasks.ts`](../src/lib/sim/tasks.ts)).
Only one prop is considered per trip, and the roll happens once on impact, not
while falling or on every recovery tick. Glass panes, chairs and vending machines
use `impactArea` to exclude transparent padding.
Chairs, benches, tables, lights, vending machines, and props with broken artwork
(such as glass panes) are breakable; decorations without it are not unless their type
opts in. Breakage logs a warning and shows an exclamation bubble. Seated use stops,
and a vending machine that breaks dispenses nothing. Runtime breakage lasts until
`prop.repair()` is called and does not change the exported starting state.

#### Breakage Particles

Particle sprites live in [`src/sim_assets/particles/`](../src/sim_assets/particles/).
Each PNG is a whole particle image, not a sprite sheet. Add a reusable set to
`PARTICLE_SETS` in [`particles.ts`](../src/lib/sim/particles.ts): its sprite names omit
`.png`, and its settings control burst count, launch speeds, `spinSpeed` (radians per
second, with a random direction), gravity, bounce, floor
friction, lifetime, fade, and landing scatter. Link any number of prop types to that
set in `PROP_TYPES` in [`sprites.ts`](../src/lib/sim/sprites.ts):

```ts
glass_cup: { asset: 'glass_cup', breakable: true, breakParticles: { set: 'glass' } },
```

Sets can optionally add `glow: { color: 'rgba(255, 190, 65, 0.35)', radius: 7 }`
for a subtle, soft halo. The color's alpha controls strength; radius is in room
pixels. Sparks opt in by default; glass does not glow. The halo follows the sprite,
fades with the particle, and shares its depth ordering and room dimming.

To mix one-shot effects, use an array: `breakParticles: { set: ['glass', 'sparks'] }`.
Each set emits its own burst with its own count and physics. Electrical props instead
opt into `electric: true`: while broken, they emit the `spark_1`, `spark_2`, and
`spark_3` particles in short pulses of 3-5 sparks lasting 0.15-0.35 seconds, with a
fresh random pause of 1.2-3 simulation seconds between pulses. The first pulse
starts on the next world update.
Vending machines throw glass once when they break and keep sparking, as do broken
lights. Electrical classification is explicit, not inferred from sprite rows or
power switches; switching a broken prop off does not repair it or stop the sparks.
Sparks use the `breakParticles.area` rectangle when supplied, otherwise the whole
artwork, with the same automatic mirroring as break debris.

Passage door panels are also electrical and spark in each connected room's camera
view while their shared panel state is broken. A broken door alone does not spark.
Repairing a prop or panel stops new sparks; existing particles finish fading normally.
Props loaded already broken also spark, but do not throw one-shot break debris.
Paused updates do not repeat bursts. Long frames emit at most one spark burst per
source rather than replaying a backlog.

By default particles originate across the whole prop. An optional `area: { x, y, w, h }`
in `breakParticles` restricts the burst to a rectangle relative to its displayed
artwork; it is mirrored automatically when the prop is flipped. Origins are sampled
only from opaque pixels in the prop's current frame and state, so transparent padding
and empty parts of the rectangle do not emit particles. The three glass pane
types share the `glass` set, which uses `glass_1`, `glass_2`, and `glass_3`.
Runtime calls to `prop.break()`, breakage during use, and toggling a prop to broken
in the debug prop editor queue a burst for the next world update, so the editor can
preview the effect. Props loaded already broken from `room.json` do not create a
burst. Particles spin in midair and keep their angle after the first floor impact,
even if they bounce or slide. Their rotated bounds stay above the landing line.
Landing requires a green nav-map pixel at or below the emission area's bottom plus
the set's random `scatter` distance. Debris over walls keeps falling until it reaches
green floor along its path; sliding off green floor makes it fall again. Particles
use the painted floor directly, without character clearance margins or furniture
blocking. If there is no floor below, they fall out of the room and are removed.
Particles are room-specific, follow simulation time (including pause), land and
fade, and are discarded at the end of their lifetime. The system limits the
number of live particles across the facility; oldest particles are removed first.

#### Prop Sprite Sheets

The shared props use **96 × 96 pixel cells**, with frames running left to right.
`PROP_SPRITES` in [`sprites.ts`](../src/lib/sim/sprites.ts) declares the artwork-sized
source rectangles inside those cells. Keep every animation frame's crop the same
size and alignment, including room for glow or other effects. This keeps placements,
mirroring, seats, and blocked floor independent of transparent sheet padding.

A single rectangle is a still prop. Multiple rectangles form a looping animation;
`frameSeconds` controls the duration of each frame (defaults to 0.6 simulation seconds).
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
    broken: { frames: [{ x: 28, y: 231, w: 40, h: 17 }] },
  },
},
```

`states` holds the frames for a prop's other looks: `off` (switched off) and `broken`.
They follow the same rules as `frames` and must be cropped to the same size. Put them
on their own row of the sheet: the first row is normal or powered on, the second is
powered off, and the third is broken. Broken artwork takes precedence over power;
repairing the prop restores its previous on/off state. A prop whose sheet has no art
for a look keeps its normal frames; a broken switchable prop without broken artwork
uses its off look instead.

Include the row offset in `y` for explicit metadata. Elevator door and arrow sprites
have their own crops in the same registry. The editor palette uses
the first frame, while placement previews and pixel picking use the current frame.
Animations share simulation time, so pausing the feed freezes them too.
Images without `PROP_SPRITES` metadata stay still when both dimensions are at most
96px. If either dimension is larger, they automatically use 96px cells, animating
left to right along the first row at the same default speed as lights. The first
populated cell in row two supplies a still off look; populated cells in row three
animate as the broken look. Fully transparent cells are skipped, so an empty second
row does not make a prop switchable and blank columns do not cause flickering.
An off look enables manual/editor power controls and `"on": false` in `room.json`;
a broken look enables breakage, the editor's broken control, and `"broken": true`.
An off look does not enable automatic power switching: vending machines and other
props keep their power state when people enter or leave. Only types with
`automaticPowerOff: true` follow room occupancy. Rows after the third never join
the normal animation. An axis smaller than 96px uses its full size; larger axes must
be multiples of 96px so cells are complete. These automatic frames include cell padding.
Add metadata for custom layouts, artwork-sized crops, different timing, or animated
off looks.

#### Carryable Items

Images in [`src/sim_assets/items/`](../src/sim_assets/items/) are separate from props.
Place loose items in a room's `room.json`:

```json
"items": [
  { "type": "can", "x": 200, "y": 140 }
]
```

Coordinates are the artwork crop's top-left corner, like props. Items do not block
walking or provide seats. `ITEM_SPRITES` in [`sprites.ts`](../src/lib/sim/sprites.ts)
defines crops (the can uses a 6x10 crop inside its 96x96 image); unlisted images use
the whole image as a single still frame. Item assets use `item:<type>` keys, so an
item and a prop may share a file name.

Each [`Agent`](../src/lib/sim/agent.ts) has a read-only `item` slot, initially `null`.
`agent.pickUpItem(item)` takes a loose item from the same room within 12 room pixels
of its bottom-center, and throws if the slot is occupied or pickup is unavailable.
`agent.dropItem()` returns that same item to the nearest walkable floor in the
agent's current room. Transport, player dragging, and departure disallow both actions.
Carried items follow their agent through walking, sitting, dragging and room/elevator
travel; they leave the facility with the agent rather than being duplicated on the floor.

The renderer scales carried items with the character and mirrors them for left-facing
poses. Dedicated trip, holding, and use frames have per-frame hand anchors, so items
follow the moving hand; walking, sitting, and talking use the facing-dependent
`ITEM_HAND_ANCHORS` and draw the item behind back-facing characters.
There is no player pickup control yet. Agents with an empty hand get curious about loose
items on the floor: the planner sometimes sends them over (weight 4, or 1.5 while
working) with a `?` bubble, and `pickUp(item)` takes it after a second ("Ana picked up a
can in the Offices."). An agent heading for an item claims it with `agent.curiousAbout`,
so nobody else goes for it; `setPlan` releases the claim. If the item is gone or their
hand is full when they arrive, they show `?` instead. Impostors ignore items, and items
with no open floor within `ITEM_REACH` (12 px) of their base are skipped. Simulation code
can still call the API directly. The personnel panel displays the item slot.
Agents occasionally set a carried item down as well (planner weight `0.25`): they walk
to a random open floor point and call `setDownItem(item)`, which drops the same item
instance there. Other agents may later get curious and pick it up.

A carried item can unlock extra things to do. `ITEM_ACTIONS` in
[`item.ts`](../src/lib/sim/item.ts) lists them per item type; while an agent holds a
matching item, the planner adds each action as an option with its `weight`:

```ts
can: [{ id: 'drink', activity: 'Drinking a can', seconds: 4, weight: 2, consumes: true, done: 'finished a can' }],
```

The action runs as an uninterruptible `useItem` task for `seconds`. With
`consumes: true` the item is used up when it finishes: `agent.consumeItem()` empties the
slot and the item is destroyed rather than dropped. `done` adds a log line
("Ana finished a can in the Offices."). If the item leaves the agent's hand before
the action finishes, the action stops without using it up.

##### Dispensers (vending machines)

A prop type with `dispenses` in `PROP_TYPES` hands out new items. The vending machine
dispenses cans:

```ts
vending_machine: { asset: 'vending_machine', dispenses: 'can' },
```

Its power switch comes from the sheet's off row, and it keeps its power state when the
room empties. `prop.dispensing` is the item type while the prop is not broken and (if
switchable) is on, otherwise `null`.

- **Planner:** agents with an empty hand in a room with a working dispenser sometimes walk
  to its stand point (`prop.standPoint(room)`, just below the artwork), face it and run
  the `getFromDispenser` task (2.5 s). It puts a fresh `Item.create(type)` straight into
  their hand and logs "Ana got a can from the vending machine in the Lobby." Drinking is
  then a normal item action. If the hand filled up or the machine broke or went off
  meanwhile, they show `?` and get nothing.
- **Dragging:** dropping an agent on a working dispenser gets an item ("Get a can from the
  vending_machine"); it is invalid while their hand is full. Dropping them on a switched-off
  machine switches it on, like any switchable prop.

`Item.create` needs an `ITEM_SPRITES` crop for the item type to size it.

#### Placing Props and Items With the Editor

Instead of working out pixels by hand, open `/monitoring?debug`, go to the room's
camera and press **Edit props / items**:

1. Pick a prop or item from its palette and click the feed to place it (it stands where you click).
2. Drag props to move them. Arrow keys nudge the selected prop by 1px (Shift: 10px),
   **F** flips it, **B** makes it start broken, **O** makes a light start off,
   **Delete** removes it, **Esc** cancels.
3. Press **Copy** and replace the `"props"` and `"items"` lists in the room's `room.json` with it.
   The editor supports moving, nudging, flipping, deleting and resetting both; power
   and broken-state controls apply only to props.
4. To test passage damage, click a door or its panel (dashed outlines) and press **B**
   to break or repair it immediately. This changes only the running simulation, is
   shared by both camera views, and is not part of the copied snippet or the room reset.

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

#### Adding Physical Doors

Keep the nav-map passage blue. A passage is doorless unless `room.json` attaches a
door to its id:

```json
"doors": {
  "west": { "clearance": 1 },
  "east": {
    "clearance": 1,
    "offset": { "x": 0, "y": 0 },
    "panelOffset": { "x": 2, "y": -3 }
  }
}
```

`clearance` is a non-negative whole number and selects both the access requirement
and the numbered door artwork. The door and panel are positioned from the nav-map
opening; the optional whole-pixel `offset` moves both, while `panelOffset` moves only
the panel. Panels sit on an approaching character's right: screen-right on north and
side walls, and screen-left on south walls. Side-wall panels follow the wall's slope,
and their sprites are mirrored automatically on east walls. The debug prop editor
does not edit these passage assemblies, but it can break and repair them live
(see [Placing Props and Items With the Editor](#placing-props-and-items-with-the-editor)).

For connected rooms, configuring either side creates a matching door on the other
camera and both views share one lock and animation. If both rooms configure it,
their clearance must match, but their offsets can differ. Remove the entries on both
sides to make the connected passage doorless again. Off-camera passages may also
have doors. Every current facility passage on Levels 0 through 5 has a physical
door configured with that level's clearance and artwork.

A nearby authorized agent (within 40 room pixels of the passage threshold) turns
the panel green and opens the door upward in 0.7 simulation seconds. Agents wait
until it is fully open. Once no authorized agent is nearby, it holds for 1.5 seconds,
then closes and the panel returns to red. An unauthorized agent cannot cross even
when another agent has opened it. The panel glow remains visible in dark rooms.
South-facing doors and their panels draw in front of the room's props and characters
at 35% opacity, so they frame the foreground passage without hiding the room.
Their indicator glow uses the same opacity; other door orientations remain opaque
and behind the room's props and characters.

Each authorized agent approaching a passage rolls the same 1% break chance for
the panel and door independently, once per approach rather than per tick. Both
camera views share damage. A broken door immediately gets stuck closed. A broken
panel goes dark and freezes the door exactly where it was; a fully open door
then lets anyone through without clearance, while a partially open or closed
door cannot be crossed. Door damage takes priority if both components break.
Damage logs a warning and shows an exclamation bubble. Runtime damage lasts until
`world.passageDoorFor(door).repair()` or `.repairPanel()` is called; repairs are
independent and do not change room configuration.

The artwork is in `src/sim_assets/props/`, but is reserved for passage assemblies,
not ordinary props. For clearance `N`, use `door_levelN.png` for north/south walls,
`door_angle_levelN.png` for west walls, and `door_angle_levelN_east.png` for east
walls. East-facing sheets have mirrored door artwork with readable numbers and are
drawn without flipping; the shared angled panel is still flipped on east walls.
The first cell contains the closed door; it slides inside its silhouette rather
than looping sheet frames. Straight
door artwork occupies `(26, 14, 46, 69)` within the 96px cell, and angled artwork
occupies `(35, 0, 26, 96)`. `door_panel.png` and `door_panel_angle.png` use two red
frames in the first row and two green frames in the fourth row. Doors and panels
use broken artwork from the third row; populated broken panel cells animate
horizontally at 0.6 seconds per frame. The off row is unused.
Add the numbered door sheets for another
clearance before configuring it; missing or incomplete artwork is reported at build
time.

#### Connecting Floors With Elevators

An elevator connects many floors, so instead of linking pairs of rooms, each room
names the **shaft** its elevator belongs to. Every room with the same shaft name is a
stop of the same lift:

```json
"elevators": { "shaft": "main" }
```

The pink region in the nav map defines the room's single elevator opening.
Add `"elevators"` to the room on each floor; a
separate lift elsewhere just uses another shaft name, e.g. `"service"`. A shaft can
stop only once per level. Elevators also keep leading off camera, since the shaft
continues to floors that aren't filmed. Level numbers grow going down, so a ride from
Level 1 to Level 2 shows the down arrow. Keep elevator openings in the same place on
every floor so the shaft lines up.

For a large elevator, use `"elevators": { "shaft": "big", "big": true }`, as in
the Level 0 main entrance. It uses `elevator_door_big.png` and carries up to 10
riders together, with separate standing positions inside the car. Riders share a
trip only when their request type, direction and destination match. Standard
elevators omit `big` (or set it to `false`) and carry one person per trip.
The old `"elevator"` property is now named `"shaft"`; update existing room JSON
accordingly. Omitting `shaft` leaves an elevator connected only to off-camera floors.

Cameras are shown as a floor plan: a floor selector (L1, L2, …) next to the selected
floor's rooms, laid out on a grid by how their doors connect: west/east doors place
rooms side by side and north/south doors stack them, with north at the top. Changing
floors shows the camera last watched there, otherwise the room on the same elevator
shaft. Every camera uses the same pixel scale, so narrower rooms appear centred. The
first camera shown is `INITIAL_ROOM` in [`monitoring.astro`](../src/pages/monitoring.astro).

The build stops with the file and pixel position if a nav map uses an unknown colour,
has floor patches that can't be reached, has an exit that doesn't touch the floor, or
doesn't match the size of `room.png`, and names the problem if an exit points to a
door or room that doesn't exist, passage-door artwork or configuration is invalid,
or an elevator or shaft is set up wrong.
