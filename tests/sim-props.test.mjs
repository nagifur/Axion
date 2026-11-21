import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PROP_SPRITES, PROP_TYPES, hasPropLook, propCellOccupancy, propFrame, propFrames, propTypeOf } from '../src/lib/sim/sprites.ts';
import { loadRoom, propPreview } from '../src/lib/sim/roomLoader.ts';
import { drawPropSprite, loadAssets, PropPicker, Renderer } from '../src/lib/sim/render.ts';
import { PropEditor } from '../src/lib/sim/propEditor.ts';
import { LIGHTS_OFF_SECONDS, Room } from '../src/lib/sim/room.ts';
import { Prop } from '../src/lib/sim/prop.ts';

const sheet = (propCells, w = 96, h = 96) => ({
  width: propCells[0].length * w, height: propCells.length * h, propCells,
});

async function inspectedImage(file) {
  const { data, info } = await sharp(file).toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, propCells: propCellOccupancy(info, data) };
}

test('prop crops contain all artwork in each 96x96 cell', async () => {
  for (const [asset, sprite] of Object.entries(PROP_SPRITES)) {
    const { data, info } = await sharp(`src/sim_assets/props/${asset}.png`).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const frames = [...propFrames(asset, info), ...Object.values(sprite.states ?? {}).flatMap((state) => state.frames)];
    assert.equal(info.width % 96, 0);
    assert.equal(info.height % 96, 0);
    for (const frame of frames) {
      const cellX = Math.floor(frame.x / 96) * 96;
      const cellY = Math.floor(frame.y / 96) * 96;
      let opaque = 0;
      for (let y = cellY; y < cellY + 96; y++) {
        for (let x = cellX; x < cellX + 96; x++) {
          if (!data[(y * info.width + x) * 4 + 3]) continue;
          opaque++;
          assert.ok(x >= frame.x && x < frame.x + frame.w && y >= frame.y && y < frame.y + frame.h, `${asset}: crop clips artwork at ${x}, ${y}`);
        }
      }
      assert.ok(opaque > 0, `${asset}: frame contains artwork`);
    }
    assert.equal(propFrames(asset, info).length, sprite.frames.length);
  }
});

test('lights animate on simulation time while furniture remains still', () => {
  const image = { width: 192, height: 288 };
  assert.equal(propFrame('light', image, 0), PROP_SPRITES.light.frames[0]);
  assert.equal(propFrame('light', image, 0.59), PROP_SPRITES.light.frames[0]);
  assert.equal(propFrame('light', image, 0.6), PROP_SPRITES.light.frames[1]);
  assert.equal(propFrame('light', image, 1.2), PROP_SPRITES.light.frames[0]);
  assert.equal(propFrame('chair', { width: 192, height: 288 }, 100), PROP_SPRITES.chair.frames[0]);
  assert.deepEqual(propFrame('plant', { width: 20, height: 30 }, 100), { x: 0, y: 0, w: 20, h: 30 });
});

test('undeclared props over 96px animate through cells at the light speed', () => {
  const first = { x: 0, y: 0, w: 96, h: 96 };
  const second = { x: 96, y: 0, w: 96, h: 96 };
  const image = sheet([[true, true]]);
  assert.deepEqual(propFrames('animated_decoration', image), [first, second]);
  for (const [time, expected] of [[0, first], [0.59, first], [0.6, second], [1.2, first]]) {
    assert.deepEqual(propFrame('animated_decoration', image, time), expected);
  }
  assert.deepEqual(propFrame('animated_decoration', image, 0.6, 'broken'), second);
  assert.deepEqual(propFrames('animated_decoration', sheet([[true], [true]])), [first]);
  const twoRows = sheet([[true, true], [true, true]]);
  assert.deepEqual(propFrames('animated_decoration', twoRows), [first, second]);
  assert.deepEqual(propFrame('animated_decoration', twoRows, 1.8), {
    x: 96, y: 0, w: 96, h: 96,
  });
  assert.deepEqual(propFrame('decoration', { width: 96, height: 96 }, 100), first);
  assert.deepEqual(propFrames('animated_decoration', sheet([[true, true]], 96, 40)), [
    { x: 0, y: 0, w: 96, h: 40 }, { x: 96, y: 0, w: 96, h: 40 },
  ]);
  assert.deepEqual(propFrames('animated_decoration', sheet([[true], [true]], 40, 96)), [
    { x: 0, y: 0, w: 40, h: 96 },
  ]);
});

test('automatic sheets use only populated cells in their separate state rows', () => {
  const asset = 'animated_decoration';
  const image = sheet([[true, true], [true, false], [true, true], [true, true]]);
  assert.deepEqual(propFrames(asset, image, 'off'), [{ x: 0, y: 96, w: 96, h: 96 }]);
  assert.deepEqual(propFrames(asset, image, 'broken'), [
    { x: 0, y: 192, w: 96, h: 96 }, { x: 96, y: 192, w: 96, h: 96 },
  ]);
  for (const time of [0, 0.59, 0.6, 1.2, 1.8, 20]) {
    assert.equal(propFrame(asset, image, time).y, 0);
    assert.equal(propFrame(asset, image, time, 'off').y, 96);
    assert.equal(propFrame(asset, image, time, 'broken').y, 192);
    assert.equal(propFrame(asset, image, time, 'off').x, 0);
  }
  assert.equal(propFrame(asset, image, 0.6, 'broken').x, 96);
  assert.equal(propFrame(asset, image, 1.2, 'broken').x, 0);
  assert.equal(hasPropLook(asset, 'off', image), true);
  assert.equal(hasPropLook(asset, 'broken', image), true);
  assert.deepEqual(propTypeOf(asset, image), { asset, switchable: true, breakable: true });

  const brokenOnly = sheet([[true, false], [false, false], [true, false]]);
  assert.equal(hasPropLook(asset, 'off', brokenOnly), false);
  assert.equal(hasPropLook(asset, 'broken', brokenOnly), true);
  assert.deepEqual(propTypeOf(asset, brokenOnly), { asset, breakable: true });
  for (const time of [0, 0.6, 1.2, 20]) {
    assert.deepEqual(propFrame(asset, brokenOnly, time), { x: 0, y: 0, w: 96, h: 96 });
    assert.deepEqual(propFrame(asset, brokenOnly, time, 'broken'), { x: 0, y: 192, w: 96, h: 96 });
    assert.deepEqual(propFrame(asset, brokenOnly, time, 'off'), propFrame(asset, brokenOnly, time));
  }
  const offAfterGap = sheet([[true, true], [false, true], [false, false]]);
  assert.deepEqual(propFrame(asset, offAfterGap, 0, 'off'), { x: 96, y: 96, w: 96, h: 96 });
  assert.equal(hasPropLook(asset, 'broken', offAfterGap), false);
  assert.deepEqual(propFrame(asset, offAfterGap, 0.6, 'broken'), propFrame(asset, offAfterGap, 0.6));
  const emptyStates = sheet([[true, false], [false, false], [false, false]]);
  assert.deepEqual(propTypeOf(asset, emptyStates), { asset });
  assert.equal(hasPropLook(asset, 'off', emptyStates), false);
  assert.equal(hasPropLook(asset, 'broken', emptyStates), false);

  const vertical = sheet([[true], [true]]);
  assert.deepEqual(propFrame(asset, vertical, 20, 'off'), { x: 0, y: 96, w: 96, h: 96 });
  const singleRow = sheet([[true, true]]);
  assert.equal(hasPropLook(asset, 'off', singleRow), false);
  assert.deepEqual(propTypeOf(asset, singleRow), { asset });
  assert.deepEqual(propFrame(asset, singleRow, 0.6, 'off'), propFrame(asset, singleRow, 0.6));
});

test('the real glass and vending sheets detect their populated frames', async () => {
  for (const asset of ['glass', 'glass_angle', 'glass_half']) {
    const image = await inspectedImage(`src/sim_assets/props/${asset}.png`);
    assert.deepEqual(image.propCells, [[true, false], [false, false], [true, false]]);
    assert.deepEqual(propTypeOf(asset, image), { ...PROP_TYPES[asset], breakable: true });
    assert.deepEqual(propFrames(asset, image), [{ x: 0, y: 0, w: 96, h: 96 }]);
    assert.deepEqual(propFrames(asset, image, 'broken'), [{ x: 0, y: 192, w: 96, h: 96 }]);
  }
  const vending = await inspectedImage('src/sim_assets/props/vending_machine.png');
  assert.deepEqual(vending.propCells, [[true, true], [true, false], [true, true]]);
  assert.equal(propTypeOf('vending_machine', vending).switchable, true);
  assert.equal(propTypeOf('vending_machine', vending).breakable, true);
  assert.equal(propFrame('vending_machine', vending, 0.6, 'broken').x, 96);
  assert.equal(propFrame('vending_machine', vending, 0.6, 'broken').y, 192);
});

test('automatic sheets report incomplete cells instead of clipping artwork', () => {
  for (const image of [
    { width: 97, height: 96 }, { width: 96, height: 97 }, { width: 192, height: 193 },
    { width: Infinity, height: 96 },
  ]) {
    assert.throws(() => propFrames('animated_decoration', image), /automatic sheets need complete.*PROP_SPRITES/);
  }
  assert.throws(() => propFrames('animated_decoration', { width: 192, height: 192 }), /populated cell data is required/);
  assert.throws(() => propFrames('animated_decoration', sheet([[true, true], [false]])), /populated cell data is required/);
  const sparseRows = sheet([[true, true], [false, false]]);
  delete sparseRows.propCells[1];
  assert.throws(() => propFrames('animated_decoration', sparseRows), /populated cell data is required/);
  const sparseCells = sheet([[true, true], [false, false]]);
  delete sparseCells.propCells[1][0];
  assert.throws(() => propFrames('animated_decoration', sparseCells), /populated cell data is required/);
  assert.throws(() => propFrames('animated_decoration', sheet([[false, false], [true, false]])), /at least one frame is required/);
  assert.throws(() => propCellOccupancy({ width: 2, height: 2 }, new Uint8Array(15)), /RGBA data matching the image size/);
});

test('automatic sheets use one frame for room loading, palette previews, placement, and drawing', async (t) => {
  const assetsDir = await mkdtemp(path.join(tmpdir(), 'axion-prop-sheet-'));
  t.after(() => rm(assetsDir, { recursive: true, force: true }));
  const roomDir = path.join(assetsDir, 'rooms', 'test-room');
  await mkdir(roomDir, { recursive: true });
  await mkdir(path.join(assetsDir, 'props'));
  const originalRoom = 'src/sim_assets/rooms/level-1-offices';
  const json = JSON.parse(await readFile(path.join(originalRoom, 'room.json'), 'utf8'));
  delete json.doors;
  json.props = [{ type: 'animated_decoration', x: 100, y: 50, on: false }];
  await Promise.all([
    copyFile(path.join(originalRoom, 'room.png'), path.join(roomDir, 'room.png')),
    copyFile(path.join(originalRoom, 'navMap.png'), path.join(roomDir, 'navMap.png')),
    writeFile(path.join(roomDir, 'room.json'), JSON.stringify(json)),
    sharp({ create: { width: 192, height: 192, channels: 4, background: '#ff0000' } })
      .png().toFile(path.join(assetsDir, 'props', 'animated_decoration.png')),
  ]);
  const room = new Room(await loadRoom('test-room', assetsDir));
  assert.deepEqual([room.props[0].w, room.props[0].h], [96, 96]);
  const prop = room.props[0];
  assert.equal(prop.switchable, true);
  assert.equal(prop.on, false);
  assert.equal(prop.look, 'off');
  assert.equal(new Prop(prop.toData()).switchable, true, 'cloning preserves the sheet power switch');
  room.updateLights(true, 0);
  assert.equal(prop.look, 'off', 'entering does not power on an ordinary switchable prop');
  room.updateLights(false, LIGHTS_OFF_SECONDS);
  assert.equal(prop.look, 'off');
  prop.setOn(true);
  room.updateLights(true, 0);
  room.updateLights(false, LIGHTS_OFF_SECONDS);
  assert.equal(prop.look, undefined, 'leaving does not power off an ordinary switchable prop');
  prop.setOn(false);
  const preview = await propPreview('animated_decoration', assetsDir);
  const size = await sharp(Buffer.from(preview.split(',')[1], 'base64')).metadata();
  assert.deepEqual([size.width, size.height], [96, 96]);
  const image = sheet([[true, true], [true, true]]);
  const editor = new PropEditor({ animated_decoration: image }, room, () => {});
  editor.add('animated_decoration');
  editor.pointerDown({ x: 200, y: 160 }, 0.6);
  assert.deepEqual([editor.selected.w, editor.selected.h, editor.selected.x, editor.selected.y], [96, 96, 152, 64]);
  assert.equal(editor.selected.switchable, true);
  editor.toggleOff();
  assert.equal(editor.selected.look, 'off');
  assert.deepEqual(JSON.parse(`{${editor.snippet()}}`).props[1], {
    type: 'animated_decoration', x: 152, y: 64, on: false,
  });
  const calls = [];
  const ctx = { drawImage(...args) { calls.push(args); } };
  drawPropSprite(ctx, image, 'animated_decoration', 100, 50, false, 0.6);
  assert.deepEqual(calls, [[image, 96, 0, 96, 96, 100, 50, 96, 96]]);
  calls.length = 0;
  drawPropSprite(ctx, image, 'animated_decoration', 100, 50, false, 0.6, prop.look);
  assert.deepEqual(calls, [[image, 0, 96, 96, 96, 100, 50, 96, 96]]);
  editor.reset();
  assert.equal(room.props[0].switchable, true);
  assert.equal(room.props[0].look, 'off');
});

test('broken-only sheets work through room loading, editing, cloning, and drawing', async (t) => {
  const assetsDir = await mkdtemp(path.join(tmpdir(), 'axion-broken-sheet-'));
  t.after(() => rm(assetsDir, { recursive: true, force: true }));
  const roomDir = path.join(assetsDir, 'rooms', 'test-room');
  await mkdir(roomDir, { recursive: true });
  await mkdir(path.join(assetsDir, 'props'));
  const originalRoom = 'src/sim_assets/rooms/level-1-offices';
  const json = JSON.parse(await readFile(path.join(originalRoom, 'room.json'), 'utf8'));
  delete json.doors;
  const roomJson = path.join(roomDir, 'room.json');
  json.props = [{ type: 'glass', x: 100, y: 50, broken: true }];
  await Promise.all([
    copyFile(path.join(originalRoom, 'room.png'), path.join(roomDir, 'room.png')),
    copyFile(path.join(originalRoom, 'navMap.png'), path.join(roomDir, 'navMap.png')),
    copyFile('src/sim_assets/props/glass.png', path.join(assetsDir, 'props', 'glass.png')),
    writeFile(roomJson, JSON.stringify(json)),
  ]);
  const room = new Room(await loadRoom('test-room', assetsDir));
  const glass = room.props[0];
  assert.deepEqual([glass.switchable, glass.breakable, glass.broken, glass.look], [false, true, true, 'broken']);
  assert.equal(glass.setOn(false), false);
  const clone = new Prop(glass.toData());
  assert.deepEqual([clone.switchable, clone.breakable, clone.broken, clone.look], [false, true, true, 'broken']);
  assert.equal(glass.repair(), true);
  assert.equal(glass.look, undefined);
  assert.equal(glass.break(), true);
  assert.equal(glass.look, 'broken');
  room.updateLights(true, 0);
  room.updateLights(false, LIGHTS_OFF_SECONDS);
  assert.equal(glass.on, true);

  const image = await inspectedImage(path.join(assetsDir, 'props', 'glass.png'));
  const editor = new PropEditor({ glass: image }, room, () => {});
  editor.add('glass');
  editor.pointerDown({ x: 200, y: 160 });
  assert.deepEqual([editor.selected.switchable, editor.selected.breakable], [false, true]);
  editor.toggleOff();
  assert.equal(editor.selected.on, true);
  editor.toggleBroken();
  assert.equal(editor.selected.look, 'broken');
  assert.deepEqual(JSON.parse(`{${editor.snippet()}}`).props[1], {
    type: 'glass', x: 152, y: 64, broken: true,
  });
  const calls = [];
  drawPropSprite({ drawImage(...args) { calls.push(args); } }, image, 'glass', 100, 50, false, 0.6, editor.selected.look);
  assert.deepEqual(calls, [[image, 0, 192, 96, 96, 100, 50, 96, 96]]);
  editor.reset();
  assert.deepEqual([room.props[0].switchable, room.props[0].breakable, room.props[0].look], [false, true, 'broken']);

  for (const on of [false, true]) {
    json.props = [{ type: 'glass', x: 100, y: 50, on }];
    await writeFile(roomJson, JSON.stringify(json));
    await assert.rejects(loadRoom('test-room', assetsDir), /glass\) can't have "on"/);
  }
  json.props = [{ type: 'glass', x: 100, y: 50, broken: false }];
  await writeFile(roomJson, JSON.stringify(json));
  assert.equal((await loadRoom('test-room', assetsDir)).props[0].start, undefined);
});

test('pixel picking follows broken artwork instead of the normal frame', (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'document', original);
    else delete globalThis.document;
  });
  const glassImage = sheet([[true, false], [false, false], [true, false]]);
  const plantImage = { width: 96, height: 96 };
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement() {
        let source, sourceY;
        const ctx = {
          drawImage(image, _x, y) { source = image; sourceY = y; },
          getImageData(_x, _y, width, height) {
            const data = new Uint8ClampedArray(width * height * 4);
            if (source === plantImage || (source === glassImage && sourceY === 192)) data[3] = 255;
            return { data };
          },
        };
        return { width: 0, height: 0, getContext() { return ctx; } };
      },
    },
  });
  const placed = (type) => ({ type, asset: type, x: 0, y: 0, w: 96, h: 96, flip: false });
  const plant = new Prop(placed('plant'));
  const glass = new Prop({ ...placed('glass'), brokenLook: true });
  const picker = new PropPicker({ plant: plantImage, glass: glassImage });
  const room = { props: [plant, glass] };
  glass.break();
  assert.equal(picker.at(room, { x: 0, y: 0 }), glass);
  glass.repair();
  assert.equal(picker.at(room, { x: 0, y: 0 }), plant);
});

test('invalid sheet bounds and animation time are reported', () => {
  assert.throws(() => propFrame('light', { width: 96, height: 96 }), /outside its 96x96 sheet/);
  assert.throws(() => propFrame('chair', { width: 27, height: 38 }), /outside/);
  assert.throws(() => propFrame('plant', { width: 0, height: 0 }), /outside/);
  assert.throws(() => propFrame('light', { width: 192, height: 96 }), /outside its 192x96 sheet/);
  assert.throws(() => propFrame('light', { width: 192, height: 192 }), /outside its 192x192 sheet/);
  assert.throws(() => propFrame('light', { width: 192, height: 192 }, -1), /finite and non-negative/);
});

test('room loading preserves cropped furniture sizes, seats, and floor geometry', async () => {
  const room = new Room(await loadRoom('level-1-offices'));
  const sizes = { bench: [71, 37], chair: [59, 58], table: [70, 27], light: [40, 17] };
  for (const prop of room.props) assert.deepEqual([prop.w, prop.h], sizes[prop.type]);
  assert.deepEqual(room.spots.filter((seat) => seat.kind === 'bench').map(({ x, y }) => [x, y]), [[78, 154], [98, 154], [118, 154]]);
  const right = room.spots.find((seat) => seat.kind === 'chair' && seat.facing === 'right');
  assert.deepEqual([right.x, right.y], [327, 157]);
  const left = room.spots.find((seat) => seat.kind === 'chair' && seat.facing === 'left');
  assert.deepEqual([left.x, left.y], [431, 157]);
  assert.ok(room.blockedAreas.some((rect) => rect.x === 321 && rect.y === 152 && rect.w === 21 && rect.h === 8));
  assert.ok(room.blockedAreas.some((rect) => rect.x === 417 && rect.y === 152 && rect.w === 21 && rect.h === 8));
  const lobby = new Room(await loadRoom('level-2-lobby'));
  assert.deepEqual(lobby.spots.filter((seat) => seat.kind === 'bench').map(({ x, y }) => [x, y]), [[78, 154], [98, 154], [118, 154]]);
});

test('palette previews contain only the first cropped frame', async () => {
  for (const asset of ['light', 'chair']) {
    const preview = await propPreview(asset);
    const actual = await sharp(Buffer.from(preview.split(',')[1], 'base64')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const frame = PROP_SPRITES[asset].frames[0];
    const expected = await sharp(`src/sim_assets/props/${asset}.png`)
      .extract({ left: frame.x, top: frame.y, width: frame.w, height: frame.h }).ensureAlpha().raw().toBuffer();
    assert.deepEqual([actual.info.width, actual.info.height], [frame.w, frame.h]);
    assert.deepEqual(actual.data, expected);
  }
});

test('prop drawing crops and mirrors the current frame, not the whole sheet', () => {
  const calls = [];
  const ctx = {
    drawImage(...args) { calls.push(['draw', ...args]); },
    save() { calls.push(['save']); },
    restore() { calls.push(['restore']); },
    translate(...args) { calls.push(['translate', ...args]); },
    scale(...args) { calls.push(['scale', ...args]); },
  };
  const image = { width: 192, height: 288 };
  drawPropSprite(ctx, image, 'light', 10, 20, false, 0);
  assert.deepEqual(calls, [['draw', image, 28, 39, 40, 17, 10, 20, 40, 17]]);
  calls.length = 0;
  drawPropSprite(ctx, image, 'light', 10, 20, true, 0.6);
  assert.deepEqual(calls, [
    ['save'], ['translate', 50, 20], ['scale', -1, 1],
    ['draw', image, 124, 39, 40, 17, 0, 0, 40, 17], ['restore'],
  ]);
  calls.length = 0;
  drawPropSprite(ctx, image, 'light', 10, 20, false, 0.6, 'off');
  assert.deepEqual(calls, [['draw', image, 28, 135, 40, 17, 10, 20, 40, 17]]);
  calls.length = 0;
  drawPropSprite(ctx, image, 'light', 10, 20, true, 0.6, 'broken');
  assert.deepEqual(calls, [
    ['save'], ['translate', 50, 20], ['scale', -1, 1],
    ['draw', image, 28, 231, 40, 17, 0, 0, 40, 17], ['restore'],
  ]);
});

test('broken artwork takes precedence over power and missing artwork falls back', (t) => {
  const image = { width: 192, height: 288 };
  assert.deepEqual(propFrame('light', image, 0, 'off'), { x: 28, y: 135, w: 40, h: 17 });
  assert.deepEqual(propFrame('light', image, 5, 'off'), { x: 28, y: 135, w: 40, h: 17 });
  const light = new Prop({ type: 'light', asset: 'light', x: 0, y: 0, w: 40, h: 17, flip: false });
  light.setOn(false);
  light.break();
  assert.equal(light.look, 'broken');
  assert.equal(propFrame('light', image, 0, light.look).y, 231);
  light.repair();
  assert.equal(light.look, 'off', 'repair preserves the earlier power state');

  PROP_TYPES.legacy_fixture = { asset: 'legacy_fixture', breakable: true };
  t.after(() => { delete PROP_TYPES.legacy_fixture; });
  const legacyImage = sheet([[true], [true]]);
  const legacy = new Prop({ type: 'legacy_fixture', asset: 'legacy_fixture', x: 0, y: 0, w: 96, h: 96, flip: false, switchable: true });
  legacy.break();
  assert.equal(legacy.look, 'off', 'a switchable prop without broken artwork goes dark');
  assert.equal(propFrame('legacy_fixture', legacyImage, 0, legacy.look).y, 96);
  assert.deepEqual(propFrame('legacy_fixture', legacyImage, 0, 'broken'), propFrame('legacy_fixture', legacyImage));
});

test('editor placement uses one cropped frame as its footprint', async () => {
  const room = new Room(await loadRoom('level-1-offices'));
  const editor = new PropEditor({ light: { width: 192, height: 288 }, chair: { width: 192, height: 288 } }, room, () => {});
  editor.add('light');
  editor.pointerDown({ x: 100, y: 100 }, 0.6);
  assert.deepEqual(editor.selected.toData(), { type: 'light', asset: 'light', flip: false, x: 80, y: 83, w: 40, h: 17 });
  assert.ok(room.props.includes(editor.selected));
  editor.add('chair');
  editor.pointerDown({ x: 200, y: 160 });
  assert.deepEqual([editor.selected.w, editor.selected.h, editor.selected.x, editor.selected.y], [59, 58, 171, 102]);
  editor.flip();
  const seat = room.spots.find((s) => s.id === `chair-${room.props.length - 1}-0`);
  assert.equal(seat.facing, 'left');
});

test('elevator doors and lit arrows use their cropped artwork dimensions', async (t) => {
  const source = await sharp('src/sim_assets/props/elevator_lights.png').ensureAlpha().raw().toBuffer();
  let off;
  for (let i = 0; i < source.length && !off; i += 4) {
    if (source[i + 3]) off = source.subarray(i, i + 4);
  }
  assert.ok(off, 'arrow artwork contains opaque pixels');
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'document', original);
    else delete globalThis.document;
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement() {
        const draws = [];
        const translations = [];
        const ctx = {
          drawImage(...args) { draws.push(args); },
          getImageData(_x, _y, w, h) {
            const data = new Uint8ClampedArray(w * h * 4);
            for (let i = 0; i < data.length; i += 4) data.set(off, i);
            return { data };
          },
          putImageData(image) { this.pixels = image.data; },
          fillRect() {}, save() {}, restore() {}, scale() {},
          translate(...args) { translations.push(args); },
        };
        return { width: 0, height: 0, draws, translations, getContext() { return ctx; } };
      },
    },
  });
  const canvas = document.createElement('canvas');
  const door = { width: 96, height: 96 };
  const lights = { width: 96, height: 96 };
  const room = { elevator: { x: 20, y: 30, w: 48, h: 67 } };
  const renderer = new Renderer(canvas, { character: { width: 576, height: 1152 }, elevator_door: door, elevator_lights: lights }, room);
  assert.deepEqual([...renderer.litArrows.getContext('2d').pixels.subarray(0, 4)], [255, 177, 91, 255]);
  const elevator = { open: 0.5, light: 'up' };
  const world = { time: 0, elevatorFor() { return elevator; }, agentsIn() { return []; } };
  renderer.drawElevator(world, new Map());
  assert.deepEqual(canvas.draws[0], [door, 36, 15, 24, 67, 8, 30, 24, 67]);
  assert.deepEqual(canvas.draws[1], [door, 36, 15, 24, 67, 0, 0, 24, 67]);
  assert.deepEqual(canvas.translations, [[80, 30]]);
  assert.deepEqual(canvas.draws[2], [lights, 36, 44, 24, 9, 32, 14, 24, 9]);
  assert.deepEqual(canvas.draws[3].slice(1), [36, 44, 11, 9, 32, 14, 11, 9]);
  canvas.draws.length = 0;
  elevator.light = 'down';
  renderer.drawElevator(world, new Map());
  assert.deepEqual(canvas.draws[3].slice(1), [49, 44, 11, 9, 45, 14, 11, 9]);

  const bigDoor = { width: 96, height: 96 };
  renderer.assets.elevator_door_big = bigDoor;
  room.elevator = { x: 458, y: 251, w: 176, h: 73, big: true };
  canvas.draws.length = 0;
  canvas.translations.length = 0;
  renderer.drawElevator(world, new Map());
  assert.deepEqual(canvas.draws[0], [bigDoor, 5, 12, 87, 73, 414, 251, 87, 73]);
  assert.deepEqual(canvas.draws[1], [bigDoor, 5, 12, 87, 73, 0, 0, 87, 73]);
  assert.deepEqual(canvas.translations, [[678, 251]]);
  assert.deepEqual(canvas.draws[2], [lights, 36, 44, 24, 9, 534, 235, 24, 9]);
});

test('asset loading rejects invalid prop sheets instead of rendering broken crops', async (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'Image');
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'Image', original);
    else delete globalThis.Image;
  });
  Object.defineProperty(globalThis, 'Image', {
    configurable: true,
    value: class {
      width = 96;
      height = 96;
      set src(_value) { this.onload(); }
    },
  });
  await assert.rejects(loadAssets({ light: '/light.png' }), /outside its 96x96 sheet/);
});

test('browser asset loading detects transparent cells and reports pixel-read errors', async (t) => {
  const originalImage = Object.getOwnPropertyDescriptor(globalThis, 'Image');
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  t.after(() => {
    if (originalImage) Object.defineProperty(globalThis, 'Image', originalImage);
    else delete globalThis.Image;
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else delete globalThis.document;
  });
  Object.defineProperty(globalThis, 'Image', {
    configurable: true,
    value: class {
      width = 192;
      height = 288;
      set src(_value) { this.onload(); }
    },
  });
  const rgba = new Uint8ClampedArray(192 * 288 * 4);
  rgba[3] = 255;
  rgba[(192 * 192) * 4 + 3] = 255;
  let pixelError = false;
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement() {
        const ctx = {
          drawImage() {},
          getImageData() {
            if (pixelError) throw new Error('pixel read failed');
            return { data: rgba };
          },
        };
        return { width: 0, height: 0, getContext() { return ctx; } };
      },
    },
  });
  const assets = await loadAssets({ glass: '/glass.png' });
  assert.deepEqual(assets.glass.propCells, [[true, false], [false, false], [true, false]]);
  assert.deepEqual(propTypeOf('glass', assets.glass), { ...PROP_TYPES.glass, breakable: true });
  assert.equal(propFrame('glass', assets.glass, 1, 'broken').y, 192);
  pixelError = true;
  await assert.rejects(loadAssets({ glass: '/glass.png' }), /pixel read failed/);
});
