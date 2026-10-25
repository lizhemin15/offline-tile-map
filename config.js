/*
 * 地图运行时配置
 *
 * 部署后直接修改本文件即可生效，不需要重新构建。
 * 默认配置指向仓库自带的演示瓦片（demo/tiles，仅 0-3 级），
 * 接入内网瓦片服务时，只需要修改 tile.url（以及缩放级别）。
 */
window.MAP_CONFIG = {
  title: '内网离线地图',
  subtitle: 'EPSG:3857 · XYZ 瓦片 · 256px',

  tile: {
    // 瓦片地址模板，必须包含 {z}、{x}、{y}
    // 内网服务示例：
    //   url: 'http://<瓦片服务器IP>:12345/map/gsm/{z}/{x}/{y}.jpg'
    // 反代同源示例：
    //   url: '/tiles/map/gsm/{z}/{x}/{y}.jpg'
    url: 'demo/tiles/{z}/{x}/{y}.jpg',

    // 界面允许的最小 / 最大缩放级别
    minZoom: 0,
    maxZoom: 11,

    // 瓦片服务真实存在的最大级别。超过该级别时前端会放大已有瓦片，
    // 避免向服务请求不存在的 z。若服务已提供到 11 级，这里填 11。
    maxNativeZoom: 3,

    // 瓦片边长（像素），协议约定 256
    tileSize: 256,

    // 'xyz'：原点左上，y 向南（本协议）；'tms'：原点左下，y 向北
    scheme: 'xyz',

    // 若 URL 中使用 {s} 占位符，可配置子域，例如 ['a', 'b', 'c']
    subdomains: [],

    // 高分屏下是否按 2 倍分辨率请求（要求服务端支持 {r} 或更高层级）
    detectRetina: false,

    // 版权 / 来源说明，显示在地图右下角
    attribution: '瓦片来源：内网 XYZ 服务'
  },

  view: {
    // 初始中心点 [纬度, 经度]
    center: [0, 0],
    // 初始缩放级别
    zoom: 3
  },

  ui: {
    coords: true,      // 经纬度 / 瓦片编号读数
    scale: true,       // 比例尺
    zoom: true,        // 缩放按钮
    locate: true,      // 定位按钮
    help: true,        // 帮助按钮
    fullscreen: true   // 全屏按钮
  },

  // 可选叠加图层，例如标注、影像、业务专题图
  // overlays: [
  //   { name: '影像底图', url: 'http://10.0.0.8:8080/img/{z}/{x}/{y}.png', opacity: 1 },
  //   { name: '标注', url: '/tiles/labels/{z}/{x}/{y}.png', opacity: 0.9 }
  // ]
  overlays: []
};
