# Simulation State and Creature Behavior

Reference for props, status effects, damage, vore, and remains in the simulation.

## Prop State

While the simulation runs, every placed prop is a `Prop` object
([`prop.ts`](../../src/lib/sim/prop.ts)) with state that can change. What a prop can do comes
from its `PROP_TYPES` entry, or automatically detected power-off and broken artwork:

| Flag | Meaning |
| --- | --- |
| `switchable` | Can be switched on or off manually, including through the editor. |
| `electric` | Electrical equipment: emits recurring sparks while broken, even when switched off. Defaults to false; lights and vending machines opt in. This does not enable switching or breakage by itself. |
| `automaticPowerOff` | Opts a switchable prop into occupancy-controlled power: on when someone enters, off after the room has been empty for `LIGHTS_OFF_SECONDS` in [`room.ts`](../../src/lib/sim/room.ts). Defaults to false; only lights enable it currently. Set `automaticPowerOff: true` in the prop's `PROP_TYPES` entry to opt in another type. |
| `breakable` | Can break. Nobody picks a seat on a broken prop, and anyone sitting on it or walking to it gives up. |
| `impactArea` | Optional artwork-relative rectangle used to measure distance from a tripping agent; defaults to the whole frame and is mirrored for flipped props. |
| `dispenses` | Item type agents can get from the prop while it works and, if switchable, is on (see [Dispensers](assets.md#dispensers-vending-machines)). |
| `breakParticles` | One or more particle sets and optional artwork-relative emission area to use when the prop breaks (see [Breakage Particles](assets.md#breakage-particles)). |

`room.json` can set how a prop starts. Only props whose type allows it may use these:

```json
{ "type": "light", "x": 83, "y": 34, "on": false },
{ "type": "chair", "x": 297, "y": 105, "broken": true }
```

Code changes state with `prop.setOn()`, `prop.break()` and `prop.repair()`.

Breakable props have a 1% chance to break per use (`PROP_BREAK_CHANCE` in
[`prop.ts`](../../src/lib/sim/prop.ts)), shared by autonomous and drag-and-drop interactions.
The roll happens when seated use starts, when a valid dispenser attempt finishes,
or when a manual switch/inspection starts, never on every simulation tick or preview.
When an agent trips or lands after a fall, there is also a 10% chance to break the
nearest intact breakable prop whose impact area is within 12 room pixels of their
feet (`TRIP_PROP_BREAK_CHANCE` and `TRIP_PROP_REACH` in [`tasks.ts`](../../src/lib/sim/tasks.ts)).
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
(`REPAIR_SECONDS` in [`repairs.ts`](../../src/lib/sim/repairs.ts)). Each component is
reserved while approached or repaired, including across both camera views of a
passage; cancellation or removal releases the claim. Repairs stop if the target is
removed, already fixed, or no longer within reach. They preserve power settings
and exported starting state. Impostors do not repair equipment.

## Status Effects

Agents, creatures, props and items each have a `statuses` collection from
[`statusEffects.ts`](../../src/lib/sim/statusEffects.ts). Physical passage doors use
`statuses` for the door and `panelStatuses` for its independently repairable panel.
`broken` applies only to breakable props, doors and panels.
The existing `broken`/`panelBroken` properties and break/repair methods read and
change that same collection, not a second damage flag. Applying it through the
status API also triggers the usual break particles and door/panel state transitions.
Power is still separate; repairing damage never changes a prop's power setting.
Starting damage from `room.json` does not emit runtime break particles.
Status definitions can also supply `tripChancePerSecond` and `avoidsRoom`.
Walking adds active trip modifiers to the clumsy trait's base risk, and ordinary
planning uses `avoidsRoom` for room/elevator/departure preferences. The environmental
`darkness` debuff uses both; its icon appears in name tags and the vitals HUD.

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
colour; the [vitals HUD](monitoring.md#selected-actor-vitals-hud) draws a +, − or ring sign in that
colour. Most built-in effects are `negative`, while `napping` is `neutral`. A definition can also provide:

- `duration`: positive, finite simulation seconds; omit for permanent effects.
- `permanent`: prevents automatic expiry and duration overrides, but allows explicit
  removal and clearing. The vitals HUD shows these as **Permanent** effects.
- `replaces`: effect ids that applying this one removes, for stages
  that supersede earlier ones: `absorbing` replaces `acid`, remains forms replace both,
  and `dead`/`acid` clear `napping`.
- `remains: { look }`: makes it a [remains status](#remains-statuses); whoever has it
  becomes that pile.
- `blocksActions`: pauses an agent's or creature's current task, movement, and autonomous
  reactions without cancelling its plan or releasing reservations. Multiple blockers use
  the longest remaining duration; only the unblocked portion of an expiry frame advances the task.
- `wakeable`: marks an effect that can be cleared by waking or redirecting the actor
  (camera ping, drag-and-drop, or assigning a new plan via `setPlan`). Wakeable
  action-blockers pause autonomous activity without incapacitating the actor against
  dragging or player-initiated conversations.
- `activity: { label, priority }`: overrides the actor's reported activity while active;
  higher priority wins when multiple effects set one (`Dead` > `Shocked` > `Napping`).
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
(`shownStatuses` applies it); `absorbing` and the remains statuses use it to replace **Dead**.

Use `entity.statuses.apply(id, seconds)` to override a definition's duration.
Only one instance of an effect can exist per target: reapplying a timed effect
resets its remaining duration without stacking or rerunning `onApply`. Reapplying
an already-permanent effect is a no-op. `apply` returns false for an ineligible
target or an already-permanent effect, and true for additions or timed refreshes.
Unknown effect IDs and invalid durations/timesteps throw explanatory errors.
`get(id)` returns a snapshot or `undefined`; a snapshot's `duration` is the length of
the current timed instance (including overrides and refreshes), or `null` when permanent.
`has(id)` checks presence;
`remove(id)` returns whether it removed anything; `clear()` removes all effects,
including permanent ones. Removal does not automatically undo an effect's gameplay
consequences; restoration belongs in its `onRemove` hook.

HP reaching zero or below immediately applies the permanent `dead` effect to
staff, security agents, and creatures. HP stays at zero; later healing cannot
revive them. The `dead` status can be explicitly removed, including through DEBUG
**Remove status**, which restores full HP. Dead actors
remain visible with a permanent **Dead** popup using
`dead.svg` (a white skull fitted to the icon area, with a red border and dark-red
background), and a frozen idle frame until death sprites are added. They cannot
move, run tasks, react, escape, or be captured. Agent task/conversation resources
are released on the next update (including held agents and elevator riders);
escorts release dead creatures immediately. Death is not a facility departure.
Swallowed prey take their own effects (`acid`, then `absorbing`, then a remains status); see
[The Vore System](#the-vore-system). Applying `dead` (for example from the debug panel)
kills just as running out of HP does.

`World.update` ticks statuses once per simulation frame, before movement and task
planning, including creatures, held agents, off-camera elevator riders, and loose, carried,
stored or remains-held items. Linked doors are deduplicated across camera views. Effects use
simulation time, so pause and speed controls apply automatically. A final update
is capped to the remaining lifetime before expiry; hooks may safely remove or
refresh effects. Effects added inside a collection's update hook first tick on
that collection's next update. Removed agents and consumed items stop ticking.
Runtime effects are not saved to placement exports or `room.json`; existing
`on` and `broken` starting-state/editor formats are unchanged.

### Napping

`napping` is a neutral, wakeable, agent-only status effect (`NAP_SECONDS = 20` by
default in [`statusEffects.ts`](../../src/lib/sim/statusEffects.ts), or 25–50 seconds
when dozing off during seated `rest` in [`tasks.ts`](../../src/lib/sim/tasks.ts)).
It sets `blocksActions: true`, `wakeable: true`, and `activity: { label: 'Napping', priority: 20 }`,
and displays a blue-bordered `zZ` popup using
[`napping.svg`](../../src/sim_assets/icons/napping.svg) in name tags and the vitals HUD.
While active, agents pause movement, tasks, repairs, hunting, disposal, earthquake tripping,
and autonomous chats or reactions, while preserving their sitting pose if seated. Unlike
incapacitating effects (`dead`, `shocked`), napping agents remain draggable and can be woken
by a camera click (`rude-awakening`), by dragging them or dropping a coworker onto them,
or by any event that replaces their plan (such as a broken seat, creature attack, escort,
or being swallowed). `dead` and `acid` also clear `napping` directly.

### Electrical Shock

`shocked` is an agent-only effect lasting two simulation seconds (`SHOCK_SECONDS`
in [`statusEffects.ts`](../../src/lib/sim/statusEffects.ts)). It pauses movement,
planning, task progress and item actions, and makes the agent unavailable for
dragging or new conversations. The personnel file shows **Shocked**, and existing
idle artwork, shaking and a yellow-bordered popup using
[`shocked.svg`](../../src/sim_assets/icons/shocked.svg) provide feedback. Its border
and optional background are configured in the effect's `popup` definition.
The popup does not overwrite speech bubbles, and coexists with `napping`.
The same task resumes afterward, including a maintenance repair and its claim.
Shock does not currently damage HP or spread to other agents/items.

[`electrical.ts`](../../src/lib/sim/electrical.ts) controls exposure:

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
[`electrical.ts`](../../src/lib/sim/electrical.ts). Use
`agent.statuses.apply('shocked')` for scripted shocks; normal electrical exposure
also logs a warning and applies the recovery grace.

### Scared

`scared` is an agent-only effect lasting ten simulation seconds (`SCARED_SECONDS`).
It shows a white-bordered popup with
[`scared.svg`](../../src/sim_assets/icons/scared.svg) (white artwork) and a brief
shake. Unlike shock, it doesn't block actions: frightened staff are busy running
away. Staff get it when they see a loose creature, are startled while watching
one, or get snapped at while trying to pet one (see the creature section above).
Use `agent.statuses.apply('scared')` for scripted scares.

### Exhausted

`exhausted` applies to agents and creatures whose stamina hits zero while running, and
lasts five simulation seconds (`EXHAUSTED_SECONDS`). While it is active, `spendStamina`
refuses, so they can't run or dash; stamina keeps regenerating meanwhile. It shows a
green popup with [`exhausted.svg`](../../src/sim_assets/icons/exhausted.svg) and doesn't
block actions. Use `statuses.apply('exhausted')` to tire someone out from a script.

## The Vore System

Predators swallow other characters whole. [`vore.ts`](../../src/lib/sim/vore.ts) holds the
rules (who may swallow whom, the ways of doing it, what prey do inside) and
[`voreSystem.ts`](../../src/lib/sim/voreSystem.ts) runs everything that follows through one
`VoreSystem` per world, `world.vore`. It is driven by the `vorePreference` of personnel
and entities, so staff, security guards, and creatures all take part. Each agent and
creature owns a `VoreState` (`actor.vore`), shared by composition like `LiveStats`.

### Roles and sizes

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
described in the [security section](monitoring.md#live-monitoring-simulation).
This is configured as `SIM_OVERRIDES.reef.trespassResponse` (`swallowChance: 0.1`,
`sizeRatio: 1`), not a character-ID branch in the AI. The same policy can be assigned
to other staff; a zero chance makes them always escort. Disguises never inherit it.

### Hunting and swallowing

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
after it: agents run the `stalk` task ([`voreTasks.ts`](../../src/lib/sim/voreTasks.ts)),
creatures a `swallow` plan. Both chase faster than walking speed, re-route as the target
moves, and give up after `huntTimeout` (12 s) or once the target is no longer eligible.
Within `reach` (14 room pixels) they call `world.vore.swallow(predator, prey, type)`, which
scripts can call directly too; it returns false, changing nothing, when the rules don't
allow it. The swallower then waits `cooldown` (30–60 s) before hunting again.

### Ways of swallowing

Each swallow uses one of four ways, picked by weight from the predator's profile.
`VORE_TYPES` is the table to extend with each way's own quirks:

| Type | Label | Weight | Remains status (chance) | Disposal activity |
| --- | --- | --- | --- | --- |
| `oral` | Oral vore | 6 | `bones` (50%), `scat` (50%) | Defecating (12 s) |
| `cock` | Cock vore | 1 | `cum` (95%), `urine` (5%) | Jerking Off (20 s) or Urinating (12 s) |
| `anal` | Anal vore | 1 | `bones` (50%), `scat` (50%) | Defecating (12 s) |
| `breast` | Breast vore | 1 | `milk` (100%) | Milking themselves (12 s) |

Each type also has `digestion`, `escape` and `absorption` multipliers (all 1 for now) on
the acid damage, spit-out odds and absorption time. Each `outcomes` entry specifies its
relative `weight` (5 and 95 mean 5% and 95%), the `remains` status the prey ends up as,
and its `disposal` activity and duration. The remains status supplies the pile's artwork
and name (see [Remains statuses](#remains-statuses)). A disposal can add `release: { set, seconds, every, from?, height? }`
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

### Inside, digesting and remains

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
3. **Digested.** When HP runs out the prey is dead as usual. The weighted outcome is
   selected once here and kept through absorption and disposal, and the acid is replaced
   by the `absorbing` status (**Being absorbed**: blocks actions, replaces the **Dead**
   popup), applied for the absorption's length.
4. **Absorbed.** The `absorbing` status is the stage's clock: as it runs down over
   `absorbSeconds` (45 s, divided by the type's `absorption`) the predator heals by the prey's
   max HP times `healFraction`, up to its own max. When it runs out the prey takes the
   outcome's remains status (for example `bones`), the `ABSORPTION_HOOKS` run once, and the
   prey becomes **remains**: an agent is `removed` (with everything it carried or stored
   taken from it) and a creature `consumed`, but the profile (`character`: id, name,
   traits) lives on in a `Remains` ([`remains.ts`](../../src/lib/sim/remains.ts)) held by the
   predator, along with the original agent or creature (`actor`). The id joins `world.vore.consumed`, so the character doesn't arrive again while
   in this form and containment failures stop counting it.
5. **Disposed.** After 20–45 s (`disposalDelay`), the predator prioritizes a disposal
   activity. The selected outcome's `disposal` specifies its activity label and duration;
   only completing it drops the pile at the predator's feet
   (`room.remains`) and scatters the prey's items beside it (`room.items`).

Staff and creatures seek an accessible, unoccupied restroom first, then an empty
reachable room, and finally a reachable corner of their current room if no privacy is
available. Living staff and creatures count as witnesses. Mark a room as a restroom with
`"restroom": true` in its `room.json`; room templates pass this setting to their instances.
There are currently no marked restrooms in the facility, so the fallback applies until
one is added. [`remainsDisposal.ts`](../../src/lib/sim/remainsDisposal.ts) owns the shared
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

### Remains statuses

The stages are statuses (`acid` → `absorbing` → a remains form), and the statuses lead.
A remains form is a permanent, negative `STATUS_EFFECTS` entry with a
`remains: { look }` field: `bones`, `scat`, `urine` (artwork `pee`), `cum` and `milk`,
made with the `remainsForm(...)` helper in
[`statusEffects.ts`](../../src/lib/sim/statusEffects.ts). Applying one kills the target (it
applies `dead`), replaces `acid`/`absorbing`, and on the next update `VoreSystem` makes the
target *be* that pile:

- **Swallowed prey** finish at once inside their predator, which then disposes of the
  pile as usual. `outcomeFor(type, form)` gives the disposal: the swallowing type's own
  outcome for that form, else any type's, else `FALLBACK_DISPOSAL`.
- **Anyone on a floor** collapses where they stand: the pile lands in their room with
  their belongings beside it, they let out anything they had swallowed first, and a guard's
  post is re-staffed. Agents riding an elevator turn when they arrive.

Either way they are retired exactly like absorbed prey (removed or consumed) and keep
the remains status, which the file, name tag and vitals HUD show. Removing the form
status removes the pile and restores the original actor at the pile or its carrier.
Items still held in the pile return to the actor's inventory; items already scattered
stay on the floor. The `dead` status is independent and must also be removed to
restore full HP and allow the actor to act; either status can be removed first.
Applying `absorbing` to living prey digests them on the spot; removing it mid-absorption
completes the absorption (the predator gets the rest of the healing). Shapeshifters in
disguise can't be turned, and nobody becomes two piles. To add a form, add a
`remainsForm(...)` entry and its artwork, then reference it from a `VORE_TYPES` outcome
(or just apply it).

Remains artwork is `src/sim_assets/remains/<look>.png`, one file per remains status `look`;
the same image is that status's popup icon. The weighted outcome is chosen when digestion finishes.
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

### Working with vore in code

- Swallowed agents are not in `world.agents` or any room's list, but `world.everyone()`
  includes them. `world.swallowedIn(room)` returns the prey inside the predators on that
  camera, and `world.vore.active` lists every ingestion. `exposed` (agents and creatures)
  and `Creature.contained`/`onCamera` are false for swallowed prey, so the usual "can be
  targeted" checks already skip them.
- Vore runs from `World.update` (`vore.update(dt)` right after statuses tick, and
  `vore.sync()` once everyone has moved), not from `Agent.update`, which many tests drive
  against stub worlds. Randomness goes through [`random.ts`](../../src/lib/sim/random.ts).
- Creature attacks and staff reactions use the shared `exposed` checks, so swallowed
  targets cannot still be attacked or react from inside. Direct agent updates also
  stop while swallowed or removed. Creatures honor action-blocking status effects,
  including only moving for the unblocked portion of a frame when an effect expires.
  Item statuses continue ticking once per frame when items move from a swallowed
  agent's inventory into carried remains and later onto the floor.
- To customize: `VORE_TYPES` (label, weight, weighted `outcomes`, per-type multipliers;
  a new remains form also needs a `remainsForm(...)` entry in `STATUS_EFFECTS`),
  `VORE_TUNING` (lifecycle timing, chase speed/re-routing, spit-out offsets/recovery
  and item scattering; exported and mutable for tests and difficulty
  settings), `INSIDE_ACTIONS` (add `{ id, label, weight, duration, escapeChance? }` for more
  things prey can do), `ABSORPTION_HOOKS` (push a listener taking `{ predator, prey, type }`
  for bonus effects such as a slime growing), and `SIM_OVERRIDES[id].vore` (`role`,
  `types`, `anySize` and `capacity` for one character).
