import { openSync, fstatSync, readSync, closeSync, writeFileSync, appendFileSync } from 'node:fs';

// Stat and read through one descriptor so the type/size check and the read
// cannot observe two different files.
export function readFileCapped(abs, maxBytes) {
  let fd;
  try {
    fd = openSync(abs, 'r');
  } catch (err) {
    if (err.code === 'EISDIR') return { directory: true };
    throw err;
  }
  try {
    const st = fstatSync(fd);
    if (st.isDirectory()) return { directory: true };
    if (st.size > maxBytes) return { tooLarge: true, size: st.size };
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off);
      if (n === 0) break;
      off += n;
    }
    return { content: buf.subarray(0, off).toString('utf-8') };
  } finally {
    closeSync(fd);
  }
}

// Create the file with a header on first write, append afterwards.
export function appendWithHeader(file, header, entry) {
  try {
    writeFileSync(file, header + entry, { flag: 'wx' });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    appendFileSync(file, entry, 'utf-8');
  }
}
