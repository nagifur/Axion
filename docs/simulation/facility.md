# Facility Layout and Events

Reference for room assets, floor events, camera instances, and navigation maps.

## Character Sprite Sheet

[`characters/char_spritesheet.png`](../../src/sim_assets/characters/char_spritesheet.png)
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
Frame coordinates and timing are defined in [`sprites.ts`](../../src/lib/sim/sprites.ts).
The renderer crops each frame before scaling it, so neighboring animation rows cannot
bleed into characters or their highlight outlines at fractional sizes.
Expected character cells that are transparent or outside the image use
[`missing_texture.png`](../../src/sim_assets/missing_texture.png) at the same size and anchor.
Unused cells outside the listed animations are ignored.

## Floor Events and Variables

Register floor-specific rules in `LEVEL_DEFINITIONS` in [`levelEvents.ts`](../../src/lib/sim/levelEvents.ts),
keyed by the numeric `level` from `room.json`. Every room on that floor reads the same
state through `world.level(room.level)`. Even floors without rules have their own
state; floors with no loaded rooms return `undefined`. Variables are
booleans, numbers, strings, or `null`, and each world gets a fresh copy of the
defaults. Floor state is not saved on reload.

Facility-wide events are registered in `FACILITY_EVENTS` in
[`facilityEvents.ts`](../../src/lib/sim/facilityEvents.ts) and run through `world.events`.
They use the same lifecycle as floor events, extracted into
[`eventState.ts`](../../src/lib/sim/eventState.ts), but receive `(world, world, dt)`
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

### Containment failure

Open `/monitoring?debug`, switch to the floor you want, and use the **Event**
picker with **Trigger event** or **End event**. Floor entries target the current
camera's floor, even if no agents are on camera. Entries marked **facility-wide**
target the entire facility regardless of the selected camera.

### Earthquake

Select **Earthquake (facility-wide)** in that picker, or call
`world.events.startEvent('earthquake')`. It lasts **20 simulation seconds** by
default; a second duration argument overrides this, and
`world.events.stopEvent('earthquake')` ends it early. Like floor events, it has no
automatic random trigger. `hasEvent`, `activeEvents`, and `availableEvents` work
on `world.events` too. Pause freezes its duration, debris emission and display shake.

All earthquake tuning lives in `EARTHQUAKE` in
[`earthquake.ts`](../../src/lib/sim/earthquake.ts):

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

The `rock` set in [`particles.ts`](../../src/lib/sim/particles.ts) uses the three
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

### Blackout and backup power

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

## Incident Feed

The **Incidents** panel on `/monitoring` groups related simulation steps (escape →
dispatch → capture → recontainment) into one entry with camera links. Active
incidents stay pinned at the top and drive the status banner; resolved ones keep
their outcome and duration. Routine lines still go to the **Activity log**.
Incidents live in memory only and reset on reload.

Everything shown is data in [`incidents.ts`](../../src/lib/sim/incidents.ts):

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
happen. Rendering lives in [`monitorIncidents.ts`](../../src/lib/sim/monitorIncidents.ts).

## Adding a Room

Each room is a folder in [`src/sim_assets/rooms/`](../../src/sim_assets/rooms/).
Name room folders with lowercase kebab-case; the folder name is the room ID used
by `exits` in `room.json`, so update those references when renaming a room:

```text
rooms/level-1-offices/
|-- room.png        # The room art. Leave the elevator opening transparent.
|-- nav_map.png      # Same size as room.png, painted with the colours below.
|-- room.json       # Name, camera label, and where props are placed.
`-- prototype.png   # Optional mockup; not used by the site.
```

## Reusing a Room as Multiple Cameras

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

Residents [pace, watch, and rest](../../src/lib/sim/creature.ts) on their cell's
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
through the actual doors and elevators to its reserved cell, even from a floor
without cells. The creature shares the guard's car position, is off camera during
the ride, and steps out with the guard. Capturing a creature grants its guard
temporary access up to the home floor, retained through delivery and the return
to post; the guard's normal badge is unchanged. The guard waits rather than
crossing a blocked passage. `World.recontain` completes delivery inside the cell
and the guard returns to the elevator. Disguised residents and off-camera
escapees are not dispatch targets. A loose or escorted shapeshifter is not
chosen for impostor events.

Creatures can randomly attack staff or security in the same room, including visitors
to their cell. `ATTACK_CHANCE` in [`creature.ts`](../../src/lib/sim/creature.ts) gives
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
([`creatureReactions.ts`](../../src/lib/sim/creatureReactions.ts)) once per sighting;
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

[`creature_spritesheet.png`](../../src/sim_assets/creatures/creature_spritesheet.png)
uses the same 96×96, bottom-centred frame grid as the staff sheet. Empty movement
or back-facing frames use the available idle art (side poses are mirrored for
left). Filling in the corresponding walk or idle cells enables them automatically.
[`security_spritesheet.png`](../../src/sim_assets/characters/security_spritesheet.png)
uses the same grid and idle fallback for missing poses.

## Painting a Navigation Map

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

Images in [`src/sim_assets/props/`](../../src/sim_assets/props/) can be placed by file
name (`plant.png` → `"type": "plant"`) as plain decoration, except for the reserved
elevator and passage-door artwork. To give a prop seats or floor that people walk
around, add it to `PROP_TYPES` in [`sprites.ts`](../../src/lib/sim/sprites.ts).
