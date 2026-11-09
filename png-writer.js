const BYTES_PER_PIXEL = 4;
const SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const FILTER_SUB = 1;
const FILTER_UP = 2;
const FLUSH_BYTES = 64_000_000;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function updateCrc(crc, bytes, start, end) {
  let value = crc;
  for (let index = start; index < end; index += 1) {
    value = CRC_TABLE[(value ^ bytes[index]) & 0xff] ^ (value >>> 8);
  }
  return value;
}

function pngChunk(type, data) {
  const output = new Uint8Array(12 + data.length);
  const view = new DataView(output.buffer);
  view.setUint32(0, data.length);
  for (let index = 0; index < 4; index += 1) {
    output[4 + index] = type.charCodeAt(index);
  }
  output.set(data, 8);
  const crc = updateCrc(0xffffffff, output, 4, 8 + data.length) ^ 0xffffffff;
  view.setUint32(8 + data.length, crc >>> 0);
  return output;
}

function headerChunk(width, height) {
  const data = new Uint8Array(13);
  const view = new DataView(data.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  data[8] = 8;
  data[9] = 6;
  return pngChunk("IHDR", data);
}

function signedDistance(value) {
  const wrapped = value & 0xff;
  return Math.min(wrapped, 256 - wrapped);
}

function filterRow(row, previous, target) {
  let subCost = 0;
  let upCost = 0;
  for (let index = 0; index < row.length; index += 8) {
    const left = index >= BYTES_PER_PIXEL ? row[index - BYTES_PER_PIXEL] : 0;
    subCost += signedDistance(row[index] - left);
    upCost += signedDistance(row[index] - previous[index]);
  }
  const type = subCost < upCost ? FILTER_SUB : FILTER_UP;
  target[0] = type;
  for (let index = 0; index < row.length; index += 1) {
    const reference = type === FILTER_SUB
      ? (index >= BYTES_PER_PIXEL ? row[index - BYTES_PER_PIXEL] : 0)
      : previous[index];
    target[index + 1] = row[index] - reference;
  }
}

export class PngWriter {
  constructor(width, height, { maxBytes = 1_500_000_000 } = {}) {
    if (typeof CompressionStream !== "function") {
      throw new Error("This browser cannot compress PNG data.");
    }
    this.width = width;
    this.height = height;
    this.maxBytes = maxBytes;
    this.parts = [SIGNATURE, headerChunk(width, height)];
    this.blob = new Blob([], { type: "image/png" });
    this.compressedBytes = 0;
    this.flushedBytes = 0;
    this.rowsWritten = 0;
    this.exceededLimit = false;
    this.previousRow = new Uint8Array(width * BYTES_PER_PIXEL);
    this.rowLength = width * BYTES_PER_PIXEL;

    const compression = new CompressionStream("deflate");
    this.writer = compression.writable.getWriter();
    this.reader = compression.readable.getReader();
    this.pump = this.collect();
    this.pump.catch(() => {});
  }

  async collect() {
    for (;;) {
      const { done, value } = await this.reader.read();
      if (done) {
        return;
      }
      this.compressedBytes += value.length;
      if (this.compressedBytes > this.maxBytes) {
        this.exceededLimit = true;
        continue;
      }
      this.parts.push(pngChunk("IDAT", value));
      if (this.compressedBytes - this.flushedBytes >= FLUSH_BYTES) {
        this.flush();
      }
    }
  }

  flush() {
    if (this.parts.length === 0) {
      return;
    }
    this.blob = new Blob([this.blob, ...this.parts], { type: "image/png" });
    this.parts = [];
    this.flushedBytes = this.compressedBytes;
  }

  async writeRow(pixels) {
    if (pixels.length !== this.rowLength) {
      throw new Error(`Expected ${this.rowLength} bytes per row, received ${pixels.length}.`);
    }
    if (this.exceededLimit) {
      throw this.limitError();
    }
    const filtered = new Uint8Array(this.rowLength + 1);
    filterRow(pixels, this.previousRow, filtered);
    this.previousRow.set(pixels);
    this.rowsWritten += 1;
    await this.writer.write(filtered);
  }

  limitError() {
    return new Error(
      `The PNG would be larger than ${Math.round(this.maxBytes / 1e9)} GB. Reduce the output dimensions.`,
    );
  }

  async finish() {
    await this.writer.close();
    await this.pump;
    this.parts.push(pngChunk("IEND", new Uint8Array(0)));
    this.flush();
    return this.blob;
  }

  async abort() {
    await this.writer.abort().catch(() => {});
    await this.pump.catch(() => {});
  }
}
