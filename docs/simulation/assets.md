# Simulation Assets and Editing

Reference for simulation artwork, items, the in-browser editor, doors, and elevators.

## Breakage Particles

Particle sprites live in [`src/sim_assets/particles/`](../../src/sim_assets/particles/).
Each PNG is a whole particle image, not a sprite sheet. Add a reusable set to
`PARTICLE_SETS` in [`particles.ts`](../../src/lib/sim/particles.ts): its sprite names omit
`.png`, and its settings control burst count, launch speeds, `spinSpeed` (radians per
second, with a random direction), optional `forwardSpeed` (added toward a burst's
`direction`), gravity, bounce, floor
friction, lifetime, fade, and landing scatter. Link any number of prop types to that
set in `PROP_TYPES` in [`sprites.ts`](../../src/lib/sim/sprites.ts):

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

## Prop Sprite Sheets

The shared props use **96 × 96 pixel cells**, with frames running left to right.
`PROP_SPRITES` in [`sprites.ts`](../../src/lib/sim/sprites.ts) declares the artwork-sized
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

## Carryable Items

Images in [`src/sim_assets/items/`](../../src/sim_assets/items/) are separate from props.
Place loose items in a room's `room.json`:

```json
"items": [
  { "type": "can", "x": 200, "y": 140 }
]
```

Coordinates are the artwork crop's top-left corner, like props. Items do not block
walking or provide seats. `ITEM_SPRITES` in [`sprites.ts`](../../src/lib/sim/sprites.ts)
defines crops (the can uses a 6x10 crop inside its 96x96 image); unlisted images use
the whole image as a single still frame. Item assets use `item:<type>` keys, so an
item and a prop may share a file name.

Each [`Agent`](../../src/lib/sim/agent.ts) has a read-only `item` slot, initially `null`.
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
`SIM_OVERRIDES` entry in [`roster.ts`](../../src/lib/sim/roster.ts), or on a
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

A carried item can unlock extra things to do. `ITEM_TYPES` in
[`item.ts`](../../src/lib/sim/item.ts) holds each type's readable behavior definition.
Its `actions` list supplies planner options while the item is held:

```ts
can: {
  actions: [{ id: 'drink', activity: 'Drinking a can', seconds: 4, weight: 2, consumes: true, done: 'finished a can' }],
},
```

The action runs as an uninterruptible `useItem` task for `seconds`. With
`consumes: true` the item is used up when it finishes: `agent.consumeItem()` empties the
slot and the item is destroyed rather than dropped. `done` adds a log line
("Ana finished a can in the Offices."). If the item leaves the agent's hand before
the action finishes, the action stops without using it up.

### Personal light items

The glowstick is available in the debug editor's **Add an item** palette; there is
no dispenser yet. Place it on reachable floor and an agent can pick it up.
It starts unlit. The one-second **Cracking a glowstick** action activates it without
consuming it; agents prioritize activation in darkness, including maintenance and
guards when they can interrupt their current task. Elsewhere it is an ordinary
weighted item action.

```ts
glowstick: {
  actions: [{
    id: 'activate', activity: 'Cracking a glowstick', seconds: 1, weight: 2,
    activates: true, done: 'activated a glowstick',
  }],
  light: { color: '#73ff8a', radius: 32, requiresActivation: true, lifetime: 180 },
},
```

`light.color` and `light.radius` control the halo, drawn above camera dimming and
emergency tint. Held halos follow the same scaled, mirrored hand anchors as the
item sprite; dropped active items glow at their floor position. Only held active
lights prevent the holder's `darkness` status. Stored lights do not render.

`lifetime` is simulation seconds from activation: the glowstick lasts **three
minutes**, with the same timer continuing through storage, dropping, room changes,
and elevator travel. Pause freezes it; debug speed accelerates it. At zero it stops
glowing and protecting its holder, stays as a spent item, and cannot be reactivated.
Runtime activation/burnout is not included in room exports and resets on reload.

Future light items (e.g. a flashlight) use the same `light` data, with no item-ID
checks in planning or rendering. Omit `requiresActivation` for an immediately
active light; omit `lifetime` for unlimited operation. An activation action uses
`activates: true`; it is only offered before first activation. Add a crop in
`ITEM_SPRITES` and a PNG in `src/sim_assets/items/` to expose a new type in the palette.
Types without an `ITEM_TYPES` entry remain plain carryable items.

### Dispensers (vending machines)

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

## Placing Props and Items With the Editor

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

## Connecting Rooms

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

## Adding Physical Doors

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

## Connecting Floors With Elevators

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
first camera shown is `INITIAL_ROOM` in [`monitoring.astro`](../../src/pages/monitoring.astro).

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
