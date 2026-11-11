// Reads a room's nav map: a pixel-exact copy of the room image painted with flat colours that
// tell the simulation where feet can go. Runs at build time. Takes raw RGBA pixels instead of a
// file so it stays free of image libraries and can be unit tested.

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

type NavKind = 'floor' | 'door' | 'elevator' | 'blocked';

/** Colours a nav map may use. Fully transparent pixels are blocked too. */
export const NAV_COLORS: { kind: NavKind; name: string; rgb: [number, number, number] }[] = [
  { kind: 'floor', name: 'green', rgb: [5, 255, 0] },
  { kind: 'door', name: 'blue', rgb: [0, 116, 255] },
  { kind: 'elevator', name: 'pink', rgb: [255, 0, 231] },
  { kind: 'blocked', name: 'red', rgb: [255, 0, 0] },
];
// Per-channel slack so a hand-picked pure colour (e.g. #00FF00 for green) still counts.
const COLOR_TOLERANCE = 40;
/** How many of an exit's lowest pixel rows count as its "ground" (where feet go through). */
const EXIT_BASE_ROWS = 6;

/**
 * Which wall a door is in, worked out from where the floor touches it:
 * side walls touch the floor sideways, the back wall (north) has floor below it,
 * and the front edge (south) has floor above it.
 */
export type DoorSide = 'west' | 'east' | 'north' | 'south';
export const DOOR_SIDES: DoorSide[] = ['west', 'east', 'north', 'south'];

export interface NavExit {
  /** Doors: their side ("west", "north", ...), numbered when a side has several ("west-1"). Elevators: "elevator". */
  id: string;
  kind: 'door' | 'elevator';
  /** Wall the door is in (doors only). */
  side?: DoorSide;
  bounds: Rect;
  /** Average position of the floor pixels touching the exit. */
  threshold: Point;
  /** Average position of the exit's lowest pixels, where feet end up when walking through it. */
  base: Point;
}

export interface NavMapData {
  width: number;
  height: number;
  /** Walkable floor per row, as flat [start, end) pairs: floor[y] = [x0, x1, x0, x1, ...]. */
  floor: number[][];
  exits: NavExit[];
}

export class NavMapError extends Error {}

const hex = (rgb: ArrayLike<number>) =>
  `#${Array.from(rgb).slice(0, 3).map((value) => value.toString(16).padStart(2, '0')).join('').toUpperCase()}`;

function classify(pixels: ArrayLike<number>, index: number, x: number, y: number, file: string): NavKind {
  const alpha = pixels[index + 3];
  if (alpha === 0) return 'blocked';
  if (alpha !== 255) {
    throw new NavMapError(`${file}: semi-transparent pixel at (${x}, ${y}). Paint the nav map at 100% opacity with anti-aliasing off.`);
  }
  const match = NAV_COLORS.find(({ rgb }) => rgb.every((value, channel) => Math.abs(pixels[index + channel] - value) <= COLOR_TOLERANCE));
  if (match) return match.kind;

  const allowed = NAV_COLORS.map(({ name, rgb }) => `${name} ${hex(rgb)}`).join(', ');
  const found = hex([pixels[index], pixels[index + 1], pixels[index + 2]]);
  throw new NavMapError(`${file}: unexpected colour ${found} at (${x}, ${y}). Allowed: ${allowed}, or transparent.`);
}

/** Groups same-kind pixels that touch (up/down/left/right) into separate areas. */
function regions(kinds: NavKind[], width: number, height: number, kind: NavKind): number[][] {
  const seen = new Uint8Array(kinds.length);
  const found: number[][] = [];
  for (let start = 0; start < kinds.length; start++) {
    if (seen[start] || kinds[start] !== kind) continue;
    const region: number[] = [];
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const index = stack.pop()!;
      region.push(index);
      const x = index % width;
      const y = (index - x) / width;
      const neighbours = [
        x > 0 ? index - 1 : -1,
        x < width - 1 ? index + 1 : -1,
        y > 0 ? index - width : -1,
        y < height - 1 ? index + width : -1,
      ];
      for (const next of neighbours) {
        if (next >= 0 && !seen[next] && kinds[next] === kind) {
          seen[next] = 1;
          stack.push(next);
        }
      }
    }
    found.push(region);
  }
  return found;
}

function average(points: Point[]): Point {
  const sum = points.reduce((total, point) => ({ x: total.x + point.x, y: total.y + point.y }), { x: 0, y: 0 });
  return { x: Math.round(sum.x / points.length), y: Math.round(sum.y / points.length) };
}

export function parseNavMap(pixels: ArrayLike<number>, width: number, height: number, file = 'navMap.png'): NavMapData {
  if (pixels.length !== width * height * 4) {
    throw new NavMapError(`${file}: expected ${width}×${height} RGBA pixels.`);
  }

  const kinds: NavKind[] = new Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      kinds[index] = classify(pixels, index * 4, x, y, file);
    }
  }

  const floorAreas = regions(kinds, width, height, 'floor');
  if (!floorAreas.length) throw new NavMapError(`${file}: no green floor painted.`);
  if (floorAreas.length > 1) {
    const stray = floorAreas.sort((a, b) => b.length - a.length)[1][0];
    throw new NavMapError(
      `${file}: the floor is split into ${floorAreas.length} separate areas, so some of it can't be reached. ` +
      `Look for stray green near (${stray % width}, ${Math.floor(stray / width)}).`,
    );
  }

  const floor: number[][] = [];
  for (let y = 0; y < height; y++) {
    const spans: number[] = [];
    for (let x = 0; x < width; x++) {
      if (kinds[y * width + x] !== 'floor') continue;
      const start = x;
      while (x < width && kinds[y * width + x] === 'floor') x++;
      spans.push(start, x);
    }
    floor.push(spans);
  }

  const exits: NavExit[] = [];
  for (const kind of ['door', 'elevator'] as const) {
    for (const region of regions(kinds, width, height, kind)) {
      const points = region.map((index) => ({ x: index % width, y: Math.floor(index / width) }));
      const xs = points.map((point) => point.x);
      const ys = points.map((point) => point.y);
      const bounds = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs) + 1, h: Math.max(...ys) - Math.min(...ys) + 1 };

      const contact = new Map<number, Point>();
      // How much floor touches the exit from each direction.
      const touch = { left: 0, right: 0, above: 0, below: 0 };
      const isFloor = (nx: number, ny: number) => nx >= 0 && ny >= 0 && nx < width && ny < height && kinds[ny * width + nx] === 'floor';
      for (const { x, y } of points) {
        for (const [nx, ny, from] of [[x - 1, y, 'left'], [x + 1, y, 'right'], [x, y - 1, 'above'], [x, y + 1, 'below']] as const) {
          if (!isFloor(nx, ny)) continue;
          contact.set(ny * width + nx, { x: nx, y: ny });
          touch[from]++;
        }
      }
      if (!contact.size) {
        throw new NavMapError(
          `${file}: the ${kind} at (${bounds.x}, ${bounds.y}) doesn't touch the green floor, so nobody can walk through it.`,
        );
      }

      // Side-wall doors on the slanted walls touch the floor sideways about as much as from below.
      const sideways = Math.max(touch.left, touch.right);
      const side: DoorSide = sideways * 2 >= Math.max(touch.above, touch.below)
        ? (touch.right >= touch.left ? 'west' : 'east')
        : (touch.above > touch.below ? 'south' : 'north');

      const baseY = bounds.y + bounds.h - EXIT_BASE_ROWS;
      exits.push({
        id: kind,
        kind,
        side: kind === 'door' ? side : undefined,
        bounds,
        threshold: average([...contact.values()]),
        base: average(points.filter((point) => point.y >= baseY)),
      });
    }
  }

  const elevators = exits.filter((exit) => exit.kind === 'elevator');
  if (elevators.length > 1) throw new NavMapError(`${file}: only one elevator per room is supported (found ${elevators.length}).`);

  // Name doors by their wall; number them left to right if a wall has several.
  const doors = exits.filter((exit) => exit.kind === 'door').sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y);
  for (const door of doors) {
    const sameSide = doors.filter((other) => other.side === door.side);
    door.id = sameSide.length > 1 ? `${door.side}-${sameSide.indexOf(door) + 1}` : door.side!;
  }

  return { width, height, floor, exits: [...doors, ...elevators] };
}
