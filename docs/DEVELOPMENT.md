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
rooms are simulated at once and people walk between connected rooms. Roster staff are
built at build time from non-draft personnel files:
height sets sprite size, `colorTint` colours the name tag, and traits such as *Sleepy*,
*Clumsy*, *Anti-Social*, or *Can phase through objects* change how they behave.
Wanted characters are left out. Entities with a *Shapeshifting* ability can sneak in
disguised as staff.

Staff and creatures share proportional height scaling: 1.90 m uses 85% of the base
sprite size, with a 50% minimum for readability and the existing 120% maximum so
giants cannot overwhelm a room. Unknown heights and generated staff use 85%.
This leaves more visible separation between very short and very tall profiles.

Double-click a sprite or name tag to follow that specific agent, security guard, or
creature between cameras. The **Follow selected** control also starts
following; **Stop following**, double-clicking the same actor again, Esc, or manually
choosing a camera or floor stops it. Following waits on the last feed while the actor
is off camera (including elevator rides), then resumes when they return. It stops when
an agent leaves the facility, but not when they are absorbed: following tracks their
remains with the carrier, then the pile's current room after disposal. Selecting a pile
also allows starting to follow it. Camera switching is suspended while dragging an agent.

Character frontmatter supports optional `stats` capacity overrides; see the
[stats authoring reference](../templates/README.md#optional-simulation-stats).
[`stats.ts`](../src/lib/sim/stats.ts) defines the defaults: HP and stamina 100,
magic 0 (disabled), hunger and thirst 100. Each spawned agent and creature gets its own
`stats` pools (`LiveStats`) with `current` and `max`; HP/stamina/magic start full and needs
start at zero. `hasMagic` is true only with a positive magic capacity.
Stats are shared by composition: `Agent` and `Creature` each own a `LiveStats` value
rather than inheriting from a common base class, so code that only needs stats can
accept any `{ stats: LiveStats }`.
Impostors use their entity profile's stats, not the copied staff profile's.
Contained creatures use the same entity profile's stats.
The selected-agent or creature panel updates live values without rebuilding the file.
The same values drive the [vitals HUD](#selected-actor-vitals-hud) on the feed.
Stamina drains while running: agents moving faster than walking pace (fleeing, chasing,
stalking, hurrying out) and creatures dashing (escapes, attacks, hunts, fleeing) spend
`STAMINA_DRAIN_PER_SECOND`, and recover `STAMINA_RECOVERY_PER_SECOND` whenever they are
not running. At zero they get the [`exhausted`](#exhausted) status and move at walking
(agents) or pacing (creatures) speed until it wears off. Use `spendStamina`/`recoverStamina`
from `stats.ts` rather than editing the pool.
Magic, hunger, and thirst don't change yet. HP changes only through events:
creature attacks and swallowing acid lower it, absorbing prey restores it, and zero HP
is fatal (see [Status Effects](#status-effects) and [The Vore System](#the-vore-system)).
Values last only for that agent or creature instance, not across spawns or reloads.
All three character collections validate optional stat blocks, including
synthetics that do not yet spawn in monitoring.

#### Selected-Actor Vitals HUD

Selecting an agent or creature slides a HUD into the feed's top-left corner
([`monitorVitals.ts`](../src/lib/sim/monitorVitals.ts), styled in
[`monitoring.astro`](../src/pages/monitoring.astro) under `.monitor-vitals`). It shows the
name (same name and tint as the name tag, via `actorIdentity` in `monitorTags.ts`), the
camera they are on when it isn't the one being watched, a health bar, thin stamina and
mana lines, and one row per status effect. Esc clears the selection and slides it away.

- **Bars** come from `VITAL_BARS`: each entry names a `LiveStats` pool, a `label`, a
  `size` (`major` thick bar or `minor` line), colour `tiers` (the first tier whose
  `from` fraction the pool reaches wins; `critical` pulses), and an optional
  `shownFor(actor)` filter. Health goes green (60%+) → orange (30%+) → red, and
  mana only shows for actors with magic capacity. Lost HP leaves a pale trail that
  holds for `TRAIL_HOLD_MS`, then catches up (`trailFraction`).
- **Status rows** list `statusBadges(actor.statuses.active)`: the effect's popup icon
  (or a diamond in its popup colour), a +, − or ring sign coloured by its
  [polarity](#status-effects), the label, and a thin timer for timed effects. Rows
  slide in when an effect starts and out when it ends; an effect reapplied while
  sliding out slides straight back. Effects hidden by `hidesPopups` are skipped here too.
- The HUD ignores pointer input, hides in the prop editor, and turns its animations
  off with the site's animation toggle or `prefers-reduced-motion`.

#### Simulation performance benchmark

Run `npm run benchmark:sim` with Node 24 to compare `World.update` at 1x, 2x,
and 4x the checked-in facility size. Each scenario uses 3.5 synthetic staff per
room, a fixed 1/60-second timestep, a 30-second warmup, and three 30-second
measurement samples. The report includes mean and p95 update time, estimated
simulation updates per second, and p95 time as a share of the 16.67 ms 60 Hz
frame budget. It measures simulation updates only, not rendering or browser
frame rate; use it for before/after comparisons rather than as an end-to-end FPS
claim.

#### Crash and freeze diagnostics

Open `/monitoring?debug` and use **Copy diagnostics** below the activity log to copy a
JSON report for troubleshooting. Diagnostics are recorded even without debug mode.
If the browser is locked up, open `/monitoring?debug` first, then copy the report: it
includes the previous session's last saved checkpoint as well as the new session. A
read-only text box supports manual copying when clipboard access is denied.

[`monitorDiagnostics.ts`](../src/lib/sim/monitorDiagnostics.ts) keeps the last 100 entries
(each limited to 2,000 characters), including incidents, camera/pause changes, browser
errors, unhandled rejections, resource failures, frame gaps over two seconds, and frames
taking over one second. Update/render exceptions stop the feed with an explicit message
and record the stack and failing phase. A visible-page watchdog reports when no frame
has completed for over five seconds; hidden tabs are excluded.

State checkpoints are saved locally every five seconds and immediately on caught simulation
errors. They include the camera, speed, simulation clock, active floor/facility events, counts, and
the first 100 agents/creatures with their locations and activities. `snapshotAt` identifies
the state sample's age; `savedAt` identifies the last storage write. Reports include browser
and viewport information but are not uploaded automatically. Storage failures are shown
explicitly. An in-memory report remains copyable in debug mode before reloading.

A fully blocked main thread cannot execute a watchdog or write its exact failing phase;
the previous checkpoint is evidence from before the lockup, not a guaranteed crash stack.
Only the immediately preceding session is retained, so copy it after the first reload.

Drag a sprite or name tag to physically pick up an agent. Dropping on open floor
repositions them, on a free chair or bench seat starts the usual seated activity,
and on another agent starts a conversation. Lights can be toggled; other unseated
props are inspected. Dropping on a cell door or its panel places the agent at its
threshold and intentionally opens that specific door without entering the cell.
This works from either camera view, including unlinked cell doors. The agent needs
the usual access card; broken doors/panels, unpowered doors, and blocked thresholds
reject the drop. Opening uses normal animation and break-on-use checks, then the
usual hold timer lets the door close even if the agent remains nearby.
The held agent pauses while the rest of the facility continues.
Dropping above non-green nav-map pixels makes the agent fall straight down with
gravity and land at a randomly chosen depth of 0-24 pixels into the first continuous
green floor below, then play the usual trip reaction. The depth is chosen once per
fall and limited by that floor's edge, so thin floor strips are never skipped.
If there is no green below, they fall fully out of view and respawn on
nearby walkable floor. Falling agents cannot be picked up or pulled into chats.
Creature reactions wait until the fall and trip recovery finish, including when
the fall is queued but has not started yet.

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

Room routes use the painted floor and a coarse A* grid, with checked connections
from standing points to grid cells. Ordinary destinations must be walkable, and
segments must avoid even thin furniture blockers; ghosts still go straight through.
Seat routes approach on standing floor before the final step into their own prop.
Falls and interrupted arrivals may start outside standing clearance; these routes
first return to the nearest standing point before following checked segments.
`nearestWalkable` and `randomFloorPoint` throw with the room ID when no standing
space exists, rather than returning a blocked fallback position.
Walking, door/elevator approaches, and wall phasing share `Agent.moveAlongPath`,
which carries leftover frame time across waypoints. Reaching a door or elevator
threshold still leaves fading or boarding to a later update.
The `ElevatorOpening` type in [`room.ts`](../src/lib/sim/room.ts) describes
room geometry; the `Elevator` class in [`elevator.ts`](../src/lib/sim/elevator.ts)
owns the car's requests and animation state.

Staff start, arrive, and choose rooms only on floors at or below their profile's
`accessLevel`. `Admin` can visit every floor; unknown or redacted clearances use
level 1. This applies to connected doors, elevators, and ghost arrivals.
Physical passage doors check the best access card in an agent's hand or personal
inventory, rather than their profile, before opening or allowing a crossing.
Arrivals check the starting loadout; live work routes use the agent's actual cards.
Impostors ignore clearance limits. Departure routes check the agent's actual cards
at every door, including the final off-camera exit; wanting to leave does not
unlock restricted doors, though agents may slip through a door already open. Agents wait if no permitted exit route is available.
Waiting for an exit is not an active departure and does not prevent pickup.
If a crossing loses access or its door breaks, the agent returns fully visible to
the inside threshold, cancels the queued departure, and can be picked up again.
Explicit player transfers remain
unrestricted.

##### Data-driven behavior

Simulation definitions are TypeScript data tables, separate from per-actor state. The
main extension points are:

| Definition | Purpose |
| --- | --- |
| `DEFAULT_BEHAVIOR`, `BEHAVIOR_RULES` in [`roster.ts`](../src/lib/sim/roster.ts) | Baseline staff behavior and ordered trait/species matches. Matching rules merge `values`; later matches win. Behavior fields include speed, nap chance, clumsiness, sociability, ghosting and `meow` (the idle meow weight; cats/felines get `1`). |
| `SIM_OVERRIDES` in [`roster.ts`](../src/lib/sim/roster.ts) | Per-profile behavior, starting items, vore settings and trespass responses, keyed by profile slug. Behavior overrides apply after trait rules. |
| `AGENT_ACTIVITIES` in [`planning.ts`](../src/lib/sim/planning.ts) | Named ordinary activities with `weight(context)` and `build(context)`. Add or replace entries without editing the planner. |
| `CREATURE_TUNING` in [`creature.ts`](../src/lib/sim/creature.ts) | Movement, attack damage/reach/timing, roaming and door behavior. Existing containment-class chance tables remain independently configurable. |
| `VORE_PROFILE_RULES`, `VORE_STAFF_RULES`, `VORE_TYPES`, `VORE_TUNING` in [`vore.ts`](../src/lib/sim/vore.ts) | Size/capacity defaults, staff restrictions, type definitions and lifecycle tuning. |

For example, an activity can be appended at initialization:

```ts
AGENT_ACTIVITIES.push({
  id: 'check-instruments',
  weight: ({ working }) => working ? 2 : 0,
  build: () => [wait(8, 'Checking instruments')],
});
```

Activity context shares the room, schedule, candidates and route queries for one
decision. Weight callbacks should be side-effect-free; only the selected activity is
built. Dynamic choices such as item actions use `options(context)` to join the same
weighted draw, preserving each action's relative probability. Escorts, assigned
security duty and repairs retain priority over ordinary activities.

Definitions are shared across worlds; configure them before starting a simulation
rather than storing actor state in them. Built profiles own copies of behavior, vore
weights and trespass policies. New mechanics still need TypeScript handlers; these
tables are extension seams, not a runtime mod loader or an API for executing untrusted
mods.

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

Every non-cell elevator room also gets a security post on reachable floor beside
the lift. Generated guards work separate 06:00–18:00 and 18:00–06:00 watches.
They stay at their post unless responding to a breach or moved by the player.
Breach calls outrank the walk back: a guard returning to post (or due for
handover) takes the next unclaimed loose creature on their floor wherever they are.
Reachable creatures in the guard's current room take priority, nearest first.
Before continuing a pursuit into another room, guards take any available local
call instead; an ongoing local pursuit or escort is completed without switching.
On open floor, escorted creatures can break the guard's grasp: the chance per
simulation second is 4% for Maximum Containment, 1.5% for Containment, and 0.5%
for Safe. A successful break deals 10 HP damage (clamped at zero), clears the
guard's claim and escort route, and gives the guard three seconds to recover.
The creature dashes toward a passable non-cell door, or away across reachable
floor when no door is available; guards can pursue it again after recovering.
Resistance pauses during doorway fades and stops once the creature reaches home.
Initial guards start at their posts when the cameras are populated. At shift
change the guard finishes any escort, returns to post, calls in a replacement,
and leaves by elevator. The replacement queues an elevator arrival, steps out,
and walks to the post, including after debug clock changes. Guards count on camera, but not towards the
staff population target, duplicate-badge events, or roster identification.
Select a guard to see their badge, shift, assigned post, traits and live stats;
there is no database page.

[`generateNpc`](../src/lib/sim/npc.ts) takes a session-unique badge number and a
job (position, clearance and optional schedule). It builds a normal `SimCharacter`
with a random name, traits, trait-derived behavior and stat capacities. Only
security uses it for population today; the generator does not assign guard AI.

Reef, the head of security, and on-duty guards notice reachable staff on their
camera who are above their profile clearance. They escort trespassers to the
nearest reachable non-cell floor within the trespasser's clearance; if no route
is open, they wait and retry. At an elevator, each person requests a place and
waits for the other, so single-person cars take separate trips. If the escorting
staff member or trespasser dies or leaves, the escort ends. When Reef can swallow
the trespasser, he instead chooses that response 10% of the time; the other 90%
are escorted. He cannot swallow someone taller than himself, and normal physical
availability, capacity and cooldown still apply.

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

Every lit light on mains power also has a small chance per second (`LIGHT_FLICKER`
in [`prop.ts`](../src/lib/sim/prop.ts)) to flicker like an old fluorescent tube:
for 0.5–2 seconds it strobes between its on and off artwork in irregular
0.04–0.16 second phases. When a room's last bright light is mid-dark-phase the
camera dims through `room.visualDarkness`, but the effect is visual only —
gameplay `darkness`, trips, and planning never see it, and emergency lights
never flicker.

| File | Purpose |
| --- | --- |
| [`src/sim_assets/`](../src/sim_assets/) | Pixel art: `characters/`, `props/` (shared), `remains/` (what predators leave behind), and one folder per room in `rooms/`. |
| [`src/lib/sim/sprites.ts`](../src/lib/sim/sprites.ts) | What is inside each shared sprite: character frames, prop seats and blocked areas. |
| [`src/lib/sim/prop.ts`](../src/lib/sim/prop.ts) | Placed props and their live state (on/off, broken). |
| [`src/lib/sim/statusEffects.ts`](../src/lib/sim/statusEffects.ts) | Shared status definitions, active effects, durations, and lifecycle hooks. |
| [`src/lib/sim/electrical.ts`](../src/lib/sim/electrical.ts) | Broken electrical prop exposure, shock chances, and recovery grace. |
| [`src/lib/sim/navMap.ts`](../src/lib/sim/navMap.ts) | Reads and checks nav maps at build time. |
| [`src/lib/sim/roomLoader.ts`](../src/lib/sim/roomLoader.ts) | Loads every room folder at build time and connects their doors. |
| [`src/lib/sim/room.ts`](../src/lib/sim/room.ts) | Room geometry: walkable floor, exits, seats, and path finding. |
| [`src/lib/sim/roster.ts`](../src/lib/sim/roster.ts) | Profile → character conversion, trait rules, and per-character overrides. |
| [`src/lib/sim/schedule.ts`](../src/lib/sim/schedule.ts) | Editable daily routine, breaks, and per-character schedule overrides. |
| [`src/lib/sim/agent.ts`](../src/lib/sim/agent.ts) | The `Agent` class: position, stats, carried item, personal inventory, and its task queue. |
| [`src/lib/sim/planning.ts`](../src/lib/sim/planning.ts) | Decision making: which task an idle agent picks next (`planNext`). |
| [`src/lib/sim/security.ts`](../src/lib/sim/security.ts) | Elevator watch, breach response, and escorts back to assigned cells. |
| [`src/lib/sim/trespass.ts`](../src/lib/sim/trespass.ts) | Reef's and guards' trespass response and staff escorts between floors. |
| [`src/lib/sim/tasks.ts`](../src/lib/sim/tasks.ts) | Basic tasks: walking, waiting, napping, falling, tripping, and prop breakage. |
| [`src/lib/sim/repairs.ts`](../src/lib/sim/repairs.ts) | Maintenance staff noticing, claiming, and repairing damaged equipment. |
| [`src/lib/sim/itemTasks.ts`](../src/lib/sim/itemTasks.ts) | Item tasks: using, picking up, setting down, and getting items from dispensers. |
| [`src/lib/sim/conversation.ts`](../src/lib/sim/conversation.ts) | Chats between two agents: meeting points, turns, and speech bubbles. |
| [`src/lib/sim/vore.ts`](../src/lib/sim/vore.ts) | Vore rules and tuning: roles from `vorePreference`, who may swallow whom, the ways of swallowing, and what prey do inside. |
| [`src/lib/sim/voreSystem.ts`](../src/lib/sim/voreSystem.ts) | `world.vore`: hunts, swallowing, acid, absorption, spitting out, and disposing of remains. |
| [`src/lib/sim/voreTasks.ts`](../src/lib/sim/voreTasks.ts) | The `stalk` task an agent runs while closing in on prey. |
| [`src/lib/sim/remains.ts`](../src/lib/sim/remains.ts) | `Remains`: what is left of absorbed prey until its predator drops it on the floor. |
| [`src/lib/sim/transport.ts`](../src/lib/sim/transport.ts) | Leaving and entering rooms through doors and elevators, and leaving the facility. |
| [`src/lib/sim/world.ts`](../src/lib/sim/world.ts) | All rooms and people: arrivals, departures, and the per-frame update. |
| [`src/lib/sim/routing.ts`](../src/lib/sim/routing.ts) | Which rooms an agent may visit and which door or floor leads toward work or the exit. |
| [`src/lib/sim/elevator.ts`](../src/lib/sim/elevator.ts) | Elevator cars: requests, door timing, and passenger layout. |
| [`src/lib/sim/passages.ts`](../src/lib/sim/passages.ts) | Live state of passage doors between rooms (locks, panels, who is passing). |
| [`src/lib/sim/random.ts`](../src/lib/sim/random.ts) | The single source of randomness (`random`, `chance`, `pick`, ...). Use it instead of `Math.random`; `setRandomSource` swaps in a seeded generator. |
| [`src/lib/sim/facilityEvents.ts`](../src/lib/sim/facilityEvents.ts) | Facility event registry, timed impostor arrivals and A1 announcements, plus achievement definitions. |
| [`src/lib/sim/earthquake.ts`](../src/lib/sim/earthquake.ts) | Earthquake tuning and effects across all rooms. |
| [`src/lib/sim/eventState.ts`](../src/lib/sim/eventState.ts) | Shared floor/facility event lifecycle and display shake. |
| [`src/lib/sim/levelEvents.ts`](../src/lib/sim/levelEvents.ts) | Floor event definitions and floor-specific simulation rules. |
| [`src/lib/sim/levelState.ts`](../src/lib/sim/levelState.ts) | Per-floor state and event lifecycle. |
| [`src/lib/sim/render.ts`](../src/lib/sim/render.ts) | Asset loading and drawing a camera feed onto a canvas. |
| [`src/lib/sim/monitor.ts`](../src/lib/sim/monitor.ts) | Boots the monitoring page: cameras, drag and drop, and the frame loop. Its panels live in `monitorFile.ts` (personnel file), `monitorVitals.ts` (selected-actor vitals HUD), `monitorTags.ts` (name tags), `monitorDebug.ts` and `monitorEditor.ts` (`?debug` tools), and `monitorProgress.ts` (saved progress). |

Add `?debug` to the URL to show buttons that trigger events, speed up time, and open
the prop editor (see [Placing Props With the Editor](#placing-props-with-the-editor)).
The **Selected** row applies or removes any removable agent/creature status effect on
the selected actor and has a **Hurt −20 HP** button, for previewing the
[vitals HUD](#selected-actor-vitals-hud).
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
Expected character cells that are transparent or outside the image use
[`missing_texture.png`](../src/sim_assets/missing_texture.png) at the same size and anchor.
Unused cells outside the listed animations are ignored.

#### Floor Events and Variables

Register floor-specific rules in `LEVEL_DEFINITIONS` in [`levelEvents.ts`](../src/lib/sim/levelEvents.ts),
keyed by the numeric `level` from `room.json`. Every room on that floor reads the same
state through `world.level(room.level)`. Even floors without rules have their own
state; floors with no loaded rooms return `undefined`. Variables are
booleans, numbers, strings, or `null`, and each world gets a fresh copy of the
defaults. Floor state is not saved on reload.

Facility-wide events are registered in `FACILITY_EVENTS` in
[`facilityEvents.ts`](../src/lib/sim/facilityEvents.ts) and run through `world.events`.
They use the same lifecycle as floor events, extracted into
[`eventState.ts`](../src/lib/sim/eventState.ts), but receive `(world, world, dt)`
rather than `(level, world, dt)` in their update hooks. Add an entry with a label,
optional duration, and start/update/end hooks; no world-loop or debug UI edits are
needed. `WorldOptions.events` can override or add definitions for a particular world.
An event can also set `alert: { text, priority }` to show a top-right HUD alert while
active. Only facility alerts and alerts for the viewed floor are considered; the
highest priority wins (active incident: 100, duplicate badge: 50). Events without
alert metadata do not change the HUD.
`FacilityEventDirector` still schedules announcements and impostor arrivals separately.

`LEVEL_EVENTS` defines events available on every floor. Floor-specific event
definitions override shared events with the same ID. `level.availableEvents`
lists the IDs and labels for the debug picker. For example, this entry defines
a Level 2 power test without changing the lights:

```ts
2: {
  variables: { powerOnline: true },
  events: {
    'power-test': {
      duration: 30,
      onStart: (level) => { level.variables.set('powerOnline', false); },
      onEnd: (level) => { level.variables.set('powerOnline', true); },
    },
  },
},
```

Start it from simulation logic with `world.level(2)?.startEvent('power-test')`.
Use `level.hasEvent('power-test')` to check it, `level.activeEvents` to inspect its
timing, and `level.stopEvent('power-test')` to end it early. An event can only have
one active instance per floor; a second start does not refresh it. Different
events can overlap. You can override the duration with a second argument to
`startEvent`; without any duration, the event lasts until stopped.

An event can use `onStart`, `onUpdate`, and `onEnd` to apply, sustain, and clean up
its effects. `onEnd` receives `'stopped'` or `'expired'`. A floor can use its own
`onUpdate` hook to decide when to trigger events. All floors advance with the
simulation clock before agents and room systems update, even off-camera. No
automatic triggers are enabled by default.

##### Containment failure

Open `/monitoring?debug`, switch to the floor you want, and use the **Event**
picker with **Trigger event** or **End event**. Floor entries target the current
camera's floor, even if no agents are on camera. Entries marked **facility-wide**
target the entire facility regardless of the selected camera.

##### Earthquake

Select **Earthquake (facility-wide)** in that picker, or call
`world.events.startEvent('earthquake')`. It lasts **20 simulation seconds** by
default; a second duration argument overrides this, and
`world.events.stopEvent('earthquake')` ends it early. Like floor events, it has no
automatic random trigger. `hasEvent`, `activeEvents`, and `availableEvents` work
on `world.events` too. Pause freezes its duration, debris emission and display shake.

All earthquake tuning lives in `EARTHQUAKE` in
[`earthquake.ts`](../src/lib/sim/earthquake.ts):

| Setting | Default |
| --- | --- |
| `cameraShake` | At most 2 display pixels per axis, at speed 32 radians/second |
| `alert` | “Earthquake” in the monitoring HUD at priority 80 |
| `tripRate` | 0.65 per eligible agent/second |
| `propBreakRate` | 0.015 per intact breakable prop/second |
| `doorOpenRate` | 0.035 per closed, intact physical passage/second |
| `doorHoldSeconds` | 2-5 seconds |
| `debris` | A `rock` burst per room every 0.4-1.2 seconds, from ceiling y=0 |

Rates use `1 - exp(-rate * dt)`, so probability scales with simulation time.
Standing and walking staff, including impostors, can lose their footing regardless
of clumsiness. Seated, sleeping, already tripping, incapacitated, held, swallowed,
ghost, escorted, conversing and in-transit agents are excluded. Trips reuse normal
recovery, achievements, and nearby-prop impact behavior.

Damage uses normal prop breakage, debris, sparks, interrupted usage and repair
behavior. Linked door endpoints are rolled only once. Selected doors slide open
at normal speed and temporarily bypass panels and power; they are not damaged or
repaired. Earthquake holds have their own owner, so ending them never cancels another
event's door override. Broken doors are not selected. Ending the quake releases
its holds but leaves prop damage for repairs and existing particles to fade out.

The `rock` set in [`particles.ts`](../src/lib/sim/particles.ts) uses the three
`rock_*.png` sprites with gravity, spin, bounce, and fading. Rocks fall onto the
painted floor; bursts occur off-camera too and obey the global particle limit.
Long frames emit at most one burst per room instead of replaying missed bursts.
Display shake is generic event data (`cameraShake`); the scene and name tags move
together, preserving pointer coordinates. Reduced-motion preferences disable only
the visual shake, not the simulation effects.

The shared **Containment failure** event (`containment-failure`) slides cell
doors on that floor open one at a time, in room and door order. Each door finishes
opening at its normal speed (0.7 simulation seconds, or 2 seconds for big doors)
before the next starts, and stays open, including empty cells and unlinked cell
doors. A door already open is held open immediately when its turn arrives.
Every resident present in its cell actively tries to escape, regardless of its
normal containment-class escape chance. Residents away in disguise remain
pending until they return and can escape. Already-loose residents are included;
creatures that had already fled the facility or been absorbed by a predator are not.

Capturing a creature does not release its door: security must escort it home.
`World.recontain(creature)` releases that cell's door immediately, or skips it if
it is still waiting to open; other cells remain queued or held open. A creature
that flees the facility does not release its door early: it remains queued or
held open until the event ends. The event ends automatically when every affected
resident has been returned home, fled, or been absorbed, or manually through **End event**.
Ending the event cancels any doors still waiting to open. An empty affected
roster ends immediately. There is no random trigger or default
time limit. Holding doors open bypasses clearance, broken panels, blackouts, and
broken doors: a broken cell door is forced open without being repaired, and drops
shut again (still broken) once released. Ending the event restores normal door
behavior, including existing damage, power outages, and doorway occupancy safety.

##### Blackout and backup power

The shared **Blackout** event immediately cuts power to all lights, door panels,
and electrical props (currently lights and vending machines) on that floor.
After **10 simulation seconds**, backup generation restores door panels and
forces working lights on in red emergency mode, including empty rooms. Rooms
with emergency lights keep the dark-room dimming and get a red `color`-blend
tint, which replaces hue but keeps each pixel's brightness, so floors of any
palette turn equally red (multiply crushed blue floors to near black). The
emergency lights are then redrawn above the tint at full brightness with a red
halo (`EMERGENCY_GLOW`), and door panel glows draw on top. This is visual only: emergency-lit rooms count
as lit for gameplay darkness. Vending
machines stay unusable. Pausing freezes the delay; debug speed accelerates it.
The blackout remains active until ended manually; there is no random trigger.

`room.power` is `'normal'`, `'off'`, or `'backup'`. Props derive effective power
from their room, including props added or replaced in the editor mid-event.
An outage does not overwrite prop switches or damage: ending it returns to normal
power and motion-sensor behavior without repairing broken equipment.
Ending a blackout restores the floor's mains (and door panels) immediately, but
each electric prop comes back to life at its own random moment within the next
`BLACKOUT_RESTORE_SECONDS` (5 simulation seconds), going dark until then — a
deliberate "coming to life" effect rather than everything snapping on at once.
Replacing a room's props in the editor resets their power sources and skips any
pending restore delay.
Emergency lights cannot be manually switched, and a vending interaction already
in progress cannot dispense while its supply is down. Unpowered electrical props
do not spark or shock. Unpowered door panels cannot open doors; doors freeze in
place, so doors at least half open remain passable. Linked camera views share the same
door power state (a blackout on either endpoint cuts its supply). Backup power
does not bypass clearance or repair broken doors/panels.

#### Incident Feed

The **Incidents** panel on `/monitoring` groups related simulation steps (escape →
dispatch → capture → recontainment) into one entry with camera links. Active
incidents stay pinned at the top and drive the status banner; resolved ones keep
their outcome and duration. Routine lines still go to the **Activity log**.
Incidents live in memory only and reset on reload.

Everything shown is data in [`incidents.ts`](../src/lib/sim/incidents.ts):

- `INCIDENT_TYPES` — one entry per kind of incident: `title(context)`, the banner
  `status`, and an optional `collects(incident, context)` rule that lets an active
  incident absorb steps that would otherwise open a new one (a containment failure
  collects every escape from its floor).
- `INCIDENT_STEPS` — one entry per reportable step: `tone`, `text(context)`, and flags:
  - `opens: type` starts an incident unless the creature already belongs to one.
  - `joins: type` attaches a creature-less step to the active incident of that type on
    the same floor.
  - `settles` marks the creature as no longer needing a response; `outcome` is shown
    once the incident resolves (latest wins).
  - `holds` / `releases` keep an incident open with no unsettled creatures (e.g. while
    a floor event runs).
  - `latestOnly` replaces the creature's earlier step of the same kind, so repeated
    sightings don't flood the entry.

An incident resolves when it isn't held and every creature in it has settled; later
escapes open a new incident. Steps that neither open nor match an active incident are
normally ignored. An explicitly linked follow-up can add to a resolved incident
without changing its outcome or duration, as long as it's still in the feed.
Up to `INCIDENT_HISTORY` resolved incidents and `INCIDENT_MAX_STEPS` steps per incident
are kept (the opening step always stays).

When an escapee absorbs someone, its incident gets a timeline step without settling
the escapee, even if it has already been returned to its cell. If the prey is also
an escapee, absorption settles the prey. A shared incident gets only the prey's step.
The predator's follow-up goes to the incident linked at swallowing, not a newer breach.

Simulation code only reports step IDs:

```ts
world.incidents.record('captured', { creature, other: guard, room });
```

To add an incident kind, add a type, add its steps, and call `record` where they
happen. Rendering lives in [`monitorIncidents.ts`](../src/lib/sim/monitorIncidents.ts).

#### Adding a Room

Each room is a folder in [`src/sim_assets/rooms/`](../src/sim_assets/rooms/).
Name room folders with lowercase kebab-case; the folder name is the room ID used
by `exits` in `room.json`, so update those references when renaming a room:

```text
rooms/level-1-offices/
|-- room.png        # The room art. Leave the elevator opening transparent.
|-- nav_map.png      # Same size as room.png, painted with the colours below.
|-- room.json       # Name, camera label, and where props are placed.
`-- prototype.png   # Optional mockup; not used by the site.
```

#### Reusing a Room as Multiple Cameras

When rooms have the same layout, artwork and starting props, one folder can define
multiple independent room instances. Add `cameraGroup` and an `instances` array to
the template's `room.json`, with a unique ID, name, camera label and exits for
each instance. The template's own name and camera are still required, but the
template itself is not a camera. Put exits on the instances, not the template.
For example:

```json
{
  "name": "Heavy Containment Cell",
  "level": 3,
  "camera": "Cell template",
  "cameraGroup": "Heavy Containment Cells",
  "containmentCell": true,
  "instances": [
    {
      "id": "level-3-heavy-cell-01",
      "name": "Cell 01",
      "camera": "CAM 3-03",
      "exits": {
        "south": { "room": "level-3-heavy-containment-room", "door": "north-1" }
      }
    }
  ]
}
```

The shared image, nav map, props and items come from the template folder. Each
instance has its own runtime props, items, doors and ID; the prop editor points
back to the shared template, so saved placement changes apply to all instances.
Their cameras appear in a responsive group below the normal floor-plan map.
Each linked door has one shared state across its two views, but a separate state
from the other cells.

`containmentCell` gives each runtime room its own `cell.creatureId`, initially
`null`. When a monitoring session starts, it shuffles the cells and the published
entity profiles with `type: Creature`, excluding `containmentClass: Ally` (Class A).
Each creature gets its own cell; if there are too few cells, a random subset is
housed that session. Assignments are not written to JSON or saved across reloads.
A shapeshifter's cell stays reserved but empty while it is posing as staff,
including during elevator rides. It returns to that cell when the event agent leaves.

Residents [pace, watch, and rest](../src/lib/sim/creature.ts) on their cell's
walkable floor, even off camera. They count for lights and camera occupancy;
select their sprites or name tags to see their activity and entity database link.
Creature (and unmasked shapeshifter) name tags and file headings show the entity's
nickname, falling back to its ID (e.g. `C-331`) when it has none; the file kicker
reads `Entity file · ID …` like staff badges, with containment state under Status.
They cannot be dragged, take staff jobs, or use elevators. Cells do not
count towards staff population or serve as initial spawn or work rooms, though
staff can still visit through linked doors.

Creatures watch their cell's physical doors. Each time one swings fully open
(cleared staff walking past, or stuck open after a power cut), the resident rolls
once to dash for it: `ESCAPE_CHANCE` gives Maximum Containment (M) creatures a 40%
chance, Containment (C, also used for unknown classes such as Unassigned) 6%, and
Safe (S) 3%. A door that is still at least half open can be squeezed through, and a
creature in the doorway keeps it from closing; if it shuts first, the creature gives
up after two seconds. Once out, a loose creature keeps its cell reservation and roams
any room on camera through passable doors (open archways, or doors at least half
open), never entering a cell. Leaving through an off-camera exit makes it
`escaped`: it is on no camera and only `World.recontain(creature)` brings it back.
Security responds while a creature is still physically in the facility. One
available guard on the same floor claims the call if there is a reachable route
to the creature's floor area. The guard follows through linked doors and must
get within 14 room pixels to catch it. The creature then moves with the guard
through the actual doors to its reserved cell; the guard waits rather than
crossing a blocked passage. `World.recontain` completes delivery inside the cell
and the guard returns to the elevator. Disguised residents and off-camera
escapees are not dispatch targets. A loose or escorted shapeshifter is not
chosen for impostor events.

Creatures can randomly attack staff or security in the same room, including visitors
to their cell. `ATTACK_CHANCE` in [`creature.ts`](../src/lib/sim/creature.ts) gives
the chance to start an attack per simulation second: Safe (S) 0.5%, Containment (C,
also the fallback for unknown classes) 2.5%, and Maximum Containment (M) 8%.
Rolls scale with elapsed time, not frame count, and select one reachable, living
target on the room floor. Held agents, ghosts, impostors and doorway fades are
excluded. The creature approaches for up to ten seconds and strikes within 14 room
pixels, dealing 10 HP damage with normal death handling; survivors recover for
three seconds. A hit or escort breakaway that lowers the target's HP emits one
`blood` particle burst from the injured person in their room. The drops fall to
the floor and fade out. Hits and abandoned pursuits have a five-second cooldown.
Attacks do not interrupt escapes, fleeing or escorts (escort resistance remains separate).
Target eligibility is shared between selection and pursuit; hunger and proximity
triggers are not implemented yet.

Staff react to a loose creature in their room
([`creatureReactions.ts`](../src/lib/sim/creatureReactions.ts)) once per sighting;
the sighting resets when either of them leaves the room. Impostors and agents that
are leaving or held don't react; napping agents, those in transport, and those
busy with a non-interruptible task react once they're free. `CREATURE_REACTIONS` weights the choice:

- **Scared** (65%): the agent gets the `scared` status, shouts `!`, and flees
  through the reachable linked door farthest from the creature. If the creature is
  closer to that door, or there is none, they run for the facility exit instead;
  with no way out, they cower in the corner farthest from it.
- **Look** (20%): they creep to about 36 room pixels away and watch it for a few
  seconds. A quarter of the time (`LOOK_STARTLE_CHANCE`) it startles them anyway.
- **Pet** (15%): they walk right up, the creature holds still
  (`Creature.hold`), and `PET_CHANCE` decides by class (M 20%, C 45%, S 70%).
  Success logs a petting and shows `♥`; failure means it snapped at them, and
  they get scared.

Curious agents follow a moving creature, give up after 20 seconds, and stop at
the closest point they can reach when it's on another floor area of the room.

[`creature_spritesheet.png`](../src/sim_assets/creatures/creature_spritesheet.png)
uses the same 96×96, bottom-centred frame grid as the staff sheet. Empty movement
or back-facing frames use the available idle art (side poses are mirrored for
left). Filling in the corresponding walk or idle cells enables them automatically.
[`security_spritesheet.png`](../src/sim_assets/characters/security_spritesheet.png)
uses the same grid and idle fallback for missing poses.

#### Painting a Navigation Map

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

Staff with the `Maintenance` job title (case-insensitive, at any clearance level)
prioritize the nearest reachable broken prop, passage door, or door panel in their
current room, even outside work hours and in darkness. They can abandon interruptible
activities, but not conversations, naps, transport, or recovery from a fall/trip.
They walk to the equipment, then spend 12 simulation seconds repairing each component
(`REPAIR_SECONDS` in [`repairs.ts`](../src/lib/sim/repairs.ts)). Each component is
reserved while approached or repaired, including across both camera views of a
passage; cancellation or removal releases the claim. Repairs stop if the target is
removed, already fixed, or no longer within reach. They preserve power settings
and exported starting state. Impostors do not repair equipment.

#### Status Effects

Agents, creatures, props and items each have a `statuses` collection from
[`statusEffects.ts`](../src/lib/sim/statusEffects.ts). Physical passage doors use
`statuses` for the door and `panelStatuses` for its independently repairable panel.
`broken` applies only to breakable props, doors and panels.
The existing `broken`/`panelBroken` properties and break/repair methods read and
change that same collection, not a second damage flag. Applying it through the
status API also triggers the usual break particles and door/panel state transitions.
Power is still separate; repairing damage never changes a prop's power setting.
Starting damage from `room.json` does not emit runtime break particles.

```ts
prop.statuses.apply('broken'); // Same damage state as prop.break().
prop.statuses.has('broken');
prop.statuses.remove('broken'); // Same repair state as prop.repair().
const effects = prop.statuses.active; // Read-only snapshots: id, label, polarity, remaining, duration.
```

Add a definition to `STATUS_EFFECTS` to introduce an effect. Each definition has a
`label`, `targets` (`agent`, `creature`, `prop`, `item`, `door`, or `panel`), and a
`polarity`: `positive`, `negative` or `neutral`, i.e. whether the effect helps, harms
or merely describes its target. `STATUS_POLARITIES` gives each polarity a label and
colour; the [vitals HUD](#selected-actor-vitals-hud) draws a +, − or ring sign in that
colour. Every built-in effect is currently `negative`. A definition can also provide:

- `duration`: positive, finite simulation seconds; omit for permanent effects.
- `irreversible`: prevents removal, clearing, expiry, and duration overrides.
- `blocksActions`: pauses an agent's or creature's current task and movement without cancelling
  its plan or releasing reservations. Multiple blockers use the longest remaining
  duration; only the unstunned portion of an expiry frame advances the task.
- `canApply(target)`: optional eligibility rule beyond the target kind.
- `onApply(target)`: runs once when first added.
- `onUpdate(target, world, dt)`: optional gameplay behavior each simulation update.
- `onRemove(target, reason)`: cleanup on explicit removal (`removed`) or expiry
  (`expired`). Use it to undo any persistent changes made by `onApply`.

The target contains `kind` and `entity`; narrow by `kind` before accessing
entity-specific fields. Definitions need no sprite or other art. No wet, fire or
bleeding gameplay is enabled yet.

For an overhead character popup, add `popup: { icon?, color, background? }` to the
definition. Use an asset URL for `icon` (for example,
`new URL('../../sim_assets/icons/shocked.svg', import.meta.url).href`); without one
the popup is a plain box with a dot in `color`, until artwork exists.
`color` sets the border color; optional `background` overrides the usual dark
popup box. The SVG controls its own artwork colors. Popups sit above speech and
name tags, participate in the same overlap avoidance, and remain visible in
hover-only name-tag mode. Multiple effects appear side by side; effects without
`popup` have no overhead UI. Popups follow the active status, including duration
overrides, refreshes, pause, explicit removal and expiry. `hidesPopups` lists effects
that stay hidden while this one is active, both as popups and as vitals HUD rows
(`shownStatuses` applies it); the converted vore statuses use it to replace **Dead**.

Use `entity.statuses.apply(id, seconds)` to override a definition's duration.
Only one instance of an effect can exist per target: reapplying a timed effect
resets its remaining duration without stacking or rerunning `onApply`. Reapplying
an already-permanent effect is a no-op. `apply` returns false for an ineligible
target or an already-permanent effect, and true for additions or timed refreshes.
Unknown effect IDs and invalid durations/timesteps throw explanatory errors.
`get(id)` returns a snapshot or `undefined`; a snapshot's `duration` is the length of
the current timed instance (including overrides and refreshes), or `null` when permanent.
`has(id)` checks presence;
`remove(id)` returns whether it removed anything; `clear()` removes removable effects.

HP reaching zero or below immediately applies the irreversible `dead` effect to
staff, security agents, and creatures. HP stays at zero; later healing cannot
revive them. Dead actors remain visible with a permanent **Dead** popup using
`dead.svg` (a white skull fitted to the icon area, with a red border and dark-red
background), and a frozen idle frame until death sprites are added. They cannot
move, run tasks, react, escape, or be captured. Agent task/conversation resources
are released on the next update (including held agents and elevator riders);
escorts release dead creatures immediately. Death is not a facility departure.
Swallowed prey take their own effects (`acid`, then a converted status); see
[The Vore System](#the-vore-system).

`World.update` ticks statuses once per simulation frame, before movement and task
planning, including creatures, held agents, off-camera elevator riders, and loose, carried,
stored or remains-held items. Linked doors are deduplicated across camera views. Effects use
simulation time, so pause and speed controls apply automatically. A final update
is capped to the remaining lifetime before expiry; hooks may safely remove or
refresh effects. Effects added inside a collection's update hook first tick on
that collection's next update. Removed agents and consumed items stop ticking.
Runtime effects are not saved to placement exports or `room.json`; existing
`on` and `broken` starting-state/editor formats are unchanged.

##### Electrical Shock

`shocked` is an agent-only effect lasting two simulation seconds (`SHOCK_SECONDS`
in [`statusEffects.ts`](../src/lib/sim/statusEffects.ts)). It pauses movement,
planning, task progress and item actions, and makes the agent unavailable for
dragging or new conversations. The personnel file shows **Shocked**, and existing
idle artwork, shaking and a yellow-bordered popup using
[`shocked.svg`](../src/sim_assets/icons/shocked.svg) provide feedback. Its border
and optional background are configured in the effect's `popup` definition.
The popup does not overwrite speech or sleeping bubbles.
The same task resumes afterward, including a maintenance repair and its claim.
Shock does not currently damage HP or spread to other agents/items.

[`electrical.ts`](../src/lib/sim/electrical.ts) controls exposure:

- Walking within 10 room pixels of a broken electrical prop's `impactBounds`
  gives a 20% shock chance **once per approach**, not per frame. Leaving the radius
  and approaching again permits a fresh roll. Swept movement checks also catch
  long frames whose start and end points are both outside the radius.
- Actually inspecting, using or starting to repair one gives a 50% chance,
  once per interaction attempt. Drag/drop previews and paused updates never roll.
  Broken electrical props remain inspectable through drag/drop with a
  **shock risk** warning; broken non-electrical props remain unavailable.
- A successful shock gives four seconds of grace after its normal two-second
  stun, and exposure cannot refresh a shock that is still active.
- Only broken props explicitly marked `electric` qualify, even when switched off,
  matching their existing spark behavior. Removed, distant and other-room props
  cannot shock an interacting agent. Held, off-camera, fading and elevator-inside
  agents do not receive environmental shocks. Standing still nearby is not an
  approach. Passage panels retain their existing spark/repair behavior; shock
  exposure currently applies to placed props only.

The reach, chances and grace duration are exported constants in
[`electrical.ts`](../src/lib/sim/electrical.ts). Use
`agent.statuses.apply('shocked')` for scripted shocks; normal electrical exposure
also logs a warning and applies the recovery grace.

##### Scared

`scared` is an agent-only effect lasting ten simulation seconds (`SCARED_SECONDS`).
It shows a white-bordered popup with
[`scared.svg`](../src/sim_assets/icons/scared.svg) (white artwork) and a brief
shake. Unlike shock, it doesn't block actions: frightened staff are busy running
away. Staff get it when they see a loose creature, are startled while watching
one, or get snapped at while trying to pet one (see the creature section above).
Use `agent.statuses.apply('scared')` for scripted scares.

##### Exhausted

`exhausted` applies to agents and creatures whose stamina hits zero while running, and
lasts five simulation seconds (`EXHAUSTED_SECONDS`). While it is active, `spendStamina`
refuses, so they can't run or dash; stamina keeps regenerating meanwhile. It shows a
green popup with [`exhausted.svg`](../src/sim_assets/icons/exhausted.svg) and doesn't
block actions. Use `statuses.apply('exhausted')` to tire someone out from a script.

#### The Vore System

Predators swallow other characters whole. [`vore.ts`](../src/lib/sim/vore.ts) holds the
rules (who may swallow whom, the ways of doing it, what prey do inside) and
[`voreSystem.ts`](../src/lib/sim/voreSystem.ts) runs everything that follows through one
`VoreSystem` per world, `world.vore`. It is driven by the `vorePreference` of personnel
and entities, so staff, security guards, and creatures all take part. Each agent and
creature owns a `VoreState` (`actor.vore`), shared by composition like `LiveStats`.

##### Roles and sizes

`parseVoreRole` maps `vorePreference` onto a role: `Predator` (or `Pred`), `Prey`,
`Switch` (also anyone listing both Predator and Prey), or `none`. `None` or `Non-Vore`
anywhere in the list wins, so `[Predator, Non-Vore]` is `none`, as is a missing or
unrecognised value. Characters with no role never swallow and normally cannot be
swallowed; Reef's trespass response is an exception.
Generated staff (`generateNpc`), including unlinked security guards, are prey.

Sizes come from the profile's `height`, parsed like the sprite scale; an unknown height
counts as the base sprite (1.9 m). A height written as "Varies" or "Variable" marks a
shapeshifter. `huntRate(swallower, target)` returns the chance per second that one goes
after the other, or 0 when the rules forbid it:

- The target must be on the prey side of the encounter: a Prey, or a Switch acting as prey.
- **Predators** must be taller than their target (`VORE_TUNING.predatorSizeRatio`, where 1
  means merely taller) unless their profile is `anySize`. Slimes (species containing
  "slime", such as M-031) and varied-height shapeshifters are by default, so they swallow
  smaller and same-size prey too. The chance is 2% per second (`huntRate.predator`).
- **Prey** swallow only someone at least three times shorter (`preyOversizeRatio`; a 30 ft
  creature can take a 5 ft agent), at 0.3% per second (`huntRate.prey`).
- **Switches** choose a side per target. At 35% HP or less (`switchWeakHp`) they are prey.
  Otherwise they take the opposite side to a Predator or Prey. Between two switches, the
  one ahead by at least 20 points of HP share (`switchHpEdge`) is the predator and the
  other the prey; a closer match means neither. As predators they follow the same size
  rule at 1% per second (`huntRate.switch`).

A predator holds `capacity` prey at once: one by default, two from 3 m tall, and three
from 6 m or with `anySize`. These defaults and the species patterns granting `anySize`
live in `VORE_PROFILE_RULES`; add a capacity band or species match there.

Staff and security guards are teammates. Outside Reef's exception below, one can
swallow another only when their profiles are explicitly Predator and Prey, the
predator is at least three times as tall (`staffSizeRatio`), and there are no
other agents or guards in the room.
Creatures do not count as witnesses. The size rule also applies to slimes and
varied-height staff, and it is rechecked while stalking and at the swallow.
These restrictions do not change encounters involving creatures.
`VORE_STAFF_RULES` configures the allowed predator/prey roles and whether privacy is
required; the underlying encounter rules and `staffSizeRatio` still apply.

Reef has a separate exception for trespassers above their clearance: he may
swallow them regardless of their vore role or other staff in the room, but only
if they are no taller than him. His decision between that and an escort is
described in the [security section](#live-monitoring-simulation).
This is configured as `SIM_OVERRIDES.reef.trespassResponse` (`swallowChance: 0.1`,
`sizeRatio: 1`), not a character-ID branch in the AI. The same policy can be assigned
to other staff; a zero chance makes them always escort. Disguises never inherit it.

##### Hunting and swallowing

`VoreSystem.eligible(predator, prey)` is the single check: the rules above, both standing
on the floor of the same room, the predator alive with room left, and the prey alive, not
inside or holding someone, not spat out in the last 45 s (`safeAfterSpit`), and not a
disguised shapeshifter or a ghost (anyone who phases through objects). Agents who are
leaving, held, escorted, riding, passing through a door, or falling are never eligible.

Each update, every character that is free (agents not on guard duty, napping, chatting, or
in an uninterruptible task; creatures not fleeing, attacking, escaping or escorted) and off
cooldown adds up the chances against everyone eligible in its room and rolls once. Reef's
trespass responses use their separate 10% choice rather than this ordinary hunt roll. On a
hit it picks a target by weight, checks there is a route, logs "is stalking", and goes
after it: agents run the `stalk` task ([`voreTasks.ts`](../src/lib/sim/voreTasks.ts)),
creatures a `swallow` plan. Both chase faster than walking speed, re-route as the target
moves, and give up after `huntTimeout` (12 s) or once the target is no longer eligible.
Within `reach` (14 room pixels) they call `world.vore.swallow(predator, prey, type)`, which
scripts can call directly too; it returns false, changing nothing, when the rules don't
allow it. The swallower then waits `cooldown` (30–60 s) before hunting again.

##### Ways of swallowing

Each swallow uses one of four ways, picked by weight from the predator's profile.
`VORE_TYPES` is the table to extend with each way's own quirks:

| Type | Label | Weight | Status once digested | Remains artwork (chance) | Disposal activity |
| --- | --- | --- | --- | --- | --- |
| `oral` | Oral vore | 6 | `digested` | `bones` (50%), `scat` (50%) | Defecating (12 s) |
| `cock` | Cock vore | 1 | `cumified` or `urine` | `cum` (95%), `pee` (5%) | Jerking Off (20 s) or Urinating (12 s) |
| `anal` | Anal vore | 1 | `digested` | `bones` (50%), `scat` (50%) | Defecating (12 s) |
| `breast` | Breast vore | 1 | `milkified` | `milk` (100%) | Milking themselves (12 s) |

Each type also has `digestion`, `escape` and `absorption` multipliers (all 1 for now) on
the acid damage, spit-out odds and absorption time. Each `outcomes` entry specifies its
relative `weight` (5 and 95 mean 5% and 95%), `look` (artwork), `converted` status and
`disposal` activity and duration. An optional `label` overrides the name derived from
the artwork filename. A disposal can add `release: { set, seconds, every, from?, height? }`
to shoot a `PARTICLE_SETS` set out in spurts every `every` seconds during the
activity's last `seconds`. `from` is `'front'` (default) or `'back'`, and `height` is
the share of sprite height above the feet (default 0.4). Facing left or right aims the
particles toward that side, using the set's `forwardSpeed`. Every outcome releases
for its final 3 s: `cum` and `pee` spurt forward, `milk` drips in a near-constant
stream from chest height, and `scat` and `bones` drop a few `poo` or `bone` particles
from the backside.
A disposal's optional `toss: { speed, up, bounce }` then throws the finished pile from
the same release point instead of placing it at the predator's feet: `speed` sideways
toward the release side, `up` upward (room pixels per second), keeping `bounce` of its
fall speed on each landing. It falls under `GRAVITY`, only slides over walkable floor,
and lands on the predator's floor line. While airborne `Remains.flight` holds its lift
above the floor and its draw depth. Cum and urine are tossed forward, milk drips with
little push, and scat and bones drop out backward, bones bouncing the most. At least one outcome must have positive weight.
`SIM_OVERRIDES[id].vore.types` replaces
the weights for one character; types left out of it are never used.
An empty or all-zero weight map disables swallowing; directly requesting a random
type from it throws instead of silently choosing oral. Profile construction rejects
unknown type IDs, negative/non-finite weights and invalid capacities. `VoreType` and
`VORE_TYPE_IDS` derive from the table, so a new entry does not require a separate type
union edit.

##### Inside, digesting and remains

1. **Swallowed.** The prey leaves the floor: swallowed agents drop out of `world.agents`,
   their plan and speech bubble end, and a guard escorting a creature lets it go. The
   sprite is no longer drawn, and the prey copies its predator's room, position, facing
   and doorway fade every frame, so they travel together through doors and elevators. The
   `acid` status (a green popup box until it has artwork) drains `acidDps` (2 HP/s) times
   the type's `digestion`.
2. **Struggling.** Prey inside plan from `INSIDE_ACTIONS`, shown as their activity. For
   now there is only *Struggle*: a 3–6 second go with a 4% chance (`escapeChance`) of
   making the predator spit the prey out. Spat-out prey land beside the predator, lose the
   acid, get `scared`, stay dazed for three seconds, and can't be swallowed again for 45 s.
   If all inside actions are disabled, prey wait without attempting an escape.
3. **Digested.** When HP runs out the prey is dead as usual, and the acid is swapped for
   the selected outcome's converted status: `digested`, `cumified`, `urine` or
   `milkified` (irreversible, blocks actions, and replaces the **Dead** popup). The
   weighted outcome is selected once here and kept through absorption and disposal.
4. **Absorbed.** Over `absorbSeconds` (45 s) the predator heals by the prey's max HP times
   `healFraction`, up to its own max. When it ends, the `ABSORPTION_HOOKS` run once and the
   prey becomes **remains**: an agent is `removed` (with everything it carried or stored
   taken from it) and a creature `consumed`, but the profile (`character`: id, name,
   traits) lives on in a `Remains` ([`remains.ts`](../src/lib/sim/remains.ts)) held by the
   predator, along with the original agent or creature (`actor`). The id joins `world.vore.consumed`, so the character doesn't arrive again that
   session and containment failures stop counting it.
5. **Disposed.** After 20–45 s (`disposalDelay`), the predator prioritizes a disposal
   activity. The selected outcome's `disposal` specifies its activity label and duration;
   only completing it drops the pile at the predator's feet
   (`room.remains`) and scatters the prey's items beside it (`room.items`).

Staff and creatures seek an accessible, unoccupied restroom first, then an empty
reachable room, and finally a reachable corner of their current room if no privacy is
available. Living staff and creatures count as witnesses. Mark a room as a restroom with
`"restroom": true` in its `room.json`; room templates pass this setting to their instances.
There are currently no marked restrooms in the facility, so the fallback applies until
one is added. [`remainsDisposal.ts`](../src/lib/sim/remainsDisposal.ts) owns the shared
destination and interruption rules. Staff follow clearance-aware door and elevator
routes; creatures can only use linked doors open far enough to squeeze through
(`CREATURE_TUNING.squeezeOpening`) and do not enter cells for this purpose. Both
reconsider the destination after reaching the next room.

Disposal waits until the predator is free and calm, rather than interrupting a hunt,
escape, fear, escort, or other urgent behavior. Staff and creatures can be interrupted,
including by a witness entering a private room; an interrupted activity starts over.
Security calls and escorts take precedence over a guard's disposal plans. During the
stationary activity, both staff and creatures show a heart and gently shake; the effect
stops when the activity ends or is interrupted. Door and elevator crossings that
cannot be interrupted finish before the guard takes a new call.

A predator that dies or leaves the facility (or a creature that escapes) lets go instead:
living prey are spat out, digested prey finish absorbing at once, and remains drop where
it was. Each step is logged.

Remains artwork is `src/sim_assets/remains/<look>.png`, one file per `look` listed in
`VORE_TYPES`; its weighted look is chosen when digestion finishes.
Images can be any size; they are drawn with their bottom centre on the
pile's floor point and depth-sorted like items. Piles grow with the prey: artwork is
authored for an average-height character (sprite scale 0.85) and `Remains.scale`
resizes it by the prey's `character.scale` relative to that (0.59×–1.41×). The current files are 24×16 placeholders,
and a missing file falls back to a stand-in made from the missing texture.
Piles on the floor are clickable (`Renderer.remainsAt`, pixel-accurate like characters, with
the same white hover outline):
clicking one selects `remains.actor`, pulling up the same file as clicking them alive did
(without `world.interact`, so nothing is woken or revealed).

Swallowed prey stay in the interface: their name tag rides on the predator, with their
status popups; following them follows the predator's camera; and their file shows
**Inside** (who, and which way) while a predator's file lists **Holding**. Once absorbed,
agents and creatures both show the actual remains appearance as their status (for example,
**Bones**, **Scat**, **Cum**, **Urine**, or **Milk**), whether held or dropped. Following continues
through absorption and disposal, tracking whoever holds their remains or the room
whose `remains` list contains their pile.

##### Working with vore in code

- Swallowed agents are not in `world.agents` or any room's list, but `world.everyone()`
  includes them. `world.swallowedIn(room)` returns the prey inside the predators on that
  camera, and `world.vore.active` lists every ingestion. `exposed` (agents and creatures)
  and `Creature.contained`/`onCamera` are false for swallowed prey, so the usual "can be
  targeted" checks already skip them.
- Vore runs from `World.update` (`vore.update(dt)` right after statuses tick, and
  `vore.sync()` once everyone has moved), not from `Agent.update`, which many tests drive
  against stub worlds. Randomness goes through [`random.ts`](../src/lib/sim/random.ts).
- Creature attacks and staff reactions use the shared `exposed` checks, so swallowed
  targets cannot still be attacked or react from inside. Direct agent updates also
  stop while swallowed or removed. Creatures honor action-blocking status effects,
  including only moving for the unblocked portion of a frame when an effect expires.
  Item statuses continue ticking once per frame when items move from a swallowed
  agent's inventory into carried remains and later onto the floor.
- To customize: `VORE_TYPES` (label, weight, weighted `outcomes`, per-type multipliers;
  a new converted status also needs an entry in `STATUS_EFFECTS`),
  `VORE_TUNING` (lifecycle timing, chase speed/re-routing, spit-out offsets/recovery
  and item scattering; exported and mutable for tests and difficulty
  settings), `INSIDE_ACTIONS` (add `{ id, label, weight, duration, escapeChance? }` for more
  things prey can do), `ABSORPTION_HOOKS` (push a listener taking `{ predator, prey, type }`
  for bonus effects such as a slime growing), and `SIM_OVERRIDES[id].vore` (`role`,
  `types`, `anySize` and `capacity` for one character).

#### Breakage Particles

Particle sprites live in [`src/sim_assets/particles/`](../src/sim_assets/particles/).
Each PNG is a whole particle image, not a sprite sheet. Add a reusable set to
`PARTICLE_SETS` in [`particles.ts`](../src/lib/sim/particles.ts): its sprite names omit
`.png`, and its settings control burst count, launch speeds, `spinSpeed` (radians per
second, with a random direction), optional `forwardSpeed` (added toward a burst's
`direction`), gravity, bounce, floor
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
repairing the prop restores its previous on/off state. A missing or fully transparent
expected frame or state displays `missing_texture.png` scaled to the prop's frame,
without changing the prop's capabilities or placement. Entirely absent state rows in
explicit metadata can be added later; partially cropped frames remain an error.
Passage doors and panels have separate, stricter asset validation and still require
their documented frames when loading a facility.

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
If the whole normal row is empty, the placeholder is shown instead. Automatic sheets
do not infer an animation frame count from empty columns.
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

Agents also have a read-only `inventory` of stored items, separate from their hand.
`agent.storeItem()` moves the held item into storage; `agent.retrieveItem(item)` moves
that same stored instance into an empty hand. Both reject transport, dragging,
departure, and removal, just like pickup/drop. `agent.receiveStoredItem(item)` adds a
brand-new item directly to storage. Stored items are not rendered in the agent's hand
and survive room changes, elevator rides, and dragging. Like stats, inventory belongs
to the current agent instance; it is not saved across respawns or page reloads.
There is currently no storage capacity limit.

Every agent starts with a `card_level1` through `card_level5` matching their profile
clearance. Unknown/redacted clearances get level 1. Level 0 gets `card_level0`, and
Admin gets a distinct `card_admin` with unrestricted access and its own artwork.
Level 0 reuses the level-1 artwork until dedicated artwork is available.
The supplied card images use 10x8 crops at (43, 44) inside their 96x96 sheets.
A card opens doors of its own level and below directly from storage or the hand;
no hand slot or consumable is needed. Losing a card immediately removes its permissions,
even during a crossing. Changing a profile does not replace an already-issued card.
Floor preferences remain profile-based. Departure routes require the same cards as
other door crossings; impostor, stuck-open-panel, and broken-door rules still apply.

For extra spawn items, set `startingItems: ['can']` in the character's
`SIM_OVERRIDES` entry in [`roster.ts`](../src/lib/sim/roster.ts), or on a
`SimCharacter` passed to `World.spawn`. The automatic card is always added first;
each spawn creates fresh item instances, including repeated types.

The planner sometimes stashes a held item (weight 0.75) or retrieves a stored
non-card item (weight 0.5) for later use. Cards stay stored unless explicitly retrieved.
Item actions still require the item in hand; a retrieved drink can be consumed normally.
The personnel panel shows stored inventory separately from the held item.

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
  "west": "level-1-pipe-room",
  "north": "level-4-trophy-room",
  "east-2": { "room": "level-1-rec-room", "door": "west-1" }
}
```

The short form (`"west": "level-1-pipe-room"`) comes out of the other room's opposite
door (`east` for `west`, `south` for `north`), or its only door. Use the long form for
numbered doors or anything else. A connection only needs to be written in one of the
two rooms; the way back is added automatically, and the build stops if the two rooms
disagree. Doors without an exit normally lead off camera to the rest of the facility, so
people still arrive and leave through them (as they do through elevators). A
door marked `"cell": true` is an exception, as described below.

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
and, by default, the numbered door artwork. The door and panel are positioned from the nav-map
opening; the optional whole-pixel `offset` moves both, while `panelOffset` moves only
the panel. Set `"big": true` to use a door sheet with 192x192 cells and larger
door crops; the panel remains normal-sized. Panels sit on an approaching character's right: screen-right on north and
side walls, and screen-left on south walls. Side-wall panels follow the wall's slope,
and their sprites are mirrored automatically on east walls. The debug prop editor
does not edit these passage assemblies, but it can break and repair them live
(see [Placing Props and Items With the Editor](#placing-props-and-items-with-the-editor)).

For a north-facing heavy containment cell, configure its blue opening as:

```json
"north-1": { "clearance": 3, "style": "heavy_containment", "cell": true }
```

The style uses `door_heavy_containment.png` and `door_panel_small.png` instead of
the numbered artwork, without changing clearance or door behavior. It supports
north-facing normal-size doors only. The small panel sits to the right, vertically
centered alongside the door. The `cell` flag is independent of the style: an
unlinked cell is not a facility entrance or exit, so staff cannot arrive or depart
through it. Proximity alone never opens a cell door, including from its linked
interior camera. Once linked to an on-camera cell room, authorized staff open it
only while actively crossing that specific passage, such as entering the cell or
escorting a creature home. Its door and panel can still break on intentional use
and be repaired; containment-failure events can still force it open.

For connected rooms, configuring either side creates a matching door on the other
camera and both views share one lock and animation. If both rooms configure it,
their clearance must match, but their size, style, cell designation and offsets
can differ per camera. An automatically created counterpart inherits `big` as
well as clearance, but not the camera-specific style or cell designation.
Remove the entries on both
sides to make the connected passage doorless again. Off-camera passages may also
have doors. Every current facility passage on Levels 0 through 5 has a physical
door configured with that level's clearance and artwork.

A nearby authorized agent (within 40 room pixels of the passage threshold) turns
the panel green and opens the door upward in 0.7 simulation seconds, or 2 seconds
for big doors. Cell doors additionally require the agent's active door-crossing
or explicit player-directed opening task to target that passage; walking past, waiting nearby, or crossing a different
door does not open them or roll breakage. This applies to both views if either
endpoint is marked `cell`. Closing takes the same duration as opening. If either connected
camera uses big artwork, both views share the slower timing. Agents wait
until it is at least half open; anyone authorized inside the doorway keeps it open. If it
closes below halfway mid-crossing, the agent steps back to the threshold, fully visible, and
gives up after 5 seconds without an open door, dropping the trip so they can be
picked up again. Once no authorized opener remains nearby, it holds for 1.5 seconds,
then closes and the panel returns to red. Only a card opens a door, but anyone may
slip through one that is already at least half open, and a door never closes on someone
standing in its doorway (that keeps it open without turning the panel green).
Planned work and departure routes still only count doors the agent's cards open,
except a door at least half open out of the current room. Staff with no card-permitted way
out of their room wait near a door and leave as soon as someone else opens it.
Working panels cast a faint red/green halo over nearby room art, props, and people
after the darkness pass. In dark rooms its radius grows from 12 to 32 room pixels
and its center opacity from 30% to 40%; lit rooms keep the smaller glow.
This visual illumination does not change room darkness or agent behavior.
South-facing doors and their panels draw in front of the room's props and characters
at 35% opacity, so they frame the foreground passage without hiding the room.
Their indicator glow uses the same opacity; other door orientations remain opaque
and behind the room's props and characters.

Each authorized agent approaching a passage rolls the same 1% break chance for
the panel and door independently, once per approach rather than per tick. Both
camera views share damage. A broken door immediately gets stuck closed. A broken
panel goes dark and freezes the door exactly where it was; a door at least half open
then lets anyone through without clearance, while a door less than half open
cannot be crossed. Door damage takes priority if both components break.
Damage logs a warning and shows an exclamation bubble. Runtime damage lasts until
`world.passageDoorFor(door).repair()` or `.repairPanel()` is called; repairs are
independent and do not change room configuration.
Maintenance staff can repair either component from their side without opening or
crossing the damaged door, regardless of its required clearance.

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
Big doors use the same filenames prefixed with `big_`, for example
`big_door_angle_level3.png` and `big_door_angle_level3_east.png`.
Their closed crops are `(52, 28, 92, 138)` for north/south walls and
`(53, 22, 86, 160)` for the supplied west/east artwork; broken crops start 384 pixels lower,
in the third 192px row. They slide at their native size, without scaling down.
The loader checks that every visible pixel in the closed and broken door cells
falls inside the configured crop; update the layout metadata when adding artwork
with different bounds.
Heavy containment doors use a `(18, 20, 60, 61)` crop in each 96px cell. Their
small panels use `(43, 36, 11, 17)` for red and broken frames and
`(43, 38, 11, 17)` for green frames; the loader also checks these panel crops.
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
the Level 0 main entrance. It uses `big_elevator_door.png` and carries up to 10
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

For raised platforms or other deliberately isolated floor sections, set
`"disconnectedFloors": true` in `room.json`. Keep each section green and leave the
gap red or transparent; do not draw a connecting green bridge. Each separate area
must touch its own blue door or pink elevator, and an exit may touch only one area.
Characters stay in the area they enter: walking, seats, items, conversations, and
door/elevator routing cannot cross the gap. Ghosts still ignore floor boundaries.
This describes navigation only; the height difference is drawn in `room.png`.
Without this setting, disconnected green patches remain a validation error.

The build stops with the file and pixel position if a nav map uses an unknown colour,
has floor patches that can't be reached, has an exit that doesn't touch the floor, or
doesn't match the size of `room.png`, and names the problem if an exit points to a
door or room that doesn't exist, passage-door artwork or configuration is invalid,
or an elevator or shaft is set up wrong.
