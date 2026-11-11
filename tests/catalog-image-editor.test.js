/**
 * 图片编辑模块回归测试（无依赖，node tests/catalog-image-editor.test.js）
 *
 * 覆盖：字节嗅探（含 APNG / 动态 WebP）、16 MP 上限与服务端一致、
 * 16:9 构图几何（cover / contain 锁定）、画布裁剪与白底、压缩阶梯、
 * 本地载入与资源释放。画布用内存像素栅格模拟，可断言真实可见像素。
 */
'use strict';

const assert = require('assert');
const path = require('path');

const Editor = require(path.join(__dirname, '..', 'js', 'catalog-image-editor.js'));

// ------------------------------------------------------------- test runner

const tests = [];
function test(name, fn) { tests.push([name, fn]); }

// --------------------------------------------------------------- byte utils

function bytesFrom(list) { return Uint8Array.from(list); }
function asciiBytes(text) { return Array.from(text).map((c) => c.charCodeAt(0)); }
function u32be(n) { return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]; }
function u32le(n) { return [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]; }

function chunk(type, data) {
  return u32be(data.length).concat(asciiBytes(type), data, [0, 0, 0, 0]);
}

function pngBytes(extraChunks) {
  let out = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  out = out.concat(chunk('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]));
  (extraChunks || []).forEach((entry) => { out = out.concat(chunk(entry[0], entry[1])); });
  out = out.concat(chunk('IDAT', [0]), chunk('IEND', []));
  return bytesFrom(out);
}

function webpBytes(options) {
  const opts = options || {};
  const flags = opts.animFlag ? 0x02 : 0x00;
  let body = asciiBytes('VP8X').concat(u32le(10), [flags, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  if (opts.animChunk) body = body.concat(asciiBytes('ANIM'), u32le(6), [0, 0, 0, 0, 0, 0]);
  const payload = asciiBytes('WEBP').concat(body);
  return bytesFrom(asciiBytes('RIFF').concat(u32le(payload.length), payload));
}

const JPEG_BYTES = bytesFrom([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const GIF_BYTES = bytesFrom(asciiBytes('GIF89a'));
const SVG_BYTES = bytesFrom(asciiBytes('<svg xmlns="http://www.w3.org/2000/svg"></svg>'));

function fakeFile(bytes, type, name, size) {
  return {
    type,
    name,
    size: size != null ? size : bytes.length,
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
  };
}

// ------------------------------------------------------ 内存像素栅格画布

function createMockCanvas(width, height) {
  const pixels = new Array(width * height).fill('w');
  const clipStack = [];
  let currentClip = null;
  const ctx = {
    fillStyle: '#000000',
    imageSmoothingQuality: '',
    drawCalls: [],
    save() { clipStack.push(currentClip); },
    restore() { currentClip = clipStack.length ? clipStack.pop() : null; },
    setTransform() {},
    beginPath() {},
    rect(x, y, w, h) { this._pendingRect = { x, y, w, h }; },
    clip() { if (this._pendingRect) currentClip = this._pendingRect; },
    fillRect(x, y, w, h) { paint(x, y, w, h, 'w'); },
    drawImage(image, x, y, w, h) {
      this.drawCalls.push({ x, y, w, h, source: image });
      paint(x, y, w, h, 'i');
    }
  };

  function paint(x, y, w, h, value) {
    const bounds = currentClip || { x: 0, y: 0, w: width, h: height };
    const x0 = Math.max(0, Math.round(x), Math.round(bounds.x));
    const y0 = Math.max(0, Math.round(y), Math.round(bounds.y));
    const x1 = Math.min(width, Math.round(x + w), Math.round(bounds.x + bounds.w));
    const y1 = Math.min(height, Math.round(y + h), Math.round(bounds.y + bounds.h));
    for (let py = y0; py < y1; py += 1) {
      for (let px = x0; px < x1; px += 1) pixels[py * width + px] = value;
    }
  }

  const canvas = {
    width,
    height,
    _pixels: pixels,
    _ctx: ctx,
    getContext(kind) { return kind === '2d' ? ctx : null; },
    toBlob() { throw new Error('toBlob not configured'); },
    pixel(x, y) { return pixels[y * width + x]; },
    rowValues(y) { return pixels.slice(y * width, (y + 1) * width); }
  };
  return canvas;
}

function picture(width, height) {
  return { width, height, bitmap: { width, height } };
}

// ------------------------------------------------------------------ 嗅探

test('classifyImageBytes 识别静态 PNG / JPEG / WebP', () => {
  assert.deepStrictEqual(
    Editor.classifyImageBytes(pngBytes()).kind, 'png');
  assert.strictEqual(Editor.classifyImageBytes(pngBytes()).ok, true);
  assert.strictEqual(Editor.classifyImageBytes(JPEG_BYTES).kind, 'jpeg');
  assert.strictEqual(Editor.classifyImageBytes(webpBytes()).kind, 'webp');
  assert.strictEqual(Editor.classifyImageBytes(webpBytes()).animated, false);
});

test('classifyImageBytes 拒绝 APNG acTL 与动态 WebP', () => {
  const apng = Editor.classifyImageBytes(pngBytes([['acTL', [0, 0, 0, 2, 0, 0, 0, 0]]]));
  assert.strictEqual(apng.ok, false);
  assert.strictEqual(apng.animated, true);
  assert.match(apng.error, /动画/);

  const animChunk = Editor.classifyImageBytes(webpBytes({ animChunk: true }));
  assert.strictEqual(animChunk.ok, false);
  assert.match(animChunk.error, /动画/);

  const animFlag = Editor.classifyImageBytes(webpBytes({ animFlag: true }));
  assert.strictEqual(animFlag.ok, false);
});

test('classifyImageBytes 拒绝 SVG / GIF / 空内容', () => {
  [SVG_BYTES, GIF_BYTES, bytesFrom(asciiBytes('not an image')), null, new Uint8Array(0)]
    .forEach((bytes) => {
      const result = Editor.classifyImageBytes(bytes);
      assert.strictEqual(result.ok, false);
      assert.ok(result.error);
    });
});

// -------------------------------------------------------------- 文件预检

test('validatePictureFile 只做提示性预检：MIME、扩展名、5 MiB 边界', () => {
  const ok = Editor.validatePictureFile({ type: 'image/png', name: 'a.png', size: 10 });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(
    Editor.validatePictureFile({ type: 'image/webp', name: 'a.webp', size: Editor.LIMITS.maxInputBytes }).ok,
    true);
  assert.strictEqual(
    Editor.validatePictureFile({ type: 'image/webp', name: 'a.webp', size: Editor.LIMITS.maxInputBytes + 1 }).ok,
    false);

  ['image/svg+xml', 'image/gif', 'image/avif'].forEach((type) => {
    assert.strictEqual(Editor.validatePictureFile({ type, name: 'x', size: 10 }).ok, false);
  });
  assert.strictEqual(Editor.validatePictureFile({ type: '', name: 'a.svg', size: 10 }).ok, false);
  assert.strictEqual(Editor.validatePictureFile({ type: '', name: 'a.png', size: 10 }).ok, true);
  assert.strictEqual(Editor.validatePictureFile({ type: 'image/png', name: 'a.png', size: 0 }).ok, false);
});

test('validateDecodedPicture 与服务端一致使用 16_000_000 像素上限', () => {
  assert.strictEqual(Editor.LIMITS.maxPixels, 16000000);
  assert.strictEqual(
    Editor.validateDecodedPicture({ width: 4000, height: 4000, kind: 'png' }).ok, true);
  assert.strictEqual(
    Editor.validateDecodedPicture({ width: 4001, height: 4000, kind: 'png' }).ok, false);
  // 4096×4096 = 16,777,216：旧前端 16*1024*1024 上限会放过，服务端会拒绝。
  assert.strictEqual(
    Editor.validateDecodedPicture({ width: 4096, height: 4096, kind: 'png' }).ok, false);
  assert.strictEqual(
    Editor.validateDecodedPicture({ width: 0, height: 10, kind: 'png' }).ok, false);
  assert.strictEqual(
    Editor.validateDecodedPicture({ width: 10, height: 10, kind: 'png', animated: true }).ok, false);
});

// ---------------------------------------------------------------- 几何

test('baseDrawSize：cover 覆盖舞台，contain 完整显示', () => {
  const landscape = Editor.baseDrawSize('cover', 1000, 500);
  assert.strictEqual(landscape.width, 1.125);
  assert.strictEqual(landscape.height, 0.5625);

  const containLandscape = Editor.baseDrawSize('contain', 1000, 500);
  assert.strictEqual(containLandscape.width, 1);
  assert.strictEqual(containLandscape.height, 0.5);

  const portraitCover = Editor.baseDrawSize('cover', 500, 1000);
  assert.strictEqual(portraitCover.width, 1);
  assert.strictEqual(portraitCover.height, 2);

  const portraitContain = Editor.baseDrawSize('contain', 500, 1000);
  assert.strictEqual(portraitContain.width, 0.28125);
  assert.strictEqual(portraitContain.height, 0.5625);

  const square = Editor.baseDrawSize('contain', 100, 100);
  assert.strictEqual(square.width, 0.5625);
  assert.strictEqual(square.height, 0.5625);
});

test('normalizeGeometry 夹紧缩放与偏移，不露出白边', () => {
  const low = Editor.normalizeGeometry({ mode: 'cover', zoom: 0.2 }, 1000, 500);
  assert.strictEqual(low.zoom, 1);
  const high = Editor.normalizeGeometry({ mode: 'cover', zoom: 99 }, 1000, 500);
  assert.strictEqual(high.zoom, 4);
  const nan = Editor.normalizeGeometry({ mode: 'cover', zoom: 'abc', offsetX: 'x' }, 1000, 500);
  assert.strictEqual(nan.zoom, 1);
  assert.strictEqual(nan.offsetX, 0);

  // 宽图横向可拖动，纵向无空隙。
  const limits = Editor.offsetLimits('cover', 1, 1000, 500);
  assert.ok(Math.abs(limits.x - 0.0625) < 1e-9);
  assert.strictEqual(limits.y, 0);
  const panned = Editor.panBy({ mode: 'cover', zoom: 1 }, 10, 10, 1000, 500);
  assert.ok(Math.abs(panned.offsetX - 0.0625) < 1e-9);
  assert.strictEqual(panned.offsetY, 0);

  const wide = Editor.baseDrawSize('cover', 2000, 500);
  assert.strictEqual(wide.width, 2.25);
  const edges = Editor.panBy({ mode: 'cover', zoom: 1 }, -99, 0, 2000, 500);
  assert.ok(Math.abs(edges.offsetX + 0.625) < 1e-9);
});

test('contain 锁定 1 倍并居中：不缩放、不拖动', () => {
  assert.deepStrictEqual(Editor.normalizeGeometry({ mode: 'contain', zoom: 3, offsetX: 0.4 }, 500, 1000),
    { mode: 'contain', zoom: 1, offsetX: 0, offsetY: 0 });
  assert.deepStrictEqual(Editor.zoomAt({ mode: 'contain', zoom: 1 }, 2, 500, 1000),
    { mode: 'contain', zoom: 1, offsetX: 0, offsetY: 0 });
  assert.deepStrictEqual(Editor.panBy({ mode: 'contain', zoom: 1 }, 0.2, 0.2, 500, 1000),
    { mode: 'contain', zoom: 1, offsetX: 0, offsetY: 0 });
  assert.strictEqual(Editor.canPan({ mode: 'contain', zoom: 1 }, 500, 1000), false);
  assert.strictEqual(Editor.canZoom({ mode: 'contain' }), false);
  assert.strictEqual(Editor.canZoom({ mode: 'cover' }), true);
});

test('zoomAt 保持指针下的画面内容不动', () => {
  const geom = { mode: 'cover', zoom: 1, offsetX: 0, offsetY: 0 };
  const point = { x: 0.25, y: 0.28125 };
  const before = Editor.destinationRect(geom, 1000, 1000);
  const u = (point.x - before.x) / before.width;
  const v = (point.y - before.y) / before.height;

  const zoomed = Editor.zoomAt(geom, 2, 1000, 1000, point);
  assert.strictEqual(zoomed.zoom, 2);
  const after = Editor.destinationRect(zoomed, 1000, 1000);
  assert.ok(Math.abs((point.x - after.x) / after.width - u) < 1e-9);
  assert.ok(Math.abs((point.y - after.y) / after.height - v) < 1e-9);

  const capped = Editor.zoomAt(geom, 10, 1000, 1000, point);
  assert.strictEqual(capped.zoom, Editor.LIMITS.maxZoom);
});

test('resetGeometry 回到 cover 1 倍居中', () => {
  const reset = Editor.resetGeometry('cover', 800, 600);
  assert.deepStrictEqual(reset, { mode: 'cover', zoom: 1, offsetX: 0, offsetY: 0 });
});

test('destinationRect cover 时始终覆盖舞台边界', () => {
  const cases = [[1000, 500], [500, 1000], [1000, 1000], [4000, 300]];
  cases.forEach(([w, h]) => {
    const geom = Editor.zoomAt({ mode: 'cover', zoom: 1 }, 1.7, w, h, { x: 0.9, y: 0.5 });
    const rect = Editor.destinationRect(geom, w, h);
    assert.ok(rect.x <= 1e-9, 'left cover ' + w + 'x' + h);
    assert.ok(rect.y <= 1e-9, 'top cover ' + w + 'x' + h);
    assert.ok(rect.x + rect.width >= 1 - 1e-9, 'right cover ' + w + 'x' + h);
    assert.ok(rect.y + rect.height >= Editor.STAGE_HEIGHT - 1e-9, 'bottom cover ' + w + 'x' + h);
  });
});

// ------------------------------------------------------- 渲染 / 像素验证

test('frameRect 把 16:9 画面放进任意画布并居中', () => {
  assert.deepStrictEqual(Editor.frameRect(480, 270),
    { x: 0, y: 0, width: 480, height: 270 });
  const square = Editor.frameRect(144, 144);
  assert.strictEqual(square.width, 144);
  assert.strictEqual(square.height, 81);
  assert.strictEqual(square.y, 31.5);
  const tall = Editor.frameRect(100, 400);
  assert.strictEqual(tall.width, 100);
  assert.strictEqual(tall.height, 56.25);
  assert.strictEqual(Editor.frameRect(0, 0), null);
});

test('compositionRects 在 1:1 画布中按 16:9 画面定位', () => {
  const rects = Editor.compositionRects({ mode: 'cover', zoom: 1 }, 500, 1000, 144, 144);
  assert.strictEqual(rects.image.width, 144);
  assert.strictEqual(rects.image.height, 288);
  assert.strictEqual(rects.image.y, -72);
});

test('renderComposition：16:9 成品白底、cover 全屏无空隙', () => {
  const canvas = createMockCanvas(480, 270);
  const pic = picture(500, 1000);
  assert.strictEqual(Editor.renderComposition(canvas, pic, { mode: 'cover', zoom: 1 }), true);
  for (let y = 0; y < 270; y += 1) {
    assert.strictEqual(canvas.rowValues(y).includes('w'), false, 'row ' + y + ' 应被图片覆盖');
  }
});

test('renderComposition：1:1 缩略图裁剪到 16:9 画面内，画面外保持白底', () => {
  const canvas = createMockCanvas(144, 144);
  const pic = picture(500, 1000);
  assert.strictEqual(Editor.renderComposition(canvas, pic, { mode: 'cover', zoom: 1 }), true);
  // 画面占 y ≈ 31.5 .. 112.5；取整边界行可能只覆盖一半，这里只断言明确区域。
  for (let y = 0; y < 144; y += 1) {
    const row = canvas.rowValues(y);
    if (y < 30 || y > 114) {
      assert.strictEqual(row.includes('i'), false, '第 ' + y + ' 行在画面外，不应出现图片像素');
      assert.strictEqual(row.includes('w'), true);
    } else if (y > 34 && y < 110) {
      assert.strictEqual(row.includes('w'), false, '第 ' + y + ' 行在画面内，应被覆盖');
    }
  }
});

test('renderComposition：contain 竖图上下留白，缩放被锁定', () => {
  const canvas = createMockCanvas(480, 270);
  const pic = picture(500, 1000);
  const geom = Editor.normalizeGeometry({ mode: 'contain', zoom: 3 }, 500, 1000);
  assert.strictEqual(Editor.renderComposition(canvas, pic, geom), true);
  const leftRow = canvas.rowValues(135);
  assert.strictEqual(leftRow.includes('w'), true);
  assert.strictEqual(leftRow.includes('i'), true);
  // 图片宽 135px 居中：左侧 172px 为白底。
  assert.strictEqual(leftRow[0], 'w');
  assert.strictEqual(leftRow[173], 'i');
});

test('renderComposition 对缺失画布/图片返回 false', () => {
  assert.strictEqual(Editor.renderComposition(null, picture(10, 10), {}), false);
  assert.strictEqual(Editor.renderComposition(createMockCanvas(10, 10), null, {}), false);
});

// ------------------------------------------------------------ 压缩阶梯

function canvasFactory(plan) {
  const created = [];
  return {
    created,
    createCanvas(width, height) {
      const canvas = createMockCanvas(width, height);
      canvas.toBlob = function (callback, type, quality) {
        const result = plan({ width: canvas.width, height: canvas.height, quality, type });
        setTimeout(() => {
          if (result == null) return callback(null);
          callback({ size: result.bytes, type: result.type || type });
        }, 0);
      };
      created.push(canvas);
      return canvas;
    }
  };
}

test('exportPicture 质量阶梯：先降质量到 64 KiB 以内', async () => {
  const calls = [];
  const factory = canvasFactory((info) => {
    calls.push(info.quality);
    return { bytes: info.quality > 0.6 ? 120 * 1024 : 40 * 1024 };
  });
  const result = await Editor.exportPicture(picture(1000, 563), { mode: 'cover', zoom: 1 },
    { createCanvas: factory.createCanvas });
  assert.ok(result.bytes <= Editor.LIMITS.maxOutputBytes);
  assert.strictEqual(result.width, 480);
  assert.strictEqual(result.height, 270);
  assert.deepStrictEqual(calls, [0.82, 0.74, 0.66, 0.58]);
  assert.strictEqual(result.mime, 'image/webp');
});

test('exportPicture 全部质量仍超限时等比收缩，保持 16:9', async () => {
  const sizes = [];
  const factory = canvasFactory((info) => {
    sizes.push([info.width, info.height]);
    return { bytes: info.width > 300 ? 90 * 1024 : 30 * 1024 };
  });
  const result = await Editor.exportPicture(picture(1000, 1000), { mode: 'cover', zoom: 1 },
    { createCanvas: factory.createCanvas });
  assert.ok(result.width < 480);
  assert.strictEqual(result.height, Math.round((result.width * 9) / 16));
  assert.ok(Math.abs(result.width / result.height - 16 / 9) < 0.02);
  assert.ok(sizes.length > 7);
});

test('exportPicture 拒绝非 WebP 编码与始终超限', async () => {
  const pngFactory = canvasFactory(() => ({ bytes: 100, type: 'image/png' }));
  await assert.rejects(
    () => Editor.exportPicture(picture(100, 100), { mode: 'cover' },
      { createCanvas: pngFactory.createCanvas }),
    /WebP/);

  const hugeFactory = canvasFactory(() => ({ bytes: 200 * 1024 }));
  await assert.rejects(
    () => Editor.exportPicture(picture(100, 100), { mode: 'cover' },
      { createCanvas: hugeFactory.createCanvas }),
    /64 KiB/);
});

test('exportPicture 无图片或无法渲染时报错', async () => {
  await assert.rejects(() => Editor.exportPicture(null, {}, {}), /没有可导出的本地图片/);
  const factory = canvasFactory(() => ({ bytes: 10 }));
  await assert.rejects(
    () => Editor.exportPicture({ width: 0, height: 0, bitmap: null }, {}, { createCanvas: factory.createCanvas }),
    /没有可导出的本地图片/);
  await assert.rejects(() => Editor.exportPicture(picture(10, 10), {}, {}), /不支持图片导出/);
});

test('shrinkSize 保持 16:9 并限制最小尺寸', () => {
  const size = Editor.shrinkSize({ width: 480, height: 270 });
  assert.strictEqual(size.width, 408);
  assert.strictEqual(size.height, 230);
  const tiny = Editor.shrinkSize({ width: 16, height: 9 });
  assert.ok(tiny.width >= 16);
  assert.ok(tiny.height >= 9);
});

// -------------------------------------------------------------- 本地载入

test('loadPicture 成功路径：先嗅探再解码，请求 EXIF 方向转正', async () => {
  const decodeCalls = [];
  const bitmap = { width: 800, height: 450, closed: false, close() { this.closed = true; } };
  const result = await Editor.loadPicture(fakeFile(pngBytes(), 'image/png', 'a.png'), {
    createImageBitmap: async (file, options) => {
      decodeCalls.push(options || null);
      return bitmap;
    }
  });
  assert.strictEqual(result.ok, true, result.error);
  assert.strictEqual(result.picture.width, 800);
  assert.strictEqual(result.picture.kind, 'png');
  assert.deepStrictEqual(decodeCalls[0], { imageOrientation: 'from-image' });
  assert.strictEqual(result.picture.sourceName, 'a.png');
});

test('loadPicture 首选解码参数失败时回退默认解码', async () => {
  const calls = [];
  const bitmap = { width: 10, height: 10, close() {} };
  const result = await Editor.loadPicture(fakeFile(JPEG_BYTES, 'image/jpeg', 'b.jpg'), {
    createImageBitmap: async (file, options) => {
      calls.push(options || null);
      if (options) throw new Error('unsupported');
      return bitmap;
    }
  });
  assert.strictEqual(result.ok, true, result.error);
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[1], null);
});

test('loadPicture 在解码前拒绝 APNG / 动态 WebP / SVG', async () => {
  let decoded = 0;
  const env = { createImageBitmap: async () => { decoded += 1; return { width: 10, height: 10 }; } };
  const apng = await Editor.loadPicture(
    fakeFile(pngBytes([['acTL', [0, 0, 0, 2, 0, 0, 0, 0]]]), 'image/png', 'a.png'), env);
  assert.strictEqual(apng.ok, false);
  assert.match(apng.error, /动画/);
  const webp = await Editor.loadPicture(fakeFile(webpBytes({ animChunk: true }), 'image/webp', 'a.webp'), env);
  assert.strictEqual(webp.ok, false);
  const svg = await Editor.loadPicture(fakeFile(SVG_BYTES, 'image/svg+xml', 'a.svg'), env);
  assert.strictEqual(svg.ok, false);
  assert.strictEqual(decoded, 0);
});

test('loadPicture 超 16 MP 时释放已解码位图', async () => {
  const bitmap = { width: 4096, height: 4096, closed: false, close() { this.closed = true; } };
  const result = await Editor.loadPicture(fakeFile(pngBytes(), 'image/png', 'big.png'), {
    createImageBitmap: async () => bitmap
  });
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /16 MP/);
  assert.strictEqual(bitmap.closed, true);
});

test('loadPicture 解码失败、读取失败与超限文件都有可操作提示', async () => {
  const broken = await Editor.loadPicture(fakeFile(pngBytes(), 'image/png', 'x.png'), {
    createImageBitmap: async () => { throw new Error('bad'); }
  });
  assert.strictEqual(broken.ok, false);
  assert.match(broken.error, /无法解码/);

  const readFail = await Editor.loadPicture({
    type: 'image/png', name: 'x.png', size: 10,
    async arrayBuffer() { throw new Error('io'); }
  }, {});
  assert.strictEqual(readFail.ok, false);
  assert.match(readFail.error, /读取/);

  const tooBig = await Editor.loadPicture(fakeFile(pngBytes(), 'image/png', 'x.png',
    Editor.LIMITS.maxInputBytes + 1), {});
  assert.strictEqual(tooBig.ok, false);
  assert.match(tooBig.error, /5 MiB/);
});

test('releasePicture 释放位图并保留可重复调用', () => {
  let closed = 0;
  const pic = { bitmap: { close() { closed += 1; } }, objectUrl: '' };
  Editor.releasePicture(pic);
  Editor.releasePicture(pic);
  assert.strictEqual(closed, 1);
  assert.strictEqual(pic.bitmap, null);
  assert.strictEqual(Editor.releasePicture(null), undefined);
});

test('hasUnsavedChanges 同时覆盖文本与待上传图片', () => {
  assert.strictEqual(Editor.hasUnsavedChanges({ textDirty: false, pendingPicture: null }), false);
  assert.strictEqual(Editor.hasUnsavedChanges({ textDirty: true, pendingPicture: null }), true);
  assert.strictEqual(Editor.hasUnsavedChanges({ textDirty: false, pendingPicture: { action: 'set' } }), true);
  assert.strictEqual(Editor.hasUnsavedChanges({ textDirty: false, pendingPicture: { action: 'clear' } }), true);
});

// ------------------------------------------------------------------ runner

(async () => {
  let passed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      passed += 1;
      console.log('ok - ' + name);
    } catch (err) {
      console.error('not ok - ' + name);
      throw err;
    }
  }
  console.log('\n' + passed + ' tests passed');
})();
