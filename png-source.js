const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const VALID_DEPTHS = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
};

function readUint16(bytes, offset) {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function parseChunks(buffer) {
  const view = new DataView(buffer);
  for (let index = 0; index < SIGNATURE.length; index += 1) {
    if (view.getUint8(index) !== SIGNATURE[index]) {
      throw new Error("Not a PNG file.");
    }
  }
  const chunks = { idat: [] };
  let offset = 8;
  while (offset + 8 <= buffer.byteLength) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...new Uint8Array(buffer, offset + 4, 4));
    const start = offset + 8;
    if (start + length > buffer.byteLength) {
      throw new Error("Truncated PNG file.");
    }
    if (type === "IHDR") {
      chunks.width = view.getUint32(start);
      chunks.height = view.getUint32(start + 4);
      chunks.bitDepth = view.getUint8(start + 8);
      chunks.colorType = view.getUint8(start + 9);
      chunks.interlace = view.getUint8(start + 12);
    } else if (type === "PLTE") {
      chunks.palette = new Uint8Array(buffer, start, length);
    } else if (type === "tRNS") {
      chunks.transparency = new Uint8Array(buffer, start, length);
    } else if (type === "IDAT") {
      chunks.idat.push(new Uint8Array(buffer, start, length));
    } else if (type === "IEND") {
      break;
    }
    offset = start + length + 4;
  }
  return chunks;
}

function unfilterRow(line, previous, target, filter, bytesPerPixel) {
  const length = target.length;
  switch (filter) {
    case 0:
      target.set(line);
      return;
    case 1:
      for (let index = 0; index < length; index += 1) {
        const left = index >= bytesPerPixel ? target[index - bytesPerPixel] : 0;
        target[index] = line[index] + left;
      }
      return;
    case 2:
      for (let index = 0; index < length; index += 1) {
        target[index] = line[index] + previous[index];
      }
      return;
    case 3:
      for (let index = 0; index < length; index += 1) {
        const left = index >= bytesPerPixel ? target[index - bytesPerPixel] : 0;
        target[index] = line[index] + ((left + previous[index]) >> 1);
      }
      return;
    case 4:
      for (let index = 0; index < length; index += 1) {
        const left = index >= bytesPerPixel ? target[index - bytesPerPixel] : 0;
        const up = previous[index];
        const upLeft = index >= bytesPerPixel ? previous[index - bytesPerPixel] : 0;
        const estimate = left + up - upLeft;
        const toLeft = Math.abs(estimate - left);
        const toUp = Math.abs(estimate - up);
        const toUpLeft = Math.abs(estimate - upLeft);
        const predictor = toLeft <= toUp && toLeft <= toUpLeft ? left : (toUp <= toUpLeft ? up : upLeft);
        target[index] = line[index] + predictor;
      }
      return;
    default:
      throw new Error(`Unsupported PNG filter type ${filter}.`);
  }
}

function convertRow(raw, data, offset, width, { bitDepth, colorType }, palette, transparency) {
  const channels = CHANNELS[colorType];
  if (bitDepth === 16) {
    const transparent = colorType === 2 || colorType === 0 ? transparency : undefined;
    for (let x = 0; x < width; x += 1) {
      const s = x * channels * 2;
      const d = offset + x * 4;
      if (colorType === 6) {
        data[d] = raw[s];
        data[d + 1] = raw[s + 2];
        data[d + 2] = raw[s + 4];
        data[d + 3] = raw[s + 6];
      } else if (colorType === 4) {
        data[d] = raw[s];
        data[d + 1] = raw[s];
        data[d + 2] = raw[s];
        data[d + 3] = raw[s + 2];
      } else if (colorType === 2) {
        const hidden = transparent
          && readUint16(transparent, 0) === readUint16(raw, s)
          && readUint16(transparent, 2) === readUint16(raw, s + 2)
          && readUint16(transparent, 4) === readUint16(raw, s + 4);
        data[d] = raw[s];
        data[d + 1] = raw[s + 2];
        data[d + 2] = raw[s + 4];
        data[d + 3] = hidden ? 0 : 255;
      } else {
        const hidden = transparent && readUint16(transparent, 0) === readUint16(raw, s);
        data[d] = raw[s];
        data[d + 1] = raw[s];
        data[d + 2] = raw[s];
        data[d + 3] = hidden ? 0 : 255;
      }
    }
    return;
  }

  if (bitDepth === 8) {
    for (let x = 0; x < width; x += 1) {
      const s = x * channels;
      const d = offset + x * 4;
      if (colorType === 6) {
        data[d] = raw[s];
        data[d + 1] = raw[s + 1];
        data[d + 2] = raw[s + 2];
        data[d + 3] = raw[s + 3];
      } else if (colorType === 4) {
        data[d] = raw[s];
        data[d + 1] = raw[s];
        data[d + 2] = raw[s];
        data[d + 3] = raw[s + 1];
      } else if (colorType === 2) {
        const hidden = transparency
          && readUint16(transparency, 0) === raw[s]
          && readUint16(transparency, 2) === raw[s + 1]
          && readUint16(transparency, 4) === raw[s + 2];
        data[d] = raw[s];
        data[d + 1] = raw[s + 1];
        data[d + 2] = raw[s + 2];
        data[d + 3] = hidden ? 0 : 255;
      } else if (colorType === 3) {
        const entry = raw[s] * 3;
        data[d] = palette[entry];
        data[d + 1] = palette[entry + 1];
        data[d + 2] = palette[entry + 2];
        data[d + 3] = transparency && raw[s] < transparency.length ? transparency[raw[s]] : 255;
      } else {
        const hidden = transparency && readUint16(transparency, 0) === raw[s];
        data[d] = raw[s];
        data[d + 1] = raw[s];
        data[d + 2] = raw[s];
        data[d + 3] = hidden ? 0 : 255;
      }
    }
    return;
  }

  const maximum = (1 << bitDepth) - 1;
  const mask = maximum;
  for (let x = 0; x < width; x += 1) {
    const bit = x * bitDepth;
    const byte = raw[bit >> 3];
    const shift = 8 - bitDepth - (bit & 7);
    const value = (byte >> shift) & mask;
    const d = offset + x * 4;
    if (colorType === 3) {
      const entry = value * 3;
      data[d] = palette[entry];
      data[d + 1] = palette[entry + 1];
      data[d + 2] = palette[entry + 2];
      data[d + 3] = transparency && value < transparency.length ? transparency[value] : 255;
    } else {
      const gray = Math.round((value * 255) / maximum);
      const hidden = transparency && readUint16(transparency, 0) === value;
      data[d] = gray;
      data[d + 1] = gray;
      data[d + 2] = gray;
      data[d + 3] = hidden ? 0 : 255;
    }
  }
}

export async function decodePng(buffer) {
  const chunks = parseChunks(buffer);
  const { width, height, bitDepth, colorType, interlace } = chunks;
  if (!width || !height) {
    throw new Error("PNG header is missing.");
  }
  if (interlace !== 0) {
    throw new Error("Interlaced PNG files are not supported.");
  }
  if (!VALID_DEPTHS[colorType] || !VALID_DEPTHS[colorType].includes(bitDepth)) {
    throw new Error(`Unsupported PNG format (colour type ${colorType}, bit depth ${bitDepth}).`);
  }
  if (colorType === 3 && !chunks.palette) {
    throw new Error("PNG palette is missing.");
  }
  if (chunks.idat.length === 0) {
    throw new Error("PNG image data is missing.");
  }

  const channels = CHANNELS[colorType];
  const rowBytes = Math.ceil((width * channels * bitDepth) / 8);
  const bytesPerPixel = Math.max(1, Math.ceil((channels * bitDepth) / 8));
  const data = new Uint8Array(width * height * 4);
  const previous = new Uint8Array(rowBytes);
  const current = new Uint8Array(rowBytes);

  const reader = new Blob(chunks.idat)
    .stream()
    .pipeThrough(new DecompressionStream("deflate"))
    .getReader();
  let stage = new Uint8Array(rowBytes + 1);
  let filled = 0;
  let row = 0;
  while (row < height) {
    while (filled < rowBytes + 1) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (filled + value.length > stage.length) {
        const grown = new Uint8Array(Math.max(stage.length * 2, filled + value.length));
        grown.set(stage.subarray(0, filled));
        stage = grown;
      }
      stage.set(value, filled);
      filled += value.length;
    }
    if (filled < rowBytes + 1) {
      throw new Error("PNG image data is truncated.");
    }
    unfilterRow(stage.subarray(1, rowBytes + 1), previous, current, stage[0], bytesPerPixel);
    convertRow(current, data, row * width * 4, width, { bitDepth, colorType }, chunks.palette, chunks.transparency);
    previous.set(current);
    stage.copyWithin(0, rowBytes + 1, filled);
    filled -= rowBytes + 1;
    row += 1;
  }
  await reader.cancel().catch(() => {});

  return { width, height, data };
}
