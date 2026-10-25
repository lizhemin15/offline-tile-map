/*
 * 端到端冒烟测试：用无头 Chromium 打开页面，验证瓦片加载、交互与离线约束。
 * 运行：npm install && npx playwright install chromium && npm run test:e2e
 */
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStaticServer } from '../tools/static_server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function assert(condition, message) {
  if (!condition) {
    throw new Error('断言失败：' + message);
  }
}

await fs.mkdir(path.join(ROOT, 'docs'), { recursive: true });

const server = createStaticServer(ROOT);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const base = `http://127.0.0.1:${port}/`;

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--no-sandbox']
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });

const consoleErrors = [];
const pageErrors = [];
const externalRequests = [];

page.on('console', (message) => {
  if (message.type() === 'error') {
    consoleErrors.push(message.text());
  }
});
page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('request', (request) => {
  const url = request.url();
  if (url.startsWith('http') && !url.includes(`127.0.0.1:${port}`)) {
    externalRequests.push(url);
  }
});

try {
  await page.goto(`${base}?zoom=3`, { waitUntil: 'load' });
  await page.waitForFunction(
    () => document.querySelector('#loading') && document.querySelector('#loading').hidden,
    null,
    { timeout: 15000 }
  );
  await page.waitForTimeout(400);

  assert((await page.title()).includes('地图'), '页面标题应包含“地图”');

  const tileInfo = await page.evaluate(() => {
    const tiles = Array.from(document.querySelectorAll('.leaflet-tile-loaded'));
    return {
      count: tiles.length,
      broken: tiles.filter((tile) => !tile.naturalWidth).length,
      stats: window.__mapDebug.stats()
    };
  });
  assert(tileInfo.count >= 4, `应加载多张瓦片，实际 ${tileInfo.count}`);
  assert(tileInfo.broken === 0, `不应有损坏瓦片，实际 ${tileInfo.broken}`);
  assert(tileInfo.stats.loaded > 0, 'tileload 统计应大于 0');
  assert(tileInfo.stats.errors === 0, `不应有瓦片错误，实际 ${tileInfo.stats.errors}`);

  assert(await page.locator('#hud').isVisible(), '坐标读数面板应可见');

  const hudTile = await page.locator('#hud-tile').innerText();
  assert(/^\d+ \/ \d+ \/ \d+$/.test(hudTile), `瓦片读数格式异常：${hudTile}`);

  await page.screenshot({ path: path.join(ROOT, 'docs', 'screenshot.png') });

  await page.mouse.click(720, 470);
  await page.waitForSelector('.leaflet-popup', { timeout: 3000 });
  const popupText = await page.locator('.pin-popup').innerText();
  assert(popupText.includes('经度') && popupText.includes('瓦片'), '选点弹窗应显示经纬度与瓦片编号');

  const markerOk = await page.evaluate(() => {
    const icon = document.querySelector('.leaflet-marker-icon');
    return !!icon && icon.complete && icon.naturalWidth > 0;
  });
  assert(markerOk, '标记图标应正常加载（本地图片）');

  await page.click('#btn-locate');
  await page.fill('#locate-input', '116.3912, 39.9075');
  await page.click('#locate-go');
  await page.waitForTimeout(900);
  const center = await page.evaluate(() => {
    const point = window.__mapDebug.map.getCenter();
    return [point.lng, point.lat];
  });
  assert(Math.abs(center[0] - 116.3912) < 0.01, `经度定位偏差：${center[0]}`);
  assert(Math.abs(center[1] - 39.9075) < 0.01, `纬度定位偏差：${center[1]}`);

  await page.click('#btn-locate');
  await page.fill('#locate-input', '3/6/3');
  await page.click('#locate-go');
  await page.waitForTimeout(900);
  const state = await page.evaluate(() => {
    const point = window.__mapDebug.map.getCenter();
    return {
      lon: point.lng,
      lat: point.lat,
      zoom: window.__mapDebug.map.getZoom(),
      expected: window.MapCoord.tileCenter(6, 3, 3)
    };
  });
  assert(Math.abs(state.lon - state.expected.lon) < 1e-6, '瓦片定位经度不匹配');
  assert(Math.abs(state.lat - state.expected.lat) < 1e-6, '瓦片定位纬度不匹配');
  assert(state.zoom === 3, `瓦片定位应切换到 z3，实际 z${state.zoom}`);

  assert(externalRequests.length === 0, '不应请求外部资源：' + externalRequests.join(', '));
  assert(pageErrors.length === 0, '页面异常：' + pageErrors.join(' | '));
  assert(consoleErrors.length === 0, '控制台错误：' + consoleErrors.join(' | '));

  console.log('E2E 通过：', JSON.stringify({
    tiles: tileInfo.count,
    loaded: tileInfo.stats.loaded,
    errors: tileInfo.stats.errors,
    screenshot: 'docs/screenshot.png'
  }));
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
