import { performance } from 'node:perf_hooks';
import { loadFacility } from '../src/lib/sim/roomLoader.ts';
import { seededRandom, setRandomSource } from '../src/lib/sim/random.ts';
import { Room } from '../src/lib/sim/room.ts';
import { DEFAULT_STATS } from '../src/lib/sim/stats.ts';
import { World } from '../src/lib/sim/world.ts';

const FACILITY_SCALES = [1, 2, 4];
const STAFF_PER_ROOM = 3.5;
const STEP_SECONDS = 1 / 60;
const WARMUP_STEPS = 1_800;
const MEASURED_STEPS = 1_800;
const SAMPLES = 3;
const SEED = 0xa10f;

function scaledRoomData(source, scale) {
  const maxColumn = Math.max(...source.map((room) => room.map?.col ?? 0)) + 1;
  const copies = [];

  for (let copy = 0; copy < scale; copy++) {
    const roomIds = new Map(source.map((room) => [
      room.id,
      copy === 0 ? room.id : `${room.id}--wing-${copy + 1}`,
    ]));

    for (const original of source) {
      const room = structuredClone(original);
      room.id = roomIds.get(original.id);
      if (copy > 0) {
        room.name = `${room.name} (wing ${copy + 1})`;
        room.camera = `${room.camera} (wing ${copy + 1})`;
      }
      if (room.map) room.map.col += copy * maxColumn;
      room.links = Object.fromEntries(Object.entries(room.links).map(([door, link]) => {
        const target = roomIds.get(link.room);
        if (!target) throw new Error(`Room ${original.id} links to missing room ${link.room}.`);
        return [door, { ...link, room: target }];
      }));
      if (copy > 0 && room.elevator?.shaft) room.elevator.shaft += `-wing-${copy + 1}`;
      copies.push(room);
    }
  }

  return copies;
}

function makeRoster(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `benchmark-${index}`,
    name: `Benchmark ${index}`,
    href: '',
    tint: '#fff',
    scale: 1,
    position: 'Staff',
    species: 'Human',
    accessLevel: '5',
    employeeID: String(index),
    traits: [],
    weight: 1,
    behavior: { speed: 1, napChance: 0, clumsy: false, social: 0.4, ghost: false },
    stats: DEFAULT_STATS,
  }));
}

function percentile(sorted, fraction) {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function measureSample(roomData, scale, sample) {
  const rosterCount = Math.max(1, Math.round(roomData.length * STAFF_PER_ROOM));
  const roster = makeRoster(rosterCount);
  const rooms = roomData.map((data) => new Room(data));
  const world = new World({
    roster,
    rooms,
    now: () => new Date('2026-01-01T12:00:00'),
  });

  setRandomSource(seededRandom(SEED + scale * 100 + sample));
  try {
    world.populate();
    for (let step = 0; step < WARMUP_STEPS; step++) world.update(STEP_SECONDS);

    const timings = new Array(MEASURED_STEPS);
    for (let step = 0; step < MEASURED_STEPS; step++) {
      const start = performance.now();
      world.update(STEP_SECONDS);
      timings[step] = performance.now() - start;
    }
    return {
      roomCount: rooms.length,
      propCount: rooms.reduce((total, room) => total + room.props.length, 0),
      agentCount: world.everyone().length,
      timings,
    };
  } finally {
    setRandomSource(null);
  }
}

const facilityData = await loadFacility();
const results = [];

for (const scale of FACILITY_SCALES) {
  const roomData = scaledRoomData(facilityData, scale);
  const samples = Array.from({ length: SAMPLES }, (_, sample) => measureSample(roomData, scale, sample));
  const timings = samples.flatMap((sample) => sample.timings).sort((a, b) => a - b);
  const mean = timings.reduce((total, value) => total + value, 0) / timings.length;
  const rooms = samples[0].roomCount;
  const agents = samples.reduce((total, sample) => total + sample.agentCount, 0) / samples.length;
  const props = samples[0].propCount;

  results.push({
    scale: `${scale}x`,
    rooms,
    props,
    agents: Math.round(agents),
    meanMs: mean,
    p95Ms: percentile(timings, 0.95),
    updatesPerSecond: 1000 / mean,
    frameBudgetPercent: percentile(timings, 0.95) / (1000 / 60) * 100,
  });
}

console.log('Simulation update benchmark (world.update only; excludes rendering and DOM)');
console.log('Fixed 1/60s timestep; 30s warmup and 30s measured per sample; 3 samples per scale.');
console.table(results.map((result) => ({
  ...result,
  'mean ms/update': result.meanMs.toFixed(3),
  'p95 ms/update': result.p95Ms.toFixed(3),
  'updates/s': result.updatesPerSecond.toFixed(0),
  'p95 of 16.67ms frame': `${result.frameBudgetPercent.toFixed(1)}%`,
})).map(({ meanMs, p95Ms, updatesPerSecond, frameBudgetPercent, ...row }) => row));
