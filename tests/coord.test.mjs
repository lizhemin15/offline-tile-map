import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const MC = require('../assets/js/coord.js');

const EPS = 1e-9;

test('WMTS 世界范围：z0 只有一张瓦片', () => {
  assert.deepEqual(MC.lonLatToTile(-180, 85.0511287798066, 0), { x: 0, y: 0, z: 0 });
  assert.deepEqual(MC.lonLatToTile(180, -85.0511287798066, 0), { x: 0, y: 0, z: 0 });
  assert.equal(MC.tilesPerSide(0), 1);
  assert.equal(MC.tilesPerSide(11), 2048);
});

test('原点在左上：x 向东增大，y 向南增大', () => {
  const west = MC.lonLatToTile(-100, 0, 2);
  const east = MC.lonLatToTile(100, 0, 2);
  assert.equal(west.x, 0);
  assert.equal(east.x, 3);

  const north = MC.lonLatToTile(0, 70, 2);
  const south = MC.lonLatToTile(0, -70, 2);
  assert.equal(north.y, 0);
  assert.equal(south.y, 3);
  assert.ok(north.y < south.y);
});

test('北京附近瓦片编号（z5）', () => {
  const tile = MC.lonLatToTile(116.3912, 39.9075, 5);
  assert.equal(tile.z, 5);
  assert.equal(tile.x, 26);
  assert.equal(tile.y, 12);
});

test('瓦片边界覆盖其中心点，且四至顺序正确', () => {
  for (let z = 0; z <= 12; z += 3) {
    const n = MC.tilesPerSide(z);
    for (const [x, y] of [[0, 0], [n - 1, n - 1], [Math.floor(n / 3), Math.floor(n / 2)]]) {
      const bounds = MC.tileBounds(x, y, z);
      assert.ok(bounds.west < bounds.east);
      assert.ok(bounds.south < bounds.north);
      const center = MC.tileCenter(x, y, z);
      assert.ok(center.lon > bounds.west && center.lon < bounds.east);
      assert.ok(center.lat > bounds.south && center.lat < bounds.north);
      assert.deepEqual(MC.lonLatToTile(center.lon, center.lat, z), { x, y, z });
    }
  }
});

test('分辨率符合 EPSG:3857 / 256px 约定', () => {
  assert.ok(Math.abs(MC.resolution(0) - 156543.03392804097) < 1e-6);
  assert.ok(Math.abs(MC.resolution(11) - 76.43702828517625) < 1e-6);
  assert.ok(Math.abs(MC.resolution(0) / MC.resolution(1) - 2) < EPS);
});

test('米制坐标与经纬度互转', () => {
  const meters = MC.lonLatToMeters(116.3912, 39.9075);
  assert.ok(Math.abs(meters.x - 12956609.12) < 1);
  assert.ok(Math.abs(meters.y - 4852509.52) < 2);
  const back = MC.metersToLonLat(meters.x, meters.y);
  assert.ok(Math.abs(back.lon - 116.3912) < 1e-9);
  assert.ok(Math.abs(back.lat - 39.9075) < 1e-9);
});

test('纬度在 Web Mercator 边界处被截断', () => {
  assert.equal(MC.clampLat(90), MC.MAX_LAT);
  assert.equal(MC.clampLat(-90), -MC.MAX_LAT);
  const top = MC.lonLatToTile(0, 90, 4);
  assert.equal(top.y, 0);
});

test('数字格式化固定小数位', () => {
  assert.equal(MC.formatNumber(116.39123456, 6), '116.391235');
  assert.equal(MC.formatNumber(-0.0000001, 3), '-0.000');
});
