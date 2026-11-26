import type { Agent, Task } from './agent.ts';
import type { Facing, Point, Room } from './room.ts';
import type { World } from './world.ts';
import type { Item } from './item.ts';
import { accessCardLevel, itemActions } from './item.ts';
import { scheduleFor } from './schedule.ts';
import { pick, random, range, weightedPick } from './random.ts';
import { rest, wait, walkTo } from './tasks.ts';
import { getFromDispenser, itemPickupPoint, pickUp, retrieveItem, setDownItem, storeItem, useItem } from './itemTasks.ts';
import { startConversation } from './conversation.ts';
import { headToNextRoom, leaveFacility, rideElevatorOut } from './transport.ts';
import { canSlipOut, isStranded, wanderDoors, wanderFloors } from './routing.ts';
import { planRepair } from './repairs.ts';
import { planDisposalResponse, planSecurity } from './security.ts';
import { planEscortedStaff, planStaffEscort } from './trespass.ts';
import { DEFAULT_BEHAVIOR } from './roster.ts';
import { planRemainsDisposal } from './remainsDisposal.ts';

// Decision making: what an idle agent does next.

export interface ActivityOption {
  weight: number;
  build(): Task[] | null;
}

export type AgentActivity = {
  id: string;
} & ({
  weight(context: PlanningContext): number;
  build(context: PlanningContext): Task[] | null;
} | {
  /** Expand dynamic choices (e.g. item actions) into the same weighted draw. */
  options(context: PlanningContext): readonly ActivityOption[];
});

export type PlanningContext = ReturnType<typeof planningContext>;

function meow(agent: Agent, world: World) {
  agent.say('Meow!', 1.3);
  world.log(`${agent.character.name} meowed in the ${agent.room.name}.`, 'muted');
}

function planVoluntaryTask(agent: Agent, world: World): Task[] | undefined {
  return (agent.security ? undefined : planRemainsDisposal(agent, world)) ??
    (agent.repairTarget ? undefined : planRepair(agent, world));
}

/** Only security calls can preempt an interruptible disposal plan. */
export function planInterrupt(agent: Agent, world: World, current?: Task): Task[] | undefined {
  if (!agent.interruptible) return undefined;
  if (agent.disposingRemains) {
    const call = planDisposalResponse(agent, world);
    return call && [call];
  }
  return current ? planVoluntaryTask(agent, world) : undefined;
}

/** Picks the next thing an agent does once their plan runs out. */
export function planNext(agent: Agent, world: World): Task[] {
  agent.spot = undefined;
  agent.curiousAbout = undefined;
  if (agent.staffEscort) {
    return agent.staffEscort.leader === agent
      ? planStaffEscort(agent, world, agent.staffEscort) : planEscortedStaff(agent, agent.staffEscort);
  }
  if (agent.security) return planSecurity(agent, world, agent.security);
  const voluntary = planVoluntaryTask(agent, world);
  if (voluntary) return voluntary;

  const context = planningContext(agent, world);
  const options = AGENT_ACTIVITIES.flatMap((activity): readonly ActivityOption[] =>
    'options' in activity ? activity.options(context)
      : [{ weight: activity.weight(context), build: () => activity.build(context) }]);
  return weightedPick(options)?.build() ?? [wait(2, 'Standing around')];
}

/** Expensive room/route queries are shared by all activity definitions for this decision. */
function planningContext(agent: Agent, world: World) {
  const { room } = agent;
  const { darkness } = room;
  const stayed = world.time - agent.arrivedAt;
  const inRoom = world.time - agent.enteredRoomAt;
  const crowded = world.presentCount() - world.targetPopulation();
  const period = scheduleFor(agent.character, world.now());
  const working = period === 'work' && !agent.impostor;
  const workRooms = working ? new Set(world.workRooms(agent.character)) : new Set<Room>();
  const workStep = working ? world.stepTowardWork(agent.character, room, agent) : undefined;
  const wandering = working ? 0.15 : period === 'free' ? 2 : 1;

  const benchSpot = world.freeSpot(room, 'bench', agent);
  const chairSpot = world.freeSpot(room, 'chair', agent);
  const partner = world.findChatPartner(agent);
  const linked = wanderDoors(world, agent);
  const floors = wanderFloors(world, agent);
  const dispensers = agent.item ? [] : room.props
    .filter((prop) => prop.dispensing)
    .map((prop) => ({ prop, stand: prop.standPoint(room) }))
    .filter(({ stand }) => room.canReach(agent, stand, agent.ghost));
  // Loose items nobody else is already heading for.
  const claimed = new Set(room.items.length ? world.agentsIn(room).map((other) => other.curiousAbout) : []);
  const looseItems = agent.item || agent.impostor ? [] : room.items
    .filter((item) => !claimed.has(item))
    .map((item) => ({ item, stand: itemPickupPoint(room, item) }))
    .filter((found): found is { item: Item; stand: Point } => !!found.stand && room.canReach(agent, found.stand, agent.ghost));
  // Staff without a card for any way out hang around a door and slip out once someone opens it.
  const stranded = isStranded(world, agent);
  const slipOut = stranded && canSlipOut(world, agent);
  const watchedDoors = stranded ? [...room.linkedDoors, ...room.outerDoors]
    .filter((door) => room.canReach(agent, door.inside, agent.ghost) && world.passageDoorFor(door) && !world.passageDoorFor(door)!.broken) : [];
  const storedItems = agent.item || agent.impostor ? [] : agent.inventory
    .filter((item) => accessCardLevel(item) === undefined);

  return {
    agent, world, room, darkness, stayed, inRoom, crowded, period, working, workRooms, workStep, wandering,
    benchSpot, chairSpot, partner, linked, floors, dispensers, looseItems, slipOut, watchedDoors, storedItems,
  };
}

/** Weighted, ordinary activities, considered only after higher-priority plans. */
export const AGENT_ACTIVITIES: AgentActivity[] = [
  {
    id: 'go-to-work',
    weight: ({ workStep, darkness }) => workStep && !darkness ? 12 : 0,
    build: ({ workStep, world }) => !workStep ? null
      : 'inside' in workStep ? [headToNextRoom(world, workStep)] : [rideElevatorOut(workStep)],
  },
  {
    id: 'slip-out',
    weight: ({ slipOut }) => slipOut ? 40 : 0,
    build: ({ agent, world }) => leaveFacility(agent, world),
  },
  {
    id: 'wait-for-door',
    weight: ({ slipOut, watchedDoors }) => !slipOut && watchedDoors.length ? 15 : 0,
    build: ({ room, watchedDoors }) => {
      const door = pick(watchedDoors);
      const near = room.nearestWalkable({
        x: door.inside.x + Math.round(range(-16, 16)), y: door.inside.y + Math.round(range(-16, 16)),
      });
      return [
        walkTo(near, 'Waiting for someone to open the door'),
        wait(range(1.5, 3), 'Waiting for someone to open the door'),
      ];
    },
  },
  {
    id: 'walk',
    weight: ({ working }) => working ? 1 : 3,
    build: ({ room, agent, working }) => [
      walkTo(room.randomFloorPoint(random, agent.ghost ? undefined : agent), working ? 'Checking the work area' : 'Walking'),
      wait(range(2, 6), working ? 'Checking the work area' : 'Looking around', pick<Facing>(['front', 'left', 'right'])),
    ],
  },
  {
    id: 'stand',
    weight: ({ working, workStep }) => working ? (workStep ? 1 : 10) : 1,
    build: ({ working, period }) => [wait(working ? range(30, 60) : range(3, 6),
      working ? 'Working' : period === 'break' ? 'Taking a break' : period === 'lunch' ? 'Having lunch' : 'Standing around', 'front')],
  },
  {
    id: 'rest-on-bench',
    weight: ({ benchSpot, working }) => benchSpot ? (working ? 0.5 : 2) : 0,
    build: ({ agent, benchSpot, world, period }) => {
      if (!benchSpot) return null;
      agent.spot = benchSpot;
      return [walkTo(benchSpot, 'Heading to the bench'), rest(agent, benchSpot, world, period)];
    },
  },
  {
    id: 'meow',
    weight: ({ agent }) => agent.character.behavior.meow ?? DEFAULT_BEHAVIOR.meow,
    build: ({ agent, world }) => {
      meow(agent, world);
      return [wait(range(1, 3), 'Meowing', 'front')];
    },
  },
  {
    id: 'rest-on-chair',
    weight: ({ chairSpot, working, workStep }) => chairSpot ? (working ? (workStep ? 1 : 8) : 2) : 0,
    build: ({ agent, chairSpot, world, period }) => {
      if (!chairSpot) return null;
      agent.spot = chairSpot;
      return [walkTo(chairSpot, 'Grabbing a chair'), rest(agent, chairSpot, world, period)];
    },
  },
  {
    id: 'chat',
    weight: ({ partner, agent, working }) => partner ? agent.character.behavior.social * (working ? 0.6 : 3) : 0,
    build: ({ agent, partner, world }) => partner ? startConversation(agent, partner, world) : null,
  },
  {
    id: 'wander-room',
    weight: ({ linked, inRoom, darkness, wandering }) =>
      linked.length && (inRoom > 25 || darkness > 0) ? 1.2 * wandering + darkness * 4 : 0,
    build: ({ world, linked }) => [headToNextRoom(world, pick(linked))],
  },
  {
    id: 'wander-floor',
    weight: ({ floors, inRoom, darkness, wandering }) =>
      floors.length && (inRoom > 25 || darkness > 0) ? 0.8 * wandering + darkness * 3 : 0,
    build: ({ floors, workRooms, working, darkness }) => {
      const preferred = floors.filter((floor) => workRooms.has(floor));
      return [rideElevatorOut(pick(working && preferred.length && !darkness ? preferred : floors))];
    },
  },
  {
    id: 'use-item',
    options: ({ agent }) => itemActions(agent.item).map((action) => ({
      weight: action.weight, build: () => [useItem(action)],
    })),
  },
  {
    id: 'store-item',
    weight: ({ agent }) => agent.item && !agent.leaving ? 0.75 : 0,
    build: ({ agent }) => agent.item ? [storeItem(agent.item)] : null,
  },
  {
    id: 'retrieve-item',
    weight: ({ storedItems }) => storedItems.length ? 0.5 : 0,
    build: ({ storedItems }) => [retrieveItem(pick(storedItems))],
  },
  {
    id: 'set-down-item',
    weight: ({ agent }) => agent.item && !agent.leaving ? 0.25 : 0,
    build: ({ agent, room }) => {
      const item = agent.item;
      if (!item) return null;
      return [
        walkTo(room.randomFloorPoint(random, agent.ghost ? undefined : agent), `Finding a place for the ${item.type.replaceAll('_', ' ')}`),
        setDownItem(item),
      ];
    },
  },
  {
    id: 'pick-up-item',
    weight: ({ looseItems, working }) => looseItems.length ? (working ? 1.5 : 4) : 0,
    build: ({ agent, looseItems }) => {
      const { item, stand } = pick(looseItems);
      agent.curiousAbout = item;
      agent.say('?', 1.5);
      return [walkTo(stand, `Checking out a ${item.type.replaceAll('_', ' ')}`), pickUp(item)];
    },
  },
  {
    id: 'get-from-dispenser',
    weight: ({ dispensers, working }) => dispensers.length ? (working ? 0.2 : 1.2) : 0,
    build: ({ dispensers }) => {
      const { prop, stand } = pick(dispensers);
      return [walkTo(stand, `Heading to the ${prop.type.replaceAll('_', ' ')}`), getFromDispenser(prop)];
    },
  },
  {
    id: 'leave',
    weight: ({ agent, stayed, darkness, working, crowded }) => !agent.impostor && (stayed > 35 || darkness > 0)
      ? (working ? 0.05 : 0.5) + Math.max(0, crowded) * 2 + darkness * 2 : 0,
    build: ({ agent, world }) => leaveFacility(agent, world),
  },
];
