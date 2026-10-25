/*
 * 坐标与瓦片换算（EPSG:3857 / Web Mercator，XYZ 方案）
 *
 * 约定与内网瓦片服务一致：
 *   - 原点在左上角（西北），x 向东增大，y 向南增大；
 *   - 瓦片边长默认 256px；
 *   - 第 z 级共有 2^z × 2^z 张瓦片。
 *
 * 该文件同时支持浏览器（window.MapCoord）与 Node（require）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.MapCoord = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var R = 6378137; // WGS84 长半轴，Web Mercator 使用球体近似
  var MAX_LAT = 85.0511287798066; // Web Mercator 的纬度上限
  var WORLD = Math.PI * R; // 20037508.342789244，半个世界宽度（米）
  var TILE_SIZE = 256;

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function clampLat(lat) {
    return clamp(lat, -MAX_LAT, MAX_LAT);
  }

  function toRad(deg) {
    return (deg * Math.PI) / 180;
  }

  function toDeg(rad) {
    return (rad * 180) / Math.PI;
  }

  /** 经纬度 -> EPSG:3857 平面坐标（米） */
  function lonLatToMeters(lon, lat) {
    lat = clampLat(lat);
    return {
      x: R * toRad(lon),
      y: R * Math.log(Math.tan(Math.PI / 4 + toRad(lat) / 2))
    };
  }

  /** EPSG:3857 平面坐标（米）-> 经纬度 */
  function metersToLonLat(x, y) {
    return {
      lon: toDeg(x / R),
      lat: toDeg(2 * Math.atan(Math.exp(y / R)) - Math.PI / 2)
    };
  }

  /** 某缩放级别下 1 像素代表的地面距离（米/像素，赤道处） */
  function resolution(zoom, tileSize) {
    return (2 * WORLD) / ((tileSize || TILE_SIZE) * Math.pow(2, zoom));
  }

  function tilesPerSide(zoom) {
    return Math.pow(2, zoom);
  }

  /** 经纬度 -> 瓦片编号（左上原点，y 向南） */
  function lonLatToTile(lon, lat, zoom, tileSize) {
    var n = tilesPerSide(zoom);
    var latRad = toRad(clampLat(lat));
    var x = Math.floor(((lon + 180) / 360) * n);
    var y = Math.floor(
      ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n
    );
    return {
      x: clamp(x, 0, n - 1),
      y: clamp(y, 0, n - 1),
      z: zoom
    };
  }

  /** 瓦片编号 -> 该瓦片覆盖的经纬度范围 */
  function tileBounds(x, y, zoom) {
    var n = tilesPerSide(zoom);
    return {
      west: (x / n) * 360 - 180,
      east: ((x + 1) / n) * 360 - 180,
      north: toDeg(Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)))),
      south: toDeg(Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n))))
    };
  }

  /** 瓦片中心点经纬度 */
  function tileCenter(x, y, zoom) {
    var b = tileBounds(x, y, zoom);
    return {
      lon: (b.west + b.east) / 2,
      lat: (b.north + b.south) / 2
    };
  }

  function formatNumber(value, digits) {
    return Number(value).toFixed(digits == null ? 6 : digits);
  }

  return {
    R: R,
    MAX_LAT: MAX_LAT,
    WORLD: WORLD,
    TILE_SIZE: TILE_SIZE,
    clamp: clamp,
    clampLat: clampLat,
    lonLatToMeters: lonLatToMeters,
    metersToLonLat: metersToLonLat,
    resolution: resolution,
    tilesPerSide: tilesPerSide,
    lonLatToTile: lonLatToTile,
    tileBounds: tileBounds,
    tileCenter: tileCenter,
    formatNumber: formatNumber
  };
});
