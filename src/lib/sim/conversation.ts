import type { Agent, Task } from './agent.ts';
import type { Point } from './room.ts';
import type { World } from './world.ts';
import { range } from './random.ts';
import { walkTo } from './tasks.ts';

/** Seconds each side of a conversation speaks before the other answers. */
const TURN_SECONDS = 1.6;
/** How far apart, in room pixels, two agents stand while chatting. */
const CHAT_DISTANCE = 24;
/** A listener gives up if the initiator never arrives. */
const LISTEN_TIMEOUT_SECONDS = 20;

export interface Conversation {
  initiator: Agent;
  partner: Agent;
  started: boolean;
  ended: boolean;
  elapsed: number;
}

export function isSpeaking(conversation: Conversation, agent: Agent) {
  const turn = Math.floor(conversation.elapsed / TURN_SECONDS) % 2;
  return conversation.started && !conversation.ended && ((turn === 0) === (agent === conversation.initiator));
}

function chatBubble(conversation: Conversation, agent: Agent) {
  agent.bubble = isSpeaking(conversation, agent) ? '…' : null;
}

function talk(conversation: Conversation, seconds: number): Task {
  const { partner } = conversation;
  return {
    activity: `Chatting with ${partner.character.name}`,
    interruptible: false,
    start(agent) {
      conversation.started = true;
      agent.face(partner);
    },
    update(agent, _world, dt) {
      conversation.elapsed += dt;
      chatBubble(conversation, agent);
      return conversation.elapsed >= seconds || partner.removed || conversation.ended;
    },
    end(agent) {
      conversation.ended = true;
      agent.conversation = undefined;
      agent.bubble = null;
    },
  };
}

function listen(conversation: Conversation): Task {
  const { initiator } = conversation;
  let waited = 0;
  return {
    activity: `Chatting with ${initiator.character.name}`,
    interruptible: false,
    update(agent, _world, dt) {
      waited += dt;
      agent.face(initiator);
      chatBubble(conversation, agent);
      return conversation.ended || initiator.removed || (!conversation.started && waited > LISTEN_TIMEOUT_SECONDS);
    },
    end(agent) {
      conversation.ended = true;
      agent.conversation = undefined;
      agent.bubble = null;
    },
  };
}

export function conversationPoint(agent: Point, partner: Agent): Point | undefined {
  const offset = agent.x < partner.x ? -CHAT_DISTANCE : CHAT_DISTANCE;
  const spots = [{ x: partner.x + offset, y: partner.y }, { x: partner.x - offset, y: partner.y }];
  return spots.find((spot) => partner.room.isWalkable(spot));
}

export function startConversation(agent: Agent, partner: Agent, world: World, immediate = false): Task[] | null {
  if (agent.incapacitated || partner.incapacitated) return null;
  const meet = conversationPoint(agent, partner);
  if (!meet) return null;

  const conversation: Conversation = { initiator: agent, partner, started: false, ended: false, elapsed: 0 };
  partner.setPlan(world, [listen(conversation)]);
  const tasks = immediate
    ? [talk(conversation, range(6, 12))]
    : [walkTo(meet, `Going to talk to ${partner.character.name}`), talk(conversation, range(6, 12))];
  if (immediate) agent.setPlan(world, tasks);
  agent.conversation = conversation;
  partner.conversation = conversation;
  return tasks;
}
