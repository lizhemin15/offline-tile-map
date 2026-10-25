/*
 * 地图页面逻辑：读取 config.js，初始化 Leaflet，绑定界面交互。
 * 所有资源均来自本地，不依赖任何 CDN 或在线服务。
 */
(function () {
  'use strict';

  var MC = window.MapCoord;
  var DEMO_TILE_URL = 'demo/tiles/{z}/{x}/{y}.jpg';

  var DEFAULTS = {
    title: '内网离线地图',
    subtitle: 'EPSG:3857 · XYZ 瓦片',
    tile: {
      url: DEMO_TILE_URL,
      minZoom: 0,
      maxZoom: 11,
      maxNativeZoom: 3,
      tileSize: 256,
      scheme: 'xyz',
      subdomains: [],
      detectRetina: false,
      attribution: '瓦片来源：内网 XYZ 服务'
    },
    view: {
      center: [0, 0],
      zoom: 3
    },
    ui: {
      coords: true,
      scale: true,
      zoom: true,
      locate: true,
      help: true,
      fullscreen: true
    },
    overlays: []
  };

  var state = {
    map: null,
    layer: null,
    cfg: null,
    marker: null,
    lastLatLng: null,
    pointerInside: false,
    loaded: 0,
    errors: 0,
    firstTile: false,
    loadingTimer: null,
    toastTimer: null
  };

  function $(selector, root) {
    return (root || document).querySelector(selector);
  }

  function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function cloneValue(value) {
    if (Array.isArray(value)) {
      return value.slice();
    }
    if (isPlainObject(value)) {
      return deepMerge(value, {});
    }
    return value;
  }

  function deepMerge(base, extra) {
    var out = {};
    Object.keys(base).forEach(function (key) {
      out[key] = cloneValue(base[key]);
    });
    if (!isPlainObject(extra)) {
      return out;
    }
    Object.keys(extra).forEach(function (key) {
      var next = extra[key];
      if (next === undefined) {
        return;
      }
      if (isPlainObject(next) && isPlainObject(out[key])) {
        out[key] = deepMerge(out[key], next);
      } else {
        out[key] = cloneValue(next);
      }
    });
    return out;
  }

  function toInt(value, fallback, min, max) {
    var n = Math.round(Number(value));
    if (!isFinite(n)) {
      return fallback;
    }
    return Math.min(max, Math.max(min, n));
  }

  function normalizeCenter(value) {
    var lat;
    var lon;
    if (Array.isArray(value)) {
      lat = Number(value[0]);
      lon = Number(value[1]);
    } else if (value && typeof value === 'object') {
      lat = Number(value.lat);
      lon = Number(value.lng !== undefined ? value.lng : value.lon);
    }
    if (!isFinite(lat) || !isFinite(lon)) {
      return [0, 0];
    }
    return [MC.clampLat(lat), lon];
  }

  function normalizeConfig(raw) {
    var cfg = deepMerge(DEFAULTS, raw || {});
    if (!isPlainObject(cfg.tile)) {
      cfg.tile = {};
    }
    if (!isPlainObject(cfg.view)) {
      cfg.view = {};
    }
    if (!isPlainObject(cfg.ui)) {
      cfg.ui = {};
    }
    var tile = cfg.tile;

    tile.url = typeof tile.url === 'string' ? tile.url.trim() : '';
    if (!tile.url || tile.url.indexOf('{z}') === -1 || tile.url.indexOf('{x}') === -1 || tile.url.indexOf('{y}') === -1) {
      throw new Error('tile.url 必须是一个包含 {z}、{x}、{y} 占位符的瓦片地址模板。');
    }
    if (tile.url.indexOf('{s}') !== -1 && (!Array.isArray(tile.subdomains) || !tile.subdomains.length)) {
      throw new Error('tile.url 使用了 {s} 占位符，但 tile.subdomains 为空。');
    }
    if (!Array.isArray(tile.subdomains)) {
      tile.subdomains = [];
    }

    tile.minZoom = toInt(tile.minZoom, 0, 0, 24);
    tile.maxZoom = toInt(tile.maxZoom, 11, tile.minZoom, 24);
    tile.maxNativeZoom = tile.maxNativeZoom === null || tile.maxNativeZoom === undefined
      ? tile.maxZoom
      : toInt(tile.maxNativeZoom, tile.maxZoom, tile.minZoom, tile.maxZoom);
    tile.tileSize = toInt(tile.tileSize, 256, 64, 1024);
    tile.scheme = tile.scheme === 'tms' ? 'tms' : 'xyz';

    cfg.view.center = normalizeCenter(cfg.view.center);
    cfg.view.zoom = Math.min(tile.maxZoom, Math.max(tile.minZoom, Number(cfg.view.zoom) || 0));

    if (!Array.isArray(cfg.overlays)) {
      cfg.overlays = [];
    }
    cfg.overlays = cfg.overlays.filter(function (item) {
      return item && typeof item.url === 'string' && item.url.indexOf('{z}') !== -1;
    });

    return cfg;
  }

  /** 允许用 URL 参数临时覆盖配置，方便联调：
   *  ?tile=http://host:12345/map/gsm/{z}/{x}/{y}.jpg&maxZoom=11&maxNativeZoom=11
   */
  function applyQuery(raw, search) {
    var params;
    try {
      params = new URLSearchParams(search);
    } catch (err) {
      return;
    }
    var tileUrl = params.get('tile') || params.get('url');
    if (tileUrl) {
      raw.tile.url = tileUrl;
    }
    ['minZoom', 'maxZoom', 'maxNativeZoom', 'tileSize'].forEach(function (key) {
      var value = params.get(key);
      if (value !== null && value !== '' && isFinite(Number(value))) {
        raw.tile[key] = Number(value);
      }
    });
    if (params.get('scheme') === 'tms') {
      raw.tile.scheme = 'tms';
    }
    var center = params.get('center');
    if (center) {
      var pair = center.split(',');
      if (pair.length === 2 && isFinite(Number(pair[0])) && isFinite(Number(pair[1]))) {
        raw.view.center = [Number(pair[1]), Number(pair[0])]; // center=经度,纬度
      }
    }
    var zoom = params.get('zoom');
    if (zoom !== null && zoom !== '' && isFinite(Number(zoom))) {
      raw.view.zoom = Number(zoom);
    }
  }

  function fmt(value) {
    return MC.formatNumber(value, 6);
  }

  function showToast(message) {
    var toast = $('#toast');
    toast.textContent = message;
    toast.classList.add('is-visible');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(function () {
      toast.classList.remove('is-visible');
    }, 1800);
  }

  function copyText(text) {
    return new Promise(function (resolve, reject) {
      function fallback() {
        try {
          var area = document.createElement('textarea');
          area.value = text;
          area.setAttribute('readonly', '');
          area.style.position = 'fixed';
          area.style.top = '-1000px';
          document.body.appendChild(area);
          area.select();
          var ok = document.execCommand('copy');
          document.body.removeChild(area);
          if (ok) {
            resolve();
          } else {
            reject(new Error('copy command failed'));
          }
        } catch (err) {
          reject(err);
        }
      }
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(resolve, fallback);
      } else {
        fallback();
      }
    });
  }

  function showBanner(text, level, options) {
    var banner = $('#banner');
    banner.hidden = false;
    banner.className = 'banner' + (level === 'error' ? ' is-error' : level === 'warn' ? ' is-warn' : '');
    $('#banner-text').textContent = text;
    $('#banner-retry').hidden = !!(options && options.noRetry);
  }

  function hideBanner() {
    $('#banner').hidden = true;
  }

  function hideLoading() {
    $('#loading').hidden = true;
    clearTimeout(state.loadingTimer);
  }

  function showFatal(message) {
    hideLoading();
    $('#fatal').hidden = false;
    $('#fatal-text').textContent = message;
  }

  function updateHud(latlng) {
    if (!state.cfg || !state.cfg.ui.coords) {
      return;
    }
    var point = latlng || state.map.getCenter();
    state.lastLatLng = point;
    var zoom = Math.floor(state.map.getZoom());
    var tile = MC.lonLatToTile(point.lng, point.lat, zoom);
    $('#hud-lon').textContent = fmt(point.lng);
    $('#hud-lat').textContent = fmt(point.lat);
    $('#hud-tile').textContent = tile.z + ' / ' + tile.x + ' / ' + tile.y;
  }

  function renderChrome(cfg) {
    document.title = cfg.title || '离线地图';
    $('#app-title').textContent = cfg.title || '离线地图';
    $('#app-subtitle').textContent = cfg.subtitle ||
      (cfg.tile.tileSize + 'px · ' + cfg.tile.scheme.toUpperCase() + ' · zoom ' + cfg.tile.minZoom + '–' + cfg.tile.maxZoom);

    if (!cfg.ui.locate) {
      $('#btn-locate').hidden = true;
    }
    if (!cfg.ui.help) {
      $('#btn-help').hidden = true;
    }
    if (!cfg.ui.fullscreen || !document.documentElement.requestFullscreen) {
      $('#btn-fullscreen').hidden = true;
    }
    $('#hud').hidden = !cfg.ui.coords;
  }

  function tileLayerOptions(cfg) {
    var tile = cfg.tile;
    var options = {
      minZoom: tile.minZoom,
      maxZoom: tile.maxZoom,
      maxNativeZoom: tile.maxNativeZoom,
      tileSize: tile.tileSize,
      tms: tile.scheme === 'tms',
      detectRetina: !!tile.detectRetina,
      attribution: tile.attribution || '',
      errorTileUrl: 'assets/img/tile-missing.png',
      keepBuffer: 4,
      updateWhenIdle: false,
      crossOrigin: false
    };
    if (tile.subdomains.length) {
      options.subdomains = tile.subdomains;
    }
    return options;
  }

  function createMap(cfg) {
    var map = L.map('map', {
      center: cfg.view.center,
      zoom: cfg.view.zoom,
      minZoom: cfg.tile.minZoom,
      maxZoom: cfg.tile.maxZoom,
      zoomControl: false,
      attributionControl: true,
      worldCopyJump: true,
      zoomSnap: 1,
      zoomDelta: 1
    });
    state.map = map;

    if (map.attributionControl) {
      map.attributionControl.setPrefix('Leaflet');
    }

    if (cfg.ui.zoom) {
      L.control.zoom({
        position: 'topright',
        zoomInTitle: '放大',
        zoomOutTitle: '缩小'
      }).addTo(map);
    }

    if (cfg.ui.scale) {
      L.control.scale({
        position: 'bottomright',
        imperial: false,
        maxWidth: 140
      }).addTo(map);
    }

    var layer = L.tileLayer(cfg.tile.url, tileLayerOptions(cfg));
    state.layer = layer;

    var overlayLayers = {};
    cfg.overlays.forEach(function (item) {
      var name = item.name || ('图层 ' + (Object.keys(overlayLayers).length + 1));
      overlayLayers[name] = L.tileLayer(item.url, {
        minZoom: item.minZoom === undefined ? cfg.tile.minZoom : item.minZoom,
        maxZoom: item.maxZoom === undefined ? cfg.tile.maxZoom : item.maxZoom,
        maxNativeZoom: item.maxNativeZoom === undefined ? cfg.tile.maxNativeZoom : item.maxNativeZoom,
        tileSize: cfg.tile.tileSize,
        tms: item.scheme === 'tms',
        opacity: item.opacity === undefined ? 1 : item.opacity,
        attribution: item.attribution || '',
        errorTileUrl: 'assets/img/tile-missing.png'
      });
    });

    if (Object.keys(overlayLayers).length) {
      var baseLayers = {};
      baseLayers['底图'] = layer;
      L.control.layers(baseLayers, overlayLayers, {
        position: 'topright',
        collapsed: true
      }).addTo(map);
      layer.addTo(map);
    } else {
      layer.addTo(map);
    }

    layer.on('tileload', function () {
      state.loaded += 1;
      if (!state.firstTile) {
        state.firstTile = true;
        hideLoading();
      }
    });

    layer.on('tileerror', function () {
      state.errors += 1;
      if (!state.firstTile) {
        hideLoading();
      }
      if (state.errors === 1 || state.errors % 10 === 0) {
        showBanner('瓦片加载失败（' + state.errors + ' 个）。请确认瓦片服务已启动，且 config.js 中的 tile.url 可访问。', 'warn');
      }
    });

    layer.on('load', function () {
      hideLoading();
    });

    map.on('mousemove', function (event) {
      state.pointerInside = true;
      updateHud(event.latlng);
    });

    map.on('mouseout', function () {
      state.pointerInside = false;
      updateHud(map.getCenter());
    });

    map.on('move zoom', function () {
      if (!state.pointerInside) {
        updateHud(map.getCenter());
      }
    });

    map.on('click', function (event) {
      dropMarker(event.latlng);
    });

    if (window.ResizeObserver) {
      var observer = new ResizeObserver(function () {
        map.invalidateSize({ pan: false });
      });
      observer.observe($('#map'));
    }

    state.loadingTimer = setTimeout(function () {
      if (!state.firstTile && state.errors === 0) {
        hideLoading();
        showBanner('瓦片加载超时。请检查瓦片地址是否可访问，或先用浏览器直接打开一个瓦片 URL 验证。', 'warn');
      }
    }, 8000);

    updateHud(map.getCenter());
    return map;
  }

  function dropMarker(latlng) {
    var map = state.map;
    var marker = state.marker;
    if (!marker) {
      marker = L.marker(latlng, { keyboard: false }).addTo(map);
      state.marker = marker;
    } else {
      marker.setLatLng(latlng);
    }

    var zoom = Math.floor(map.getZoom());
    var tile = MC.lonLatToTile(latlng.lng, latlng.lat, zoom);
    var text = '经度 ' + fmt(latlng.lng) + ', 纬度 ' + fmt(latlng.lat) +
      ', 瓦片 ' + tile.z + '/' + tile.x + '/' + tile.y;

    var box = document.createElement('div');
    box.className = 'pin-popup';

    var title = document.createElement('div');
    title.className = 'pin-title';
    title.textContent = '选点坐标';
    box.appendChild(title);

    appendRow(box, '经度', fmt(latlng.lng));
    appendRow(box, '纬度', fmt(latlng.lat));
    appendRow(box, '瓦片', tile.z + ' / ' + tile.x + ' / ' + tile.y);

    var copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'pin-copy';
    copy.textContent = '复制坐标';
    copy.addEventListener('click', function () {
      copyText(text).then(function () {
        showToast('坐标已复制');
      }, function () {
        showToast('复制失败，请手动选择文本');
      });
    });
    box.appendChild(copy);

    marker.bindPopup(box, { closeButton: true, offset: [0, -34] }).openPopup();
    updateHud(latlng);
  }

  function appendRow(parent, label, value) {
    var row = document.createElement('div');
    row.className = 'pin-row';
    var key = document.createElement('span');
    key.textContent = label;
    var val = document.createElement('code');
    val.textContent = value;
    row.appendChild(key);
    row.appendChild(val);
    parent.appendChild(row);
  }

  function openDialog(dialog) {
    if (!dialog) {
      return;
    }
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) {
        dialog.showModal();
      }
    } else {
      dialog.setAttribute('open', '');
    }
  }

  function closeDialog(dialog) {
    if (!dialog) {
      return;
    }
    if (typeof dialog.close === 'function') {
      dialog.close();
    } else {
      dialog.removeAttribute('open');
    }
  }

  function isInteger(value) {
    return typeof value === 'number' && isFinite(value) && Math.floor(value) === value;
  }

  function parseTarget(raw) {
    var input = String(raw || '').trim();
    if (!input) {
      return { error: '请输入经纬度或瓦片编号' };
    }
    input = input.replace(/[，、；;]/g, ',').replace(/\s+/g, ' ');

    if (input.indexOf('/') !== -1) {
      var parts = input.split('/').map(function (part) { return part.trim(); });
      if (parts.length !== 3) {
        return { error: '瓦片编号格式应为 z/x/y，例如 5/26/12' };
      }
      var z = Number(parts[0]);
      var x = Number(parts[1]);
      var y = Number(parts[2]);
      if (!isInteger(z) || !isInteger(x) || !isInteger(y) || z < 0 || z > 24) {
        return { error: '瓦片编号必须是整数，且 z 在 0–24 之间' };
      }
      var count = Math.pow(2, z);
      if (x < 0 || x >= count || y < 0 || y >= count) {
        return { error: '该级别下 x、y 的范围是 0–' + (count - 1) };
      }
      var center = MC.tileCenter(x, y, z);
      return { lon: center.lon, lat: center.lat, zoom: z };
    }

    var pair = input.split(/[,\s]+/).filter(Boolean);
    if (pair.length !== 2) {
      return { error: '请输入两个数字（经度, 纬度），或 z/x/y' };
    }
    var first = Number(pair[0]);
    var second = Number(pair[1]);
    if (!isFinite(first) || !isFinite(second)) {
      return { error: '坐标必须是数字' };
    }
    var lon = first;
    var lat = second;
    if (Math.abs(lat) > 90 && Math.abs(first) <= 90) {
      lon = second;
      lat = first;
    }
    if (Math.abs(lon) > 180) {
      return { error: '经度需在 -180 – 180 之间' };
    }
    if (Math.abs(lat) > 90) {
      return { error: '纬度需在 -90 – 90 之间' };
    }
    return { lon: lon, lat: lat, zoom: null };
  }

  function openLocate() {
    var map = state.map;
    var dialog = $('#locate-dialog');
    var input = $('#locate-input');
    var center = map.getCenter();
    input.value = fmt(center.lng) + ', ' + fmt(center.lat);
    $('#locate-zoom').value = '';
    $('#locate-error').hidden = true;
    openDialog(dialog);
    setTimeout(function () {
      input.focus();
      input.select();
    }, 30);
  }

  function handleLocateSubmit(event) {
    event.preventDefault();
    var errorBox = $('#locate-error');
    var parsed = parseTarget($('#locate-input').value);
    if (parsed.error) {
      errorBox.textContent = parsed.error;
      errorBox.hidden = false;
      return;
    }

    var cfg = state.cfg;
    var zoom = state.map.getZoom();
    var rawZoom = $('#locate-zoom').value.trim();
    if (rawZoom) {
      zoom = Number(rawZoom);
      if (!isFinite(zoom) || zoom < cfg.tile.minZoom || zoom > cfg.tile.maxZoom) {
        errorBox.textContent = '缩放级别需在 ' + cfg.tile.minZoom + ' – ' + cfg.tile.maxZoom + ' 之间';
        errorBox.hidden = false;
        return;
      }
    }
    if (parsed.zoom !== null) {
      zoom = parsed.zoom;
    }
    if (zoom < cfg.tile.minZoom) {
      zoom = cfg.tile.minZoom;
    }
    if (zoom > cfg.tile.maxZoom) {
      zoom = cfg.tile.maxZoom;
    }

    state.map.flyTo([parsed.lat, parsed.lon], zoom, { duration: 0.7 });
    closeDialog($('#locate-dialog'));
    showToast('已定位到 ' + fmt(parsed.lon) + ', ' + fmt(parsed.lat));
  }

  function resetView() {
    if (!state.cfg) {
      return;
    }
    state.map.closePopup();
    state.map.flyTo(state.cfg.view.center, state.cfg.view.zoom, { duration: 0.7 });
  }

  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      var request = document.documentElement.requestFullscreen;
      if (request) {
        request.call(document.documentElement).catch(function () {
          showToast('当前浏览器不允许进入全屏');
        });
      }
    } else if (document.exitFullscreen) {
      document.exitFullscreen();
    }
  }

  function syncFullscreenLabel() {
    var button = $('#btn-fullscreen');
    var active = !!document.fullscreenElement;
    button.title = (active ? '退出全屏' : '全屏') + '（快捷键 F）';
    var label = button.querySelector('span');
    if (label) {
      label.textContent = active ? '退出' : '全屏';
    }
  }

  function bindUI(cfg) {
    var map = state.map;

    $('#btn-locate').addEventListener('click', openLocate);
    $('#btn-reset').addEventListener('click', resetView);
    $('#btn-fullscreen').addEventListener('click', toggleFullscreen);
    $('#btn-help').addEventListener('click', function () {
      fillHelp();
      openDialog($('#help-dialog'));
    });

    $('#locate-form').addEventListener('submit', handleLocateSubmit);
    $('#locate-cancel').addEventListener('click', function () {
      closeDialog($('#locate-dialog'));
    });
    $('#help-close').addEventListener('click', function () {
      closeDialog($('#help-dialog'));
    });

    ['locate-dialog', 'help-dialog'].forEach(function (id) {
      var dialog = document.getElementById(id);
      dialog.addEventListener('click', function (event) {
        if (event.target === dialog) {
          closeDialog(dialog);
        }
      });
    });

    $('#banner-close').addEventListener('click', hideBanner);
    $('#banner-retry').addEventListener('click', function () {
      hideBanner();
      state.loaded = 0;
      state.errors = 0;
      state.firstTile = false;
      $('#loading').hidden = false;
      state.layer.redraw();
    });

    $('#hud-copy').addEventListener('click', function () {
      if (!state.lastLatLng) {
        return;
      }
      var point = state.lastLatLng;
      var zoom = Math.floor(map.getZoom());
      var tile = MC.lonLatToTile(point.lng, point.lat, zoom);
      var text = '经度 ' + fmt(point.lng) + ', 纬度 ' + fmt(point.lat) +
        ', 瓦片 ' + tile.z + '/' + tile.x + '/' + tile.y + ', EPSG:3857';
      copyText(text).then(function () {
        showToast('坐标已复制');
      }, function () {
        showToast('复制失败，请手动选择文本');
      });
    });

    document.addEventListener('fullscreenchange', syncFullscreenLabel);

    document.addEventListener('keydown', function (event) {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) {
        return;
      }
      var target = event.target;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) {
        return;
      }
      if (document.querySelector('dialog[open]')) {
        return;
      }
      var key = String(event.key || '').toLowerCase();
      if (key === '?' || key === '/') {
        event.preventDefault();
        fillHelp();
        openDialog($('#help-dialog'));
      } else if (key === 'l') {
        openLocate();
      } else if (key === 'r') {
        resetView();
      } else if (key === 'f') {
        toggleFullscreen();
      }
    });

    if (location.protocol === 'https:' && /^http:\/\//i.test(cfg.tile.url)) {
      showBanner('页面是 HTTPS，但瓦片地址是 HTTP，浏览器会拦截混合内容。请改用 HTTPS 瓦片，或通过同源反向代理转发（见 deploy/nginx.conf）。', 'error', { noRetry: true });
    }
  }

  function fillHelp() {
    var cfg = state.cfg;
    $('#help-url').textContent = cfg.tile.url;
    $('#help-crs').textContent = 'EPSG:3857 · ' + cfg.tile.scheme.toUpperCase() + '（原点' +
      (cfg.tile.scheme === 'tms' ? '左下' : '左上') + '，y 向' + (cfg.tile.scheme === 'tms' ? '北' : '南') + '）';
    $('#help-tilesize').textContent = cfg.tile.tileSize + ' × ' + cfg.tile.tileSize + ' 像素';
    var zoomText = cfg.tile.minZoom + ' – ' + cfg.tile.maxZoom;
    if (cfg.tile.maxNativeZoom < cfg.tile.maxZoom) {
      zoomText += '（瓦片实际到 ' + cfg.tile.maxNativeZoom + ' 级，更高层级为前端放大）';
    }
    $('#help-zoom').textContent = zoomText;
    $('#help-view').textContent = fmt(cfg.view.center[1]) + ', ' + fmt(cfg.view.center[0]) + ' · zoom ' + cfg.view.zoom;
  }

  function boot() {
    state.cfg = null;
    var cfg;
    try {
      var raw = deepMerge(DEFAULTS, window.MAP_CONFIG || {});
      applyQuery(raw, window.location.search);
      cfg = normalizeConfig(raw);
    } catch (err) {
      renderChrome(deepMerge(DEFAULTS, {}));
      showFatal(err.message);
      return;
    }

    state.cfg = cfg;
    renderChrome(cfg);
    fillHelp();

    try {
      createMap(cfg);
    } catch (err) {
      showFatal('地图初始化失败：' + err.message);
      if (window.console) {
        console.error(err);
      }
      return;
    }

    bindUI(cfg);

    // 便于联调时在控制台查看状态
    window.__mapDebug = {
      map: state.map,
      layer: state.layer,
      config: cfg,
      stats: function () {
        return { loaded: state.loaded, errors: state.errors };
      }
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
