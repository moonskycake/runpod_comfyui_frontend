/**
 * 后台预览图本地编辑：内容校验 / 16:9 构图几何 / 成品渲染与压缩。
 *
 * 设计约束（与服务端 catalog_service/images.py 严格对齐）：
 * - 输入 ≤ 5 MiB、≤ 16_000_000 像素（不是 16*1024*1024），静态 PNG / JPEG / WebP；
 *   动画图（PNG acTL / WebP ANIM）在解码前按字节拒绝，不只信 MIME 或扩展名。
 * - 成品固定 16:9（默认 480×270），长边 ≤ 480 px、≤ 64 KiB WebP；
 *   透明区域以白底填充，与服务端 flatten 结果一致。
 * - 原图只存在于当前编辑会话：位图由调用方持有并负责 releasePicture。
 *
 * UMD：浏览器挂 window.CatalogImageEditor，Node 可直接 require 做无依赖测试。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.CatalogImageEditor = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var STAGE_ASPECT = 16 / 9;
  /** 舞台高度（以舞台宽度为 1 个单位）。 */
  var STAGE_HEIGHT = 9 / 16;
  var LIMITS = {
    maxInputBytes: 5 * 1024 * 1024,
    maxPixels: 16000000,
    maxSide: 480,
    maxOutputBytes: 64 * 1024,
    stageWidth: 480,
    stageHeight: 270,
    minZoom: 1,
    maxZoom: 4,
    outputMime: 'image/webp'
  };
  var ACCEPT_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
  var ACCEPT_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'];
  // 与服务端 _QUALITY_STEPS / _SHRINK_STEP / 8 轮收缩保持一致。
  var QUALITY_STEPS = [0.82, 0.74, 0.66, 0.58, 0.5, 0.42, 0.34];
  var SHRINK_STEP = 0.85;
  var MAX_SHRINK_ROUNDS = 8;
  var WHITE = '#ffffff';

  // ---------------------------------------------------------------- 字节嗅探

  function toBytes(input) {
    if (!input) return null;
    if (typeof Uint8Array !== 'undefined' && input instanceof Uint8Array) return input;
    if (typeof ArrayBuffer !== 'undefined' && input instanceof ArrayBuffer) return new Uint8Array(input);
    if (Array.isArray(input)) return Uint8Array.from(input);
    if (input.buffer && typeof input.byteLength === 'number') {
      return new Uint8Array(input.buffer, input.byteOffset || 0, input.byteLength);
    }
    return null;
  }

  function ascii(bytes, offset, length) {
    if (offset + length > bytes.length) return '';
    var out = '';
    for (var i = 0; i < length; i += 1) out += String.fromCharCode(bytes[offset + i]);
    return out;
  }

  function u32be(bytes, offset) {
    return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
  }

  function u32le(bytes, offset) {
    return (bytes[offset] | (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
  }

  var PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

  function hasPngSignature(bytes) {
    if (bytes.length < 8) return false;
    for (var i = 0; i < PNG_SIGNATURE.length; i += 1) {
      if (bytes[i] !== PNG_SIGNATURE[i]) return false;
    }
    return true;
  }

  function pngHasChunk(bytes, name) {
    var offset = 8;
    for (var guard = 0; guard < 4096 && offset + 8 <= bytes.length; guard += 1) {
      var length = u32be(bytes, offset);
      var type = ascii(bytes, offset + 4, 4);
      if (type === name) return true;
      if (type === 'IEND') return false;
      var next = offset + 12 + length;
      if (next <= offset || next > bytes.length) return false;
      offset = next;
    }
    return false;
  }

  function webpIsAnimated(bytes) {
    var offset = 12;
    for (var guard = 0; guard < 4096 && offset + 8 <= bytes.length; guard += 1) {
      var fourcc = ascii(bytes, offset, 4);
      var size = u32le(bytes, offset + 4);
      if (fourcc === 'ANIM' || fourcc === 'ANMF') return true;
      if (fourcc === 'VP8X' && size >= 1 && offset + 8 < bytes.length) {
        // VP8X 标志位 bit1 = animation
        if ((bytes[offset + 8] & 0x02) !== 0) return true;
      }
      var next = offset + 8 + size + (size % 2);
      if (next <= offset || next > bytes.length) return false;
      offset = next;
    }
    return false;
  }

  /**
   * 按内容判定图片类型（MIME / 扩展名只作提示）。
   * @returns {{ok:boolean, kind:string, animated:boolean, error:string}}
   */
  function classifyImageBytes(input) {
    var bytes = toBytes(input);
    if (!bytes || !bytes.length) {
      return { ok: false, kind: '', animated: false, error: '图片文件为空或无法读取' };
    }
    var kind = '';
    var animated = false;
    if (hasPngSignature(bytes)) {
      kind = 'png';
      animated = pngHasChunk(bytes, 'acTL');
    } else if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
      kind = 'webp';
      animated = webpIsAnimated(bytes);
    } else if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
      kind = 'jpeg';
    } else {
      return {
        ok: false,
        kind: '',
        animated: false,
        error: '仅支持静态 PNG / JPEG / WebP 图片（不接受 SVG / GIF / AVIF / 动画图）'
      };
    }
    if (animated) {
      return {
        ok: false,
        kind: kind,
        animated: true,
        error: '不支持动画图片（APNG / 动态 WebP），请换一张静态图'
      };
    }
    return { ok: true, kind: kind, animated: false, error: '' };
  }

  function fileExtension(name) {
    var value = String(name || '').toLowerCase();
    var index = value.lastIndexOf('.');
    return index >= 0 ? value.slice(index) : '';
  }

  /**
   * 选择后的第一道预检：MIME / 扩展名 / 大小。真正格式以字节嗅探与解码为准。
   */
  function validatePictureFile(file) {
    if (!file || typeof file !== 'object') return { ok: false, error: '请选择图片文件' };
    var type = String(file.type || '').toLowerCase().trim();
    if (type && type !== 'application/octet-stream' && ACCEPT_TYPES.indexOf(type) < 0) {
      return { ok: false, error: '仅支持静态 PNG / JPEG / WebP 图片（不接受 SVG / GIF / AVIF 等）' };
    }
    if (!type) {
      var ext = fileExtension(file.name);
      if (ext && ACCEPT_EXTENSIONS.indexOf(ext) < 0) {
        return { ok: false, error: '仅支持 PNG / JPEG / WebP 文件，当前扩展名 ' + ext };
      }
    }
    var size = Number(file.size);
    if (!isFinite(size) || size <= 0) return { ok: false, error: '图片文件为空或无法读取' };
    if (size > LIMITS.maxInputBytes) {
      return { ok: false, error: '图片超过 5 MiB，请先压缩或换一张更小的图片' };
    }
    return { ok: true, error: '' };
  }

  /**
   * 解码后的权威校验：类型、动画、像素上限（与服务端一致的 16_000_000）。
   */
  function validateDecodedPicture(meta) {
    var m = meta || {};
    var kind = String(m.kind || '');
    if (ACCEPT_TYPES.indexOf('image/' + kind) < 0) {
      return { ok: false, error: '仅支持静态 PNG / JPEG / WebP 图片' };
    }
    if (m.animated) return { ok: false, error: '不支持动画图片（APNG / 动态 WebP），请换一张静态图' };
    var width = Number(m.width);
    var height = Number(m.height);
    if (!isFinite(width) || !isFinite(height) || width < 1 || height < 1 ||
      Math.trunc(width) !== width || Math.trunc(height) !== height) {
      return { ok: false, error: '无法读取图片尺寸' };
    }
    if (width * height > LIMITS.maxPixels) {
      return {
        ok: false,
        error: '图片像素超过 16 MP（' + LIMITS.maxPixels + ' 像素），请先缩小后再上传'
      };
    }
    return { ok: true, error: '' };
  }

  // ---------------------------------------------------------------- 构图几何
  // 坐标系：舞台宽度 = 1 个单位，高度 = STAGE_HEIGHT；偏移量同为舞台单位。

  function clamp(value, min, max) {
    if (!isFinite(value)) return min;
    return Math.min(max, Math.max(min, value));
  }

  function numberOr(value, fallback) {
    var n = Number(value);
    return isFinite(n) ? n : fallback;
  }

  function safeSide(value) {
    var n = Number(value);
    if (!isFinite(n) || n <= 0) return 1;
    return n;
  }

  function clampZoom(value) {
    var n = Number(value);
    if (!isFinite(n)) return LIMITS.minZoom;
    return clamp(n, LIMITS.minZoom, LIMITS.maxZoom);
  }

  function normalizeMode(mode) {
    return mode === 'contain' ? 'contain' : 'cover';
  }

  function geometryDefaults(mode) {
    return { mode: normalizeMode(mode || 'cover'), zoom: 1, offsetX: 0, offsetY: 0 };
  }

  /**
   * 基础绘制尺寸（单位：舞台宽度）。cover 至少覆盖舞台，contain 完整显示。
   */
  function baseDrawSize(mode, srcWidth, srcHeight) {
    var sw = safeSide(srcWidth);
    var sh = safeSide(srcHeight);
    var ratio = sw / sh;
    var fitWidth = STAGE_HEIGHT * ratio;
    var width = normalizeMode(mode) === 'cover'
      ? Math.max(1, fitWidth)
      : Math.min(1, fitWidth);
    return { width: width, height: width / ratio };
  }

  function offsetLimits(mode, zoom, srcWidth, srcHeight) {
    var size = baseDrawSize(mode, srcWidth, srcHeight);
    return {
      x: Math.max(0, (size.width * zoom - 1) / 2),
      y: Math.max(0, (size.height * zoom - STAGE_HEIGHT) / 2)
    };
  }

  /**
   * 规范化构图：模式、缩放夹紧到 [1, 4]，偏移不超过边缘（不露出白边）。
   * contain（完整显示）固定 1 倍、居中：放大必然裁掉内容，与文案矛盾。
   */
  function normalizeGeometry(geom, srcWidth, srcHeight) {
    var g = geom || {};
    var mode = normalizeMode(g.mode);
    if (mode === 'contain') return { mode: 'contain', zoom: 1, offsetX: 0, offsetY: 0 };
    var zoom = clampZoom(g.zoom);
    var limits = offsetLimits(mode, zoom, srcWidth, srcHeight);
    return {
      mode: mode,
      zoom: zoom,
      offsetX: clamp(numberOr(g.offsetX, 0), -limits.x, limits.x),
      offsetY: clamp(numberOr(g.offsetY, 0), -limits.y, limits.y)
    };
  }

  function resetGeometry(mode, srcWidth, srcHeight) {
    return normalizeGeometry(geometryDefaults(mode), srcWidth, srcHeight);
  }

  /**
   * 以舞台内某点为中心缩放（默认舞台中心），保证该点下的画面内容基本不动。
   */
  function zoomAt(geom, nextZoom, srcWidth, srcHeight, point) {
    var current = normalizeGeometry(geom, srcWidth, srcHeight);
    var target = clampZoom(nextZoom);
    if (target === current.zoom) return current;
    var anchor = point && isFinite(Number(point.x)) && isFinite(Number(point.y))
      ? { x: Number(point.x), y: Number(point.y) }
      : { x: 0.5, y: STAGE_HEIGHT / 2 };
    var centerX = 0.5 + current.offsetX;
    var centerY = STAGE_HEIGHT / 2 + current.offsetY;
    var ratio = target / current.zoom;
    var next = {
      mode: current.mode,
      zoom: target,
      offsetX: anchor.x - (anchor.x - centerX) * ratio - 0.5,
      offsetY: anchor.y - (anchor.y - centerY) * ratio - STAGE_HEIGHT / 2
    };
    return normalizeGeometry(next, srcWidth, srcHeight);
  }

  function panBy(geom, dx, dy, srcWidth, srcHeight) {
    var current = normalizeGeometry(geom, srcWidth, srcHeight);
    return normalizeGeometry({
      mode: current.mode,
      zoom: current.zoom,
      offsetX: current.offsetX + Number(dx || 0),
      offsetY: current.offsetY + Number(dy || 0)
    }, srcWidth, srcHeight);
  }

  /** 图片在舞台中的目标矩形（舞台单位）。 */
  function destinationRect(geom, srcWidth, srcHeight) {
    var g = normalizeGeometry(geom, srcWidth, srcHeight);
    var size = baseDrawSize(g.mode, srcWidth, srcHeight);
    var width = size.width * g.zoom;
    var height = size.height * g.zoom;
    return {
      x: (1 - width) / 2 + g.offsetX,
      y: (STAGE_HEIGHT - height) / 2 + g.offsetY,
      width: width,
      height: height
    };
  }

  function canPan(geom, srcWidth, srcHeight) {
    var g = normalizeGeometry(geom, srcWidth, srcHeight);
    if (g.mode === 'contain') return false;
    var limits = offsetLimits(g.mode, g.zoom, srcWidth, srcHeight);
    return limits.x > 0 || limits.y > 0;
  }

  function canZoom(geom) {
    return normalizeMode((geom || {}).mode) !== 'contain';
  }

  // ------------------------------------------------------------ 渲染与成品

  /** 16:9 画面在给定画布里的位置（用于 1:1 缩略图的完整显示）。 */
  function frameRect(canvasWidth, canvasHeight) {
    var cw = Number(canvasWidth);
    var ch = Number(canvasHeight);
    if (!isFinite(cw) || !isFinite(ch) || cw <= 0 || ch <= 0) return null;
    var width;
    var height;
    if (cw / ch > STAGE_ASPECT) {
      height = ch;
      width = ch * STAGE_ASPECT;
    } else {
      width = cw;
      height = cw / STAGE_ASPECT;
    }
    return { x: (cw - width) / 2, y: (ch - height) / 2, width: width, height: height };
  }

  /** 像素坐标下的画面与图片矩形；无法计算时返回 null。 */
  function compositionRects(geom, srcWidth, srcHeight, canvasWidth, canvasHeight) {
    var frame = frameRect(canvasWidth, canvasHeight);
    if (!frame) return null;
    var rect = destinationRect(geom, srcWidth, srcHeight);
    var scale = frame.width;
    return {
      frame: frame,
      image: {
        x: Math.round(frame.x + rect.x * scale),
        y: Math.round(frame.y + rect.y * scale),
        width: Math.max(1, Math.round(rect.width * scale)),
        height: Math.max(1, Math.round(rect.height * scale))
      }
    };
  }

  /**
   * 把构图画到任意画布：白底（透明图/contain 留边与服务端一致）+ 图片。
   */
  function renderComposition(canvas, picture, geom, options) {
    var opts = options || {};
    if (!canvas || !picture) return false;
    var source = picture.bitmap || picture;
    var srcWidth = Number(picture.width || source.width || source.naturalWidth);
    var srcHeight = Number(picture.height || source.height || source.naturalHeight);
    var cw = Number(canvas.width);
    var ch = Number(canvas.height);
    var rects = compositionRects(geom, srcWidth, srcHeight, cw, ch);
    if (!rects) return false;
    var ctx = canvas.getContext ? canvas.getContext('2d') : null;
    if (!ctx) return false;
    if (ctx.save) ctx.save();
    if (ctx.setTransform) ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = WHITE;
    ctx.fillRect(0, 0, cw, ch);
    // 只允许画到 16:9 画面内：1:1 缩略图里 cover 竖图必须裁切，
    // 不能把画面外的像素画到方图区域。
    var frame = rects.frame;
    if (ctx.beginPath && ctx.rect && ctx.clip) {
      ctx.beginPath();
      ctx.rect(frame.x, frame.y, frame.width, frame.height);
      ctx.clip();
    }
    if (opts.smoothing !== false && 'imageSmoothingQuality' in ctx) {
      ctx.imageSmoothingQuality = 'high';
    }
    ctx.drawImage(source, rects.image.x, rects.image.y, rects.image.width, rects.image.height);
    if (ctx.restore) ctx.restore();
    return true;
  }

  function productSize() {
    return { width: LIMITS.stageWidth, height: LIMITS.stageHeight };
  }

  function shrinkSize(size) {
    var width = Math.max(16, Math.round(Number(size && size.width || LIMITS.stageWidth) * SHRINK_STEP));
    var height = Math.max(9, Math.round((width * 9) / 16));
    return { width: width, height: height };
  }

  function canvasToBlob(canvas, quality) {
    return new Promise(function (resolve, reject) {
      if (!canvas || typeof canvas.toBlob !== 'function') {
        reject(new Error('当前浏览器不支持图片压缩'));
        return;
      }
      try {
        canvas.toBlob(function (blob) {
          resolve(blob || null);
        }, LIMITS.outputMime, quality);
      } catch (err) {
        reject(new Error('图片压缩失败：' + (err && err.message ? err.message : '未知错误')));
      }
    });
  }

  function defaultCreateCanvas(doc) {
    return function (width, height) {
      var canvas = doc.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      return canvas;
    };
  }

  /**
   * 导出 16:9 成品：先按质量阶梯尝试，超限再等比收缩，最多 8 轮。
   * @returns {Promise<{blob: Blob, width:number, height:number, bytes:number, mime:string}>}
   */
  async function exportPicture(picture, geom, env) {
    var e = env || {};
    var doc = e.document || (typeof document !== 'undefined' ? document : null);
    var createCanvas = e.createCanvas || (doc ? defaultCreateCanvas(doc) : null);
    if (!picture || !(picture.bitmap || picture.width)) throw new Error('没有可导出的本地图片');
    if (!createCanvas) throw new Error('当前环境不支持图片导出');
    var size = productSize();
    var canvas = null;
    for (var round = 0; round < MAX_SHRINK_ROUNDS; round += 1) {
      if (!canvas) {
        canvas = createCanvas(size.width, size.height);
      } else {
        canvas.width = size.width;
        canvas.height = size.height;
      }
      if (!renderComposition(canvas, picture, geom)) throw new Error('无法渲染图片');
      for (var i = 0; i < QUALITY_STEPS.length; i += 1) {
        var blob = await canvasToBlob(canvas, QUALITY_STEPS[i]);
        if (!blob) continue;
        var type = String(blob.type || '').toLowerCase();
        if (type && type !== LIMITS.outputMime) {
          throw new Error('当前浏览器不支持 WebP 编码，无法生成成品图');
        }
        if (Number(blob.size) <= LIMITS.maxOutputBytes) {
          return {
            blob: blob,
            width: size.width,
            height: size.height,
            bytes: Number(blob.size),
            mime: LIMITS.outputMime
          };
        }
      }
      size = shrinkSize(size);
    }
    throw new Error('图片压缩后仍超过 64 KiB，请换一张更简单的图片');
  }

  // ------------------------------------------------------------- 文件载入

  async function readFileBytes(file) {
    if (file && typeof file.arrayBuffer === 'function') {
      var buffer = await file.arrayBuffer();
      return toBytes(buffer);
    }
    return null;
  }

  async function decodePicture(file, env) {
    var e = env || {};
    var createBitmap = e.createImageBitmap ||
      (typeof createImageBitmap === 'function' ? createImageBitmap : null);
    if (createBitmap) {
      var bitmap = null;
      try {
        bitmap = await createBitmap(file, { imageOrientation: 'from-image' });
      } catch (err) {
        bitmap = null;
      }
      if (!bitmap) {
        try {
          bitmap = await createBitmap(file);
        } catch (err) {
          bitmap = null;
        }
      }
      if (bitmap) {
        return {
          bitmap: bitmap,
          width: Number(bitmap.width),
          height: Number(bitmap.height),
          objectUrl: ''
        };
      }
    }
    var doc = e.document || (typeof document !== 'undefined' ? document : null);
    var urlApi = e.URL || (typeof URL !== 'undefined' ? URL : null);
    var ImageCtor = e.Image || (typeof Image !== 'undefined' ? Image : null);
    if (!doc || !urlApi || !ImageCtor) throw new Error('当前环境不支持图片解码');
    var url = urlApi.createObjectURL(file);
    try {
      var image = await new Promise(function (resolve, reject) {
        var node = new ImageCtor();
        node.onload = function () { resolve(node); };
        node.onerror = function () { reject(new Error('decode failed')); };
        node.src = url;
      });
      return {
        bitmap: image,
        width: Number(image.naturalWidth || image.width),
        height: Number(image.naturalHeight || image.height),
        objectUrl: url
      };
    } catch (err) {
      if (urlApi.revokeObjectURL) urlApi.revokeObjectURL(url);
      throw new Error('decode failed');
    }
  }

  function releasePicture(picture) {
    if (!picture) return;
    var bitmap = picture.bitmap;
    if (bitmap && typeof bitmap.close === 'function') {
      try { bitmap.close(); } catch (err) { /* 已释放 */ }
    }
    if (picture.objectUrl) {
      var urlApi = typeof URL !== 'undefined' ? URL : null;
      if (urlApi && urlApi.revokeObjectURL) {
        try { urlApi.revokeObjectURL(picture.objectUrl); } catch (err) { /* ignore */ }
      }
    }
    picture.bitmap = null;
    picture.objectUrl = '';
  }

  /**
   * 载入本地图片（不触网）：预检 → 字节嗅探 → 解码 → 尺寸上限。
   * 失败时不会留下未释放的位图。
   */
  async function loadPicture(file, env) {
    var check = validatePictureFile(file);
    if (!check.ok) return { ok: false, picture: null, error: check.error };
    var bytes = null;
    try {
      bytes = await readFileBytes(file);
    } catch (err) {
      return { ok: false, picture: null, error: '读取图片文件失败，请重试' };
    }
    var sniff = classifyImageBytes(bytes);
    if (!sniff.ok) return { ok: false, picture: null, error: sniff.error };
    var decoded;
    try {
      decoded = await decodePicture(file, env);
    } catch (err) {
      return {
        ok: false,
        picture: null,
        error: '无法解码图片，文件可能已损坏或不是有效图片'
      };
    }
    var metaCheck = validateDecodedPicture({
      width: decoded.width,
      height: decoded.height,
      kind: sniff.kind,
      animated: sniff.animated
    });
    if (!metaCheck.ok) {
      releasePicture(decoded);
      return { ok: false, picture: null, error: metaCheck.error };
    }
    return {
      ok: true,
      error: '',
      picture: {
        width: decoded.width,
        height: decoded.height,
        kind: sniff.kind,
        sourceName: String(file.name || ''),
        sourceBytes: Number(file.size) || (bytes ? bytes.length : 0),
        bitmap: decoded.bitmap,
        objectUrl: decoded.objectUrl || ''
      }
    };
  }

  // ------------------------------------------------------- 保存链与竞态守卫

  /**
   * 是否需要保存、按什么顺序保存。文本永远先于图片（图片要用的 baseRev
   * 只能来自文本保存的返回值）。
   */
  function planSaveChain(state) {
    var s = state || {};
    if (s.saving) return { ok: false, blocked: 'saving', steps: [] };
    var pending = s.pendingPicture || null;
    var steps = [];
    var needsText = (!!s.isNew && !s.hasItem) || (!!s.hasItem && !!s.textDirty);
    if (needsText) steps.push('saveText');
    if (pending) {
      if (s.kind !== 'preset' && s.kind !== 'snippet') {
        return { ok: false, blocked: 'unsupported-kind', steps: [] };
      }
      steps.push(pending.action === 'clear' ? 'clearPicture' : 'uploadPicture');
      if (!!s.isNew && steps.indexOf('saveText') < 0) steps.unshift('saveText');
    }
    if (!steps.length) return { ok: false, blocked: 'nothing', steps: [] };
    return { ok: true, blocked: '', steps: steps };
  }

  function hasUnsavedChanges(state) {
    var s = state || {};
    return !!s.textDirty || !!s.pendingPicture;
  }

  /** 操作标识：任何新操作或资源切换都会让旧回包失效。 */
  function createOperationTracker() {
    var sequence = 0;
    return {
      begin: function () {
        sequence += 1;
        return sequence;
      },
      invalidate: function () {
        sequence += 1;
        return sequence;
      },
      isCurrent: function (token) {
        return token != null && token === sequence;
      }
    };
  }

  /** 串行锁：busy 期间重复调用直接跳过，不排队、不重放。 */
  async function runExclusive(lock, task) {
    var state = lock || {};
    if (state.busy) return { skipped: true };
    state.busy = true;
    try {
      return await task();
    } finally {
      state.busy = false;
    }
  }

  function errorText(err, fallback) {
    return err && err.message ? err.message : (fallback || '操作失败');
  }

  /**
   * 串行执行保存链。每一步返回 {ok, error?, unauthorized?, conflict?, stale?}。
   * 任一步失败即停止（图片不会再尝试），并标记文本是否已成功（部分成功）。
   */
  async function runSaveChain(plan, handlers) {
    var h = handlers || {};
    var out = {
      ok: false,
      steps: [],
      textSaved: false,
      pictureSaved: false,
      partial: false,
      stale: false,
      unauthorized: false,
      conflict: null,
      error: '',
      blocked: ''
    };
    if (!plan || !plan.ok || !Array.isArray(plan.steps) || !plan.steps.length) {
      out.blocked = (plan && plan.blocked) || 'invalid';
      return out;
    }
    for (var i = 0; i < plan.steps.length; i += 1) {
      var step = plan.steps[i];
      if (typeof h.isStale === 'function' && h.isStale()) {
        out.stale = true;
        return out;
      }
      if (typeof h[step] !== 'function') {
        out.error = '保存步骤缺失：' + step;
        out.partial = out.textSaved;
        return out;
      }
      var res;
      try {
        res = await h[step]();
      } catch (err) {
        res = { ok: false, error: errorText(err, '保存失败') };
      }
      if (res && res.stale) {
        out.stale = true;
        return out;
      }
      if (res && res.unauthorized) {
        out.unauthorized = true;
        out.error = res.error || '登录已过期';
        return out;
      }
      if (!res || !res.ok) {
        out.error = (res && res.error) || '保存失败';
        out.conflict = (res && res.conflict) || null;
        out.partial = out.textSaved;
        return out;
      }
      out.steps.push(step);
      if (step === 'saveText') out.textSaved = true;
      if (step === 'uploadPicture' || step === 'clearPicture') out.pictureSaved = true;
    }
    out.ok = true;
    return out;
  }

  function responseMatchesItem(payload, expectedId) {
    if (!payload || !payload.id) return false;
    if (!expectedId) return true;
    return String(payload.id) === String(expectedId);
  }

  return {
    LIMITS: LIMITS,
    STAGE_ASPECT: STAGE_ASPECT,
    STAGE_HEIGHT: STAGE_HEIGHT,
    QUALITY_STEPS: QUALITY_STEPS,
    MAX_SHRINK_ROUNDS: MAX_SHRINK_ROUNDS,
    classifyImageBytes: classifyImageBytes,
    validatePictureFile: validatePictureFile,
    validateDecodedPicture: validateDecodedPicture,
    geometryDefaults: geometryDefaults,
    baseDrawSize: baseDrawSize,
    offsetLimits: offsetLimits,
    normalizeGeometry: normalizeGeometry,
    resetGeometry: resetGeometry,
    zoomAt: zoomAt,
    panBy: panBy,
    destinationRect: destinationRect,
    canPan: canPan,
    canZoom: canZoom,
    frameRect: frameRect,
    compositionRects: compositionRects,
    renderComposition: renderComposition,
    productSize: productSize,
    shrinkSize: shrinkSize,
    exportPicture: exportPicture,
    loadPicture: loadPicture,
    releasePicture: releasePicture,
    planSaveChain: planSaveChain,
    hasUnsavedChanges: hasUnsavedChanges,
    createOperationTracker: createOperationTracker,
    runExclusive: runExclusive,
    runSaveChain: runSaveChain,
    responseMatchesItem: responseMatchesItem
  };
});
