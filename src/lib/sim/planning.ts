import type { Agent, Task } from './agent.ts';
import type { Facing, Point, Room } from './room.ts';
import type { World } from './world.ts';
import type { Item } from './item.ts';
import { accessCardLevel, itemActions } from './item.ts';
import { scheduleFor } from './schedule.ts';
import { pick, random, range } from './random.ts';
import { rest, wait, walkTo } from './tasks.ts';
import { getFromDispenser, itemPickupPoint, pickUp, retrieveItem, setDownItem, storeItem, useItem } from './itemTasks.ts';
import { startConversation } from './conversation.ts';
import { headToNextRoom, leaveFacility, rideElevatorOut } from './transport.ts';
import { canSlipOut, isStranded, wanderDoors, wanderFloors } from './routing.ts';
import { planRepair } from './repairs.ts';
import { planSecurity } from './security.ts';

// Decision making: what an idle agent does next.

interface Option {
  weight: number;
  build: () => Task[] | null;
}

function meow(agent: Agent, world: World) {
  agent.say('Meow!', 1.3);
  world.log(`${agent.character.name} meowed in the ${agent.room.name}.`, 'muted');
}

/** Picks the next thing an agent does once their plan runs out. */
export function planNext(agent: Agent, world: World): Task[] {
  agent.spot = undefined;
  agent.curiousAbout = undefined;
  if (agent.security) return planSecurity(agent, world, agent.security);
  const repairs = planRepair(agent, world);
  if (repairs) return repairs;
  const { behavior } = agent.character;
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

  const options: Option[] = [
    {
      weight: workStep && !darkness ? 12 : 0,
      build: () => {
        if (!workStep) return null;
        return 'inside' in workStep ? [headToNextRoom(world, workStep)] : [rideElevatorOut(workStep)];
      },
    },
    {
      weight: slipOut ? 40 : 0,
      build: () => leaveFacility(agent, world),
    },
    {
      weight: !slipOut && watchedDoors.length ? 15 : 0,
      build: () => {
        const door = pick(watchedDoors);
        const near = room.nearestWalkable({ x: door.inside.x + Math.round(range(-16, 16)), y: door.inside.y + Math.round(range(-16, 16)) });
        return [
          walkTo(near, 'Waiting for someone to open the door'),
          wait(range(1.5, 3), 'Waiting for someone to open the door'),
        ];
      },
    },
    {
      weight: working ? 1 : 3,
      build: () => [
        walkTo(room.randomFloorPoint(random, agent.ghost ? undefined : agent), working ? 'Checking the work area' : 'Walking'),
        wait(range(2, 6), working ? 'Checking the work area' : 'Looking around', pick<Facing>(['front', 'left', 'right'])),
      ],
    },
    {
      weight: working ? (workStep ? 1 : 10) : 1,
      build: () => [wait(working ? range(30, 60) : range(3, 6),
        working ? 'Working' : period === 'break' ? 'Taking a break' : period === 'lunch' ? 'Having lunch' : 'Standing around', 'front')],
    },
    {
      weight: benchSpot ? (working ? 0.5 : 2) : 0,
      build: () => {
        agent.spot = benchSpot!;
        return [walkTo(benchSpot!, 'Heading to the bench'), rest(agent, benchSpot!, world, period)];
      },
    },
    {
      weight: ['feline', 'cat'].includes(agent.character.species.trim().toLowerCase()) ? 1 : 0.1,
      build: () => {
        meow(agent, world);
        return [wait(range(1, 3), 'Meowing', 'front')];
      },
    },
    {
      weight: chairSpot ? (working ? (workStep ? 1 : 8) : 2) : 0,
      build: () => {
        agent.spot = chairSpot!;
        return [walkTo(chairSpot!, 'Grabbing a chair'), rest(agent, chairSpot!, world, period)];
      },
    },
    {
      weight: partner ? behavior.social * (working ? 0.6 : 3) : 0,
      build: () => (partner ? startConversation(agent, partner, world) : null),
    },
    {
      // Wander over to a neighbouring room on camera.
      weight: linked.length && (inRoom > 25 || darkness > 0) ? 1.2 * wandering + darkness * 4 : 0,
      build: () => {
        return [headToNextRoom(world, pick(linked))];
      },
    },
    {
      // Take the elevator to another floor on camera.
      weight: floors.length && (inRoom > 25 || darkness > 0) ? 0.8 * wandering + darkness * 3 : 0,
      build: () => {
        const preferred = floors.filter((floor) => workRooms.has(floor));
        return [rideElevatorOut(pick(working && preferred.length && !darkness ? preferred : floors))];
      },
    },
    ...itemActions(agent.item).map((action): Option => ({
      weight: action.weight,
      build: () => [useItem(action)],
    })),
    {
      weight: agent.item && !agent.leaving ? 0.75 : 0,
      build: () => [storeItem(agent.item!)],
    },
    {
      weight: storedItems.length ? 0.5 : 0,
      build: () => [retrieveItem(pick(storedItems))],
    },
    {
      // Occasionally set down a carried item somewhere on the room's open floor.
      weight: agent.item && !agent.leaving ? 0.25 : 0,
      build: () => {
        const item = agent.item!;
        return [
          walkTo(room.randomFloorPoint(random, agent.ghost ? undefined : agent), `Finding a place for the ${item.type.replaceAll('_', ' ')}`),
          setDownItem(item),
        ];
      },
    },
    {
      // Curious about something lying on the floor: go over and pick it up.
      weight: looseItems.length ? (working ? 1.5 : 4) : 0,
      build: () => {
        const { item, stand } = pick(looseItems);
        agent.curiousAbout = item;
        agent.say('?', 1.5);
        return [walkTo(stand, `Checking out a ${item.type.replaceAll('_', ' ')}`), pickUp(item)];
      },
    },
    {
      // Grab something from a vending machine; drinking it is then one of the item's actions.
      weight: dispensers.length ? (working ? 0.2 : 1.2) : 0,
      build: () => {
        const { prop, stand } = pick(dispensers);
        return [walkTo(stand, `Heading to the ${prop.type.replaceAll('_', ' ')}`), getFromDispenser(prop)];
      },
    },
    {
      // Impostors stay until the event director sends them off.
      weight: !agent.impostor && (stayed > 35 || darkness > 0)
        ? (working ? 0.05 : 0.5) + Math.max(0, crowded) * 2 + darkness * 2 : 0,
      build: () => leaveFacility(agent, world),
    },
  ];

  const total = options.reduce((sum, option) => sum + option.weight, 0);
  let roll = random() * total;
  for (const option of options) {
    roll -= option.weight;
    if (option.weight > 0 && roll <= 0) {
      const tasks = option.build();
      if (tasks) return tasks;
      break;
    }
  }
  return [wait(2, 'Standing around')];
}
