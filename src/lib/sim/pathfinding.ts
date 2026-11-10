import type { Point } from './navMap';

const SQRT2 = Math.SQRT2;
const NEIGHBOURS = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, SQRT2], [1, -1, SQRT2], [-1, 1, SQRT2], [-1, -1, SQRT2],
] as const;

/** Min-heap of cell indices. Each entry keeps the priority it was pushed with. */
class Heap {
  private items: number[] = [];
  private keys: number[] = [];

  get size() {
    return this.items.length;
  }

  push(item: number, key: number) {
    const { items, keys } = this;
    let i = items.length;
    items.push(item);
    keys.push(key);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (keys[parent] <= key) break;
      items[i] = items[parent];
      keys[i] = keys[parent];
      i = parent;
    }
    items[i] = item;
    keys[i] = key;
  }

  pop(): number {
    const { items, keys } = this;
    const top = items[0];
    const lastItem = items.pop()!;
    const lastKey = keys.pop()!;
    if (!items.length) return top;
    // Sift the last entry down from the root.
    let i = 0;
    for (;;) {
      const left = i * 2 + 1;
      const right = left + 1;
      let child = -1;
      if (left < items.length) child = left;
      if (right < items.length && keys[right] < keys[left]) child = right;
      if (child < 0 || keys[child] >= lastKey) break;
      items[i] = items[child];
      keys[i] = keys[child];
      i = child;
    }
    items[i] = lastItem;
    keys[i] = lastKey;
    return top;
  }
}

/** Coarse walkability grid over a room, with A* path finding between points. */
export class NavGrid {
  readonly cols: number;
  readonly rows: number;
  readonly cell: number;
  private readonly open: Uint8Array;

  constructor(width: number, height: number, cell: number, isOpen: (point: Point) => boolean) {
    this.cell = cell;
    this.cols = Math.ceil(width / cell);
    this.rows = Math.ceil(height / cell);
    this.open = new Uint8Array(this.cols * this.rows);
    for (let index = 0; index < this.open.length; index++) {
      this.open[index] = isOpen(this.center(index)) ? 1 : 0;
    }
  }

  center(index: number): Point {
    const col = index % this.cols;
    const row = (index - col) / this.cols;
    return { x: col * this.cell + (this.cell >> 1), y: row * this.cell + (this.cell >> 1) };
  }

  openCells(): number[] {
    const cells: number[] = [];
    this.open.forEach((open, index) => { if (open) cells.push(index); });
    return cells;
  }

  /** Closest open cell to a point, searching outward ring by ring. Returns -1 if there are none. */
  nearest(point: Point): number {
    const col = Math.min(this.cols - 1, Math.max(0, Math.floor(point.x / this.cell)));
    const row = Math.min(this.rows - 1, Math.max(0, Math.floor(point.y / this.cell)));
    const maxRadius = Math.max(this.cols, this.rows);
    for (let radius = 0; radius < maxRadius; radius++) {
      let best = -1;
      let bestDistance = Infinity;
      for (let r = row - radius; r <= row + radius; r++) {
        for (let c = col - radius; c <= col + radius; c++) {
          const onRing = Math.abs(r - row) === radius || Math.abs(c - col) === radius;
          if (!onRing || r < 0 || c < 0 || r >= this.rows || c >= this.cols) continue;
          const index = r * this.cols + c;
          if (!this.open[index]) continue;
          const center = this.center(index);
          const distance = Math.hypot(center.x - point.x, center.y - point.y);
          if (distance < bestDistance) {
            best = index;
            bestDistance = distance;
          }
        }
      }
      if (best >= 0) return best;
    }
    return -1;
  }

  /** Cell centres from the cell nearest `from` to the cell nearest `to`, or null if unreachable. */
  findPath(from: Point, to: Point): Point[] | null {
    const start = this.nearest(from);
    const goal = this.nearest(to);
    if (start < 0 || goal < 0) return null;

    const { cols, rows, open } = this;
    const size = cols * rows;
    const cost = new Float64Array(size).fill(Infinity);
    const cameFrom = new Int32Array(size).fill(-1);
    const closed = new Uint8Array(size);
    const goalCol = goal % cols;
    const goalRow = (goal - goalCol) / cols;
    const estimate = (index: number) => {
      const dx = Math.abs((index % cols) - goalCol);
      const dy = Math.abs(Math.floor(index / cols) - goalRow);
      return Math.max(dx, dy) + (SQRT2 - 1) * Math.min(dx, dy);
    };

    const heap = new Heap();
    cost[start] = 0;
    heap.push(start, estimate(start));

    while (heap.size) {
      const current = heap.pop();
      if (current === goal) break;
      if (closed[current]) continue;
      closed[current] = 1;
      const col = current % cols;
      const row = (current - col) / cols;

      for (const [dc, dr, step] of NEIGHBOURS) {
        const c = col + dc;
        const r = row + dr;
        if (c < 0 || r < 0 || c >= cols || r >= rows) continue;
        const next = r * cols + c;
        if (!open[next] || closed[next]) continue;
        // No cutting corners past blocked cells.
        if (dc && dr && (!open[row * cols + c] || !open[r * cols + col])) continue;
        const nextCost = cost[current] + step;
        if (nextCost >= cost[next]) continue;
        cost[next] = nextCost;
        cameFrom[next] = current;
        heap.push(next, nextCost + estimate(next));
      }
    }

    if (start !== goal && cameFrom[goal] < 0) return null;
    const path: Point[] = [];
    for (let index = goal; index >= 0; index = cameFrom[index]) path.push(this.center(index));
    return path.reverse();
  }
}
