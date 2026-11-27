# Live Monitoring Simulation

How the in-browser facility simulation works, including actor behavior, controls, diagnostics, and extension points.

[`/monitoring`](../../src/pages/monitoring.astro) is a small in-browser simulation of the
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
[stats authoring reference](../../templates/README.md#optional-simulation-stats).
[`stats.ts`](../../src/lib/sim/stats.ts) defines the defaults: HP and stamina 100,
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
not running. At zero they get the [`exhausted`](behavior.md#exhausted) status and move at walking
(agents) or pacing (creatures) speed until it wears off. Use `spendStamina`/`recoverStamina`
from `stats.ts` rather than editing the pool.
Magic, hunger, and thirst don't change yet. HP changes only through events:
creature attacks and swallowing acid lower it, absorbing prey restores it, and zero HP
is fatal (see [Status Effects](behavior.md#status-effects) and [The Vore System](behavior.md#the-vore-system)).
Values last only for that agent or creature instance, not across spawns or reloads.
All three character collections validate optional stat blocks, including
synthetics that do not yet spawn in monitoring.

## Selected-Actor Vitals HUD

Selecting an agent or creature slides a HUD into the feed's top-left corner
([`monitorVitals.ts`](../../src/lib/sim/monitorVitals.ts), styled in
[`monitoring.astro`](../../src/pages/monitoring.astro) under `.monitor-vitals`). It shows the
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
  [polarity](behavior.md#status-effects), the label, and a thin timer for timed effects. Rows
  slide in when an effect starts and out when it ends; an effect reapplied while
  sliding out slides straight back. Effects hidden by `hidesPopups` are skipped here too.
- **Permanent effects** (any `permanent` effect, such as **Dead** or a
  [remains status](behavior.md#remains-statuses) like **Bones**) get their own group above the
  passing ones: a band in the polarity colour, a framed icon, a **Permanent** tag and a
  slow sheen, with no timer. Permanent neutral or positive effects get the same
  treatment in their own polarity colour.
- The HUD ignores pointer input, hides in the prop editor, and turns its animations
  off with the site's animation toggle or `prefers-reduced-motion`.

## Simulation performance benchmark

Run `npm run benchmark:sim` with Node 24 to compare `World.update` at 1x, 2x,
and 4x the checked-in facility size. Each scenario uses 3.5 synthetic staff per
room, a fixed 1/60-second timestep, a 30-second warmup, and three 30-second
measurement samples. The report includes mean and p95 update time, estimated
simulation updates per second, and p95 time as a share of the 16.67 ms 60 Hz
frame budget. It measures simulation updates only, not rendering or browser
frame rate; use it for before/after comparisons rather than as an end-to-end FPS
claim.

## Crash and freeze diagnostics

Open `/monitoring?debug` and use **Copy diagnostics** below the activity log to copy a
JSON report for troubleshooting. Diagnostics are recorded even without debug mode.
If the browser is locked up, open `/monitoring?debug` first, then copy the report: it
includes the previous session's last saved checkpoint as well as the new session. A
read-only text box supports manual copying when clipboard access is denied.

[`monitorDiagnostics.ts`](../../src/lib/sim/monitorDiagnostics.ts) keeps the last 100 entries
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
[`agentDrag.ts`](../../src/lib/sim/agentDrag.ts).

Creatures use the same sprite/tag pickup, camera switching, floor placement and
air-drop physics as agents. Holding a creature pauses its plan and prevents hunts,
staff reactions and capture. Cancelling resumes the original plan. Props, door
panels and conversations are staff-only targets. Moving a creature out of its
assigned cell records a breach; dropping it back home restores containment at
the chosen point. Escorted, transitioning, incapacitated and off-camera creatures
cannot be picked up.

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
The `ElevatorOpening` type in [`room.ts`](../../src/lib/sim/room.ts) describes
room geometry; the `Elevator` class in [`elevator.ts`](../../src/lib/sim/elevator.ts)
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

### Data-driven behavior

Simulation definitions are TypeScript data tables, separate from per-actor state. The
main extension points are:

| Definition | Purpose |
| --- | --- |
| `DEFAULT_BEHAVIOR`, `BEHAVIOR_RULES` in [`roster.ts`](../../src/lib/sim/roster.ts) | Baseline staff behavior and ordered trait/species matches. Matching rules merge `values`; later matches win. Behavior fields include speed, nap chance, clumsiness, sociability, ghosting and `meow` (the idle meow weight; cats/felines get `1`). |
| `SIM_OVERRIDES` in [`roster.ts`](../../src/lib/sim/roster.ts) | Per-profile behavior, starting items, vore settings and trespass responses, keyed by profile slug. Behavior overrides apply after trait rules. |
| `AGENT_ACTIVITIES` in [`planning.ts`](../../src/lib/sim/planning.ts) | Named ordinary activities with `weight(context)` and `build(context)`. Add or replace entries without editing the planner. |
| `CREATURE_TUNING` in [`creature.ts`](../../src/lib/sim/creature.ts) | Movement, attack damage/reach/timing, roaming and door behavior. Existing containment-class chance tables remain independently configurable. |
| `VORE_PROFILE_RULES`, `VORE_STAFF_RULES`, `VORE_TYPES`, `VORE_TUNING` in [`vore.ts`](../../src/lib/sim/vore.ts) | Size/capacity defaults, staff restrictions, type definitions and lifecycle tuning. |

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
Edit [`schedule.ts`](../../src/lib/sim/schedule.ts) to change `DEFAULT_SCHEDULE`:
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

[`generateNpc`](../../src/lib/sim/npc.ts) takes a session-unique badge number and a
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
switched-on light (including emergency lights), otherwise 1. Unlit underground
cameras are dimmed by 55%, including props and people. Agents in pure darkness
receive the visible, negative `darkness` status. Its definition in `STATUS_EFFECTS`
adds a 1.2% trip chance per walking second on top of the clumsy trait's 0.6% and
sets `avoidsRoom`, making agents more likely to move rooms or leave without the usual
minimum stay. Walking and planning read these status modifiers, not room darkness.
Impostors still do not trip. Clearance rules and motion-sensor lighting are unchanged.
An active light item in the agent's hand prevents this debuff and all of its
penalties; stored or nearby dropped lights do not. Personal lights do not change
room darkness or help other actors. The debuff synchronizes with room changes,
item transfers, burnout and lighting updates; it is absent on dead, removed,
swallowed and inside-elevator agents.

Every lit light on mains power also has a small chance per second (`LIGHT_FLICKER`
in [`prop.ts`](../../src/lib/sim/prop.ts)) to flicker like an old fluorescent tube:
for 0.5–2 seconds it strobes between its on and off artwork in irregular
0.04–0.16 second phases. When a room's last bright light is mid-dark-phase the
camera dims through `room.visualDarkness`, but the effect is visual only —
gameplay `darkness`, trips, and planning never see it, and emergency lights
never flicker.

| File | Purpose |
| --- | --- |
| [`src/sim_assets/`](../../src/sim_assets/) | Pixel art: `characters/`, `props/` (shared), `remains/` (what predators leave behind), and one folder per room in `rooms/`. |
| [`src/lib/sim/sprites.ts`](../../src/lib/sim/sprites.ts) | What is inside each shared sprite: character frames, prop seats and blocked areas. |
| [`src/lib/sim/prop.ts`](../../src/lib/sim/prop.ts) | Placed props and their live state (on/off, broken). |
| [`src/lib/sim/statusEffects.ts`](../../src/lib/sim/statusEffects.ts) | Shared status definitions, active effects, durations, and lifecycle hooks. |
| [`src/lib/sim/electrical.ts`](../../src/lib/sim/electrical.ts) | Broken electrical prop exposure, shock chances, and recovery grace. |
| [`src/lib/sim/navMap.ts`](../../src/lib/sim/navMap.ts) | Reads and checks nav maps at build time. |
| [`src/lib/sim/roomLoader.ts`](../../src/lib/sim/roomLoader.ts) | Loads every room folder at build time and connects their doors. |
| [`src/lib/sim/room.ts`](../../src/lib/sim/room.ts) | Room geometry: walkable floor, exits, seats, and path finding. |
| [`src/lib/sim/roster.ts`](../../src/lib/sim/roster.ts) | Profile → character conversion, trait rules, and per-character overrides. |
| [`src/lib/sim/schedule.ts`](../../src/lib/sim/schedule.ts) | Editable daily routine, breaks, and per-character schedule overrides. |
| [`src/lib/sim/agent.ts`](../../src/lib/sim/agent.ts) | The `Agent` class: position, stats, carried item, personal inventory, and its task queue. |
| [`src/lib/sim/planning.ts`](../../src/lib/sim/planning.ts) | Decision making: which task an idle agent picks next (`planNext`). |
| [`src/lib/sim/security.ts`](../../src/lib/sim/security.ts) | Elevator watch, breach response, and escorts back to assigned cells. |
| [`src/lib/sim/trespass.ts`](../../src/lib/sim/trespass.ts) | Reef's and guards' trespass response and staff escorts between floors. |
| [`src/lib/sim/tasks.ts`](../../src/lib/sim/tasks.ts) | Basic tasks: walking, waiting, napping, falling, tripping, and prop breakage. |
| [`src/lib/sim/repairs.ts`](../../src/lib/sim/repairs.ts) | Maintenance staff noticing, claiming, and repairing damaged equipment. |
| [`src/lib/sim/itemTasks.ts`](../../src/lib/sim/itemTasks.ts) | Item tasks: using, picking up, setting down, and getting items from dispensers. |
| [`src/lib/sim/conversation.ts`](../../src/lib/sim/conversation.ts) | Chats between two agents: meeting points, turns, and speech bubbles. |
| [`src/lib/sim/vore.ts`](../../src/lib/sim/vore.ts) | Vore rules and tuning: roles from `vorePreference`, who may swallow whom, the ways of swallowing, and what prey do inside. |
| [`src/lib/sim/voreSystem.ts`](../../src/lib/sim/voreSystem.ts) | `world.vore`: hunts, swallowing, acid, absorption, spitting out, and disposing of remains. |
| [`src/lib/sim/voreTasks.ts`](../../src/lib/sim/voreTasks.ts) | The `stalk` task an agent runs while closing in on prey. |
| [`src/lib/sim/remains.ts`](../../src/lib/sim/remains.ts) | `Remains`: what is left of absorbed prey until its predator drops it on the floor. |
| [`src/lib/sim/transport.ts`](../../src/lib/sim/transport.ts) | Leaving and entering rooms through doors and elevators, and leaving the facility. |
| [`src/lib/sim/world.ts`](../../src/lib/sim/world.ts) | All rooms and people: arrivals, departures, and the per-frame update. |
| [`src/lib/sim/routing.ts`](../../src/lib/sim/routing.ts) | Which rooms an agent may visit and which door or floor leads toward work or the exit. |
| [`src/lib/sim/elevator.ts`](../../src/lib/sim/elevator.ts) | Elevator cars: requests, door timing, and passenger layout. |
| [`src/lib/sim/passages.ts`](../../src/lib/sim/passages.ts) | Live state of passage doors between rooms (locks, panels, who is passing). |
| [`src/lib/sim/random.ts`](../../src/lib/sim/random.ts) | The single source of randomness (`random`, `chance`, `pick`, ...). Use it instead of `Math.random`; `setRandomSource` swaps in a seeded generator. |
| [`src/lib/sim/facilityEvents.ts`](../../src/lib/sim/facilityEvents.ts) | Facility event registry, timed impostor arrivals and A1 announcements, plus achievement definitions. |
| [`src/lib/sim/earthquake.ts`](../../src/lib/sim/earthquake.ts) | Earthquake tuning and effects across all rooms. |
| [`src/lib/sim/eventState.ts`](../../src/lib/sim/eventState.ts) | Shared floor/facility event lifecycle and display shake. |
| [`src/lib/sim/levelEvents.ts`](../../src/lib/sim/levelEvents.ts) | Floor event definitions and floor-specific simulation rules. |
| [`src/lib/sim/levelState.ts`](../../src/lib/sim/levelState.ts) | Per-floor state and event lifecycle. |
| [`src/lib/sim/render.ts`](../../src/lib/sim/render.ts) | Asset loading and drawing a camera feed onto a canvas. |
| [`src/lib/sim/monitor.ts`](../../src/lib/sim/monitor.ts) | Boots the monitoring page: cameras, drag and drop, and the frame loop. Its panels live in `monitorFile.ts` (personnel file), `monitorVitals.ts` (selected-actor vitals HUD), `monitorTags.ts` (name tags), `monitorDebug.ts` and `monitorEditor.ts` (`?debug` tools), and `monitorProgress.ts` (saved progress). |

Add `?debug` to the URL to show buttons that trigger events, speed up time, and open
the prop editor (see [Placing Props and Items With the Editor](assets.md#placing-props-and-items-with-the-editor)).
The **Selected** row applies or removes any agent/creature status effect on the selected
actor (permanent ones are marked but can still be removed; **Dead** kills and **Bones**
turns them into a pile). Removing **Dead** restores full HP; removing a remains form
restores the original actor, who stays dead unless **Dead** is removed too. The row
also has a **Hurt −20 HP** button, for previewing the
[vitals HUD](#selected-actor-vitals-hud) and [remains statuses](behavior.md#remains-statuses).
Achievements and the last camera watched are stored in the visitor's browser (`localStorage`).
