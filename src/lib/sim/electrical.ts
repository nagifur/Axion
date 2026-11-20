import type { Agent } from './agent.ts';
import { distanceToRect, segmentDistanceToRect, type Point } from './navMap.ts';
import type { Prop } from './prop.ts';
import { chance } from './random.ts';
import { SHOCK_SECONDS } from './statusEffects.ts';
import type { World } from './world.ts';

export const SHOCK_REACH = 10;
export const SHOCK_APPROACH_CHANCE = 0.2;
export const SHOCK_INTERACTION_CHANCE = 0.5;
/** Grace after the normal stun ends; walking past a hazard must not cause a permanent stun. */
export const SHOCK_RECOVERY_SECONDS = 4;

const nextShockAt = new WeakMap<Agent, number>();
const nearbyProps = new WeakMap<Agent, Set<Prop>>();

function exposed(agent: Agent): boolean {
  return !agent.removed && !agent.held && !agent.incapacitated && agent.layer === 'room' && agent.alpha >= 1;
}

/** Called once per interaction attempt, never by a hover/drop preview. */
export function tryElectricalShock(agent: Agent, world: World, prop: Prop): boolean {
  return distanceToRect(agent, prop.impactBounds) <= SHOCK_REACH
    && shock(agent, world, prop, SHOCK_INTERACTION_CHANCE);
}

function shock(agent: Agent, world: World, prop: Prop, probability: number): boolean {
  if (!exposed(agent) || !prop.electric || !prop.broken || !agent.room.props.includes(prop)
    || world.time < (nextShockAt.get(agent) ?? 0) || !chance(probability)) return false;
  if (!agent.statuses.apply('shocked')) return false;
  nextShockAt.set(agent, world.time + SHOCK_SECONDS + SHOCK_RECOVERY_SECONDS);
  world.log(`${agent.character.name} was shocked by the broken ${prop.type.replaceAll('_', ' ')} in the ${agent.room.name}.`, 'warn');
  return true;
}

/** One roll on entering a prop's danger radius, not every frame spent beside it. */
export function checkElectricalApproach(agent: Agent, world: World, from: Point) {
  if (!exposed(agent)) return;
  const previous = nearbyProps.get(agent);
  const nearby = new Set<Prop>();
  let closest: Prop | undefined;
  let closestDistance = Infinity;
  for (const prop of agent.room.props) {
    if (!prop.electric || !prop.broken) continue;
    const area = prop.impactBounds;
    if (distanceToRect(agent, area) <= SHOCK_REACH) nearby.add(prop);
    if (previous?.has(prop) && distanceToRect(from, area) <= SHOCK_REACH) continue;
    const distance = segmentDistanceToRect(from, agent, area);
    if (distance <= SHOCK_REACH && distance < closestDistance) {
      closest = prop;
      closestDistance = distance;
    }
  }
  nearbyProps.set(agent, nearby);
  if (closest) shock(agent, world, closest, SHOCK_APPROACH_CHANCE);
}
