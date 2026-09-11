/**
 * Image parser — records metadata only. No OCR. The frontend uses
 * GET /api/uploads/:name to render the actual thumbnail.
 */

import { stat, open } from 'node:fs/promises';
import path from 'node:path';

const MIME_BY_EXT = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

/** Read just enough of a PNG/JPEG/GIF/WebP to extract dimensions. */
async function readDimensions(absPath, ext) {
  const fh = await open(absPath, 'r');
  try {
    const buf = Buffer.alloc(64);
    await fh.read(buf, 0, 64, 0);
    if (ext === 'png' && buf.slice(0, 8).toString('hex') === '89504e470d0a1a0a') {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (ext === 'gif' && buf.slice(0, 3).toString('ascii') === 'GIF') {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    if ((ext === 'jpg' || ext === 'jpeg') && buf[0] === 0xff && buf[1] === 0xd8) {
      // JPEG SOF scan — walk segments until we hit SOF0–SOF3.
      const big = Buffer.alloc(64 * 1024);
      const { bytesRead } = await fh.read(big, 0, big.length, 0);
      let i = 2;
      while (i < bytesRead - 9) {
        if (big[i] !== 0xff) { i++; continue; }
        const marker = big[i + 1];
        if (marker >= 0xc0 && marker <= 0xc3) {
          return { height: big.readUInt16BE(i + 5), width: big.readUInt16BE(i + 7) };
        }
        const segLen = big.readUInt16BE(i + 2);
        i += 2 + segLen;
      }
    }
    if (ext === 'webp' && buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') {
      const fourcc = buf.slice(12, 16).toString('ascii');
      if (fourcc === 'VP8 ') {
        return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      }
      if (fourcc === 'VP8L') {
        const b = buf.slice(21);
        const w = 1 + (((b[1] & 0x3f) << 8) | b[0]);
        const h = 1 + (((b[3] & 0x0f) << 10) | (b[2] << 2) | ((b[1] & 0xc0) >> 6));
        return { width: w, height: h };
      }
      if (fourcc === 'VP8X') {
        const w = 1 + ((buf[24]) | (buf[25] << 8) | (buf[26] << 16));
        const h = 1 + ((buf[27]) | (buf[28] << 8) | (buf[29] << 16));
        return { width: w, height: h };
      }
    }
  } finally {
    await fh.close();
  }
  return null;
}

export default {
  extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'],
  async parse(absPath) {
    const ext = path.extname(absPath).replace(/^\./, '').toLowerCase();
    const st = await stat(absPath);
    let dims = null;
    try { dims = await readDimensions(absPath, ext); } catch { /* best-effort */ }
    const dimsStr = dims ? `${dims.width}×${dims.height}` : 'unknown size';
    return {
      preview: `[${ext.toUpperCase()} image, ${dimsStr}, ${st.size} bytes]`,
      summary: `${ext.toUpperCase()} image (${dimsStr}, ${st.size} bytes)`,
      structure: { width: dims?.width || null, height: dims?.height || null, bytes: st.size },
      mime: MIME_BY_EXT[ext] || 'application/octet-stream',
    };
  },
};
