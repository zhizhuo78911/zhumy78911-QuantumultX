/**
 * 红果短剧（com.phoenix.read）接口广告清理脚本
 * ------------------------------------------------------------------
 * 适用：Quantumult X（rewrite: script-response-body）
 *       Loon / Surge / Stash 亦可复用（$response.body 与 $done 接口一致）
 * 仓库：https://github.com/zhizhuo78911/zhumy78911-QuantumultX
 *
 * 作用：红果把「开屏广告、信息流广告卡、电商卡片、贴片广告位」
 *       混在 /reading/ 系列接口的 JSON 里下发。本脚本在响应返回
 *       手机前把这些广告字段/广告条目摘掉，App 就无广告可渲染。
 *
 * 原则：只做「删除」，绝不新增或改写字段结构；任何一个环节出错
 *       都原样返回，保证不影响正常看剧。
 * ------------------------------------------------------------------
 */

var CONFIG = {
  enabled: true,        // 总开关：false 时脚本完全不动作
  debug: false,         // true：在 Quantumult X 日志里打印清理统计（排查用）
  notify: false,        // true：清理后发系统通知（仅调试，正式用请关）
  removeAdItems: true,  // 从数组里删除广告条目
  removeAdKeys: true,   // 删除对象里的广告字段
  maxDepth: 32          // 递归深度保护，防止异常结构导致卡死
};

/**
 * 广告字段名单（全部小写比较）。
 * 只收录“确定属于广告/商业化”的字段，
 * 不采用 ad 前缀模糊匹配，避免误删 address / advance 这类词。
 */
var AD_KEYS = [
  'ad', 'ads', 'ad_id', 'ad_type', 'ad_info', 'ad_data', 'ad_source',
  'ad_style', 'ad_tag', 'ad_label', 'ad_url', 'ad_title', 'ad_desc',
  'ad_logo', 'ad_img', 'ad_image', 'ad_images', 'ad_video', 'ad_video_url',
  'ad_count', 'ad_num', 'ad_index', 'ad_duration', 'ad_position',
  'ad_landing_url', 'ad_click_url', 'ad_track_url', 'ad_callback',
  'ad_expire_time', 'ad_expired_time', 'ad_show_time', 'ad_close_time',
  'ad_slot_id', 'ad_slot', 'ad_unit_id', 'ad_request_id', 'ad_response',
  'is_ad', 'is_ads', 'is_advert', 'is_advertisement', 'is_ad_video',
  'advert', 'adverts', 'advert_info', 'advert_data', 'advert_list',
  'advertisement', 'advertisement_info', 'advertisement_data',
  'commercial', 'commercial_info', 'commercial_data', 'commercial_type',
  'shop_card', 'shop_card_info', 'shop_entrance', 'shop_half_card',
  'ecom', 'ecom_info', 'ecom_card', 'ecom_product', 'ecom_shop',
  'ecommerce', 'ecommerce_info', 'ecommerce_card',
  'promotion', 'promotion_info', 'promotion_card', 'promotion_data',
  'brand_ad', 'brand_ad_info', 'brand_commercial',
  'ad_pattern', 'ad_pattern_info', 'ad_union', 'ad_union_info'
];

/**
 * 「标记型」字段：这些字段本身不为空才代表广告，
 * 值为 0 / false / "" 时是正常数据（例如 ad_type=0 = 不是广告），必须保留。
 * 其余广告字段（ad_info / ad_data / ad_url ...）一律删除。
 */
var AD_FLAG_KEYS = [
  'is_ad', 'is_ads', 'is_advert', 'is_advertisement', 'is_ad_video',
  'ad', 'ads', 'ad_id', 'ad_type', 'ad_count', 'ad_num', 'ad_index',
  'ad_duration', 'ad_position', 'commercial', 'commercial_type',
  'ecom', 'ecommerce', 'promotion', 'brand_ad', 'advert', 'adverts',
  'advertisement'
];

/** 判定「这条数据是广告」时看的字段（值真即为广告） */
var AD_MARKER_KEYS = [
  'ad_type', 'ad_info', 'ad_data', 'ad_id', 'ad_source', 'is_ad',
  'is_advert', 'advert_info', 'advertisement_info', 'commercial_info',
  'ad_slot_id', 'ad_unit_id', 'shop_card', 'shop_card_info', 'ecom_info',
  'promotion_info', 'brand_ad', 'brand_ad_info'
];

var STATS = { removedKeys: 0, removedItems: 0, changed: false };

/** 判断标记字段的值是否表示「这是广告」 */
function isTruthyMarker(v) {
  if (v === null || v === undefined) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v > 0;
  if (typeof v === 'string') {
    var s = v.trim().toLowerCase();
    if (!s) return false;
    return s !== '0' && s !== 'false' && s !== 'null';
  }
  if (typeof v === 'object') {
    if (Array.isArray(v)) return v.length > 0;
    for (var k in v) {
      if (Object.prototype.hasOwnProperty.call(v, k)) return true;
    }
    return false;
  }
  return false;
}

/** 一个对象是否带有广告标记 */
function looksLikeAd(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  for (var i = 0; i < AD_MARKER_KEYS.length; i++) {
    var key = AD_MARKER_KEYS[i];
    if (Object.prototype.hasOwnProperty.call(obj, key) &&
        isTruthyMarker(obj[key])) {
      return true;
    }
  }
  return false;
}

function isAdKey(key) {
  return AD_KEYS.indexOf(String(key).toLowerCase()) !== -1;
}

/** 命中广告字段后，判断这个字段是否该删 */
function shouldDropKey(key, value) {
  var k = String(key).toLowerCase();
  if (AD_FLAG_KEYS.indexOf(k) !== -1) {
    // 标记型字段：只有真的表示“是广告”才删，ad_type=0 这类正常值保留
    return isTruthyMarker(value);
  }
  return true;
}

/**
 * 递归清理：返回 true 表示该节点被整体删除
 */
function clean(node, depth) {
  if (depth > CONFIG.maxDepth) return false;
  if (node === null || typeof node !== 'object') return false;

  if (Array.isArray(node)) {
    for (var i = node.length - 1; i >= 0; i--) {
      var item = node[i];
      // 广告条目（数组元素本身就是一个广告对象）
      if (CONFIG.removeAdItems && looksLikeAd(item)) {
        node.splice(i, 1);
        STATS.removedItems++;
        STATS.changed = true;
        continue;
      }
      // 元素是对象/数组时继续往下清
      if (item && typeof item === 'object') {
        if (clean(item, depth + 1)) {
          node.splice(i, 1);
          STATS.removedKeys++;
          STATS.changed = true;
        }
      }
    }
    return false;
  }

  // 普通对象
  for (var k in node) {
    if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
    if (CONFIG.removeAdKeys && isAdKey(k) && shouldDropKey(k, node[k])) {
      delete node[k];
      STATS.removedKeys++;
      STATS.changed = true;
      continue;
    }
    var v = node[k];
    if (v && typeof v === 'object') clean(v, depth + 1);
  }
  return false;
}

/** 供外部（含单元测试）调用 */
function sanitize(obj) {
  STATS = { removedKeys: 0, removedItems: 0, changed: false };
  if (CONFIG.enabled && obj && typeof obj === 'object') {
    clean(obj, 0);
  }
  return { body: obj, stats: STATS };
}

function report(url) {
  if (!STATS.changed) return;
  var msg = '[红果去广告] ' + STATS.removedKeys + ' 个广告字段 / ' +
            STATS.removedItems + ' 个广告条目 已移除';
  if (CONFIG.debug) {
    console.log(msg + ' | ' + (url || ''));
  }
  if (CONFIG.notify && typeof $notify === 'function') {
    $notify('红果短剧 去广告', msg, '');
  }
}

/** Quantumult X / Loon / Surge 入口 */
function main() {
  var raw = (typeof $response !== 'undefined' && $response) ? $response.body : null;
  if (typeof raw !== 'string' || !raw) {
    $done({});
    return;
  }
  // 只处理 JSON，其它类型（图片/视频/HTML）原样放行
  var trimmed = raw.replace(/^\uFEFF/, '').trim();
  if (trimmed.charAt(0) !== '{' && trimmed.charAt(0) !== '[') {
    $done({});
    return;
  }
  var data;
  try {
    data = JSON.parse(trimmed);
  } catch (e) {
    if (CONFIG.debug) console.log('[红果去广告] JSON 解析失败，原样返回：' + e);
    $done({});
    return;
  }
  sanitize(data);
  if (!STATS.changed) {
    $done({});
    return;
  }
  report(typeof $request !== 'undefined' && $request ? $request.url : '');
  $done({ body: JSON.stringify(data) });
}

// 运行时入口 / 测试入口
if (typeof $response !== 'undefined' && typeof $done === 'function') {
  main();
} else if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    CONFIG: CONFIG,
    AD_KEYS: AD_KEYS,
    sanitize: sanitize,
    looksLikeAd: looksLikeAd,
    clean: clean
  };
}
