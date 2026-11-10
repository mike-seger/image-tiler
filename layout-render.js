const BYTES_PER_PIXEL = 4;

export function parseColor(css) {
  const match = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?\s*\)/.exec(css);
  if (!match) {
    return { r: 0, g: 0, b: 0, a: 0 };
  }
  return {
    r: Number(match[1]),
    g: Number(match[2]),
    b: Number(match[3]),
    a: Math.round(255 * (match[4] === undefined ? 1 : Number(match[4]))),
  };
}

// Straight-alpha "source over" blend, so translucent overlays keep full 8-bit
// precision instead of the lossy premultiplied round trip a canvas performs.
function blendPixel(row, index, red, green, blue, alpha) {
  const destinationAlpha = row[index + 3];
  if (alpha === 255 || destinationAlpha === 0) {
    row[index] = red;
    row[index + 1] = green;
    row[index + 2] = blue;
    row[index + 3] = alpha;
    return;
  }
  const inverse = 255 - alpha;
  const scaledAlpha = alpha * 255 + destinationAlpha * inverse;
  const half = scaledAlpha >> 1;
  row[index] = Math.floor((red * alpha * 255 + row[index] * destinationAlpha * inverse + half) / scaledAlpha);
  row[index + 1] = Math.floor((green * alpha * 255 + row[index + 1] * destinationAlpha * inverse + half) / scaledAlpha);
  row[index + 2] = Math.floor((blue * alpha * 255 + row[index + 2] * destinationAlpha * inverse + half) / scaledAlpha);
  row[index + 3] = Math.floor((scaledAlpha + 127) / 255);
}

function fillRowSpan(row, rowWidth, from, to, color) {
  const start = Math.max(0, from);
  const end = Math.min(rowWidth, to);
  if (end <= start || color.a === 0) {
    return;
  }
  if (color.a === 255) {
    const packed = (color.r | (color.g << 8) | (color.b << 16) | (255 << 24)) >>> 0;
    new Uint32Array(row.buffer, row.byteOffset, rowWidth).fill(packed, start, end);
    return;
  }
  for (let x = start; x < end; x += 1) {
    blendPixel(row, x * BYTES_PER_PIXEL, color.r, color.g, color.b, color.a);
  }
}

function fillBackgroundRow(row, rowWidth, background) {
  if (background.a === 0) {
    row.fill(0);
    return;
  }
  const packed = (background.r | (background.g << 8) | (background.b << 16) | (background.a << 24)) >>> 0;
  new Uint32Array(row.buffer, row.byteOffset, rowWidth).fill(packed);
}

// Copies one source row in place without resampling, so a tile is a byte for
// byte copy of the uploaded PNG.
function writeImageRow(row, rowWidth, left, pixels, offset, imageWidth, mirrored, background) {
  const start = Math.max(0, left);
  const end = Math.min(rowWidth, left + imageWidth);
  if (end <= start) {
    return;
  }
  if (!mirrored && background.a === 0 && start === left) {
    row.set(pixels.subarray(offset, offset + imageWidth * BYTES_PER_PIXEL), left * BYTES_PER_PIXEL);
    return;
  }
  for (let x = start; x < end; x += 1) {
    const column = x - left;
    const source = offset + (mirrored ? imageWidth - 1 - column : column) * BYTES_PER_PIXEL;
    const alpha = pixels[source + 3];
    if (alpha === 0) {
      continue;
    }
    const destination = x * BYTES_PER_PIXEL;
    if (alpha === 255 || background.a === 0) {
      row[destination] = pixels[source];
      row[destination + 1] = pixels[source + 1];
      row[destination + 2] = pixels[source + 2];
      row[destination + 3] = alpha;
      continue;
    }
    blendPixel(row, destination, pixels[source], pixels[source + 1], pixels[source + 2], alpha);
  }
}

export function cornerMarkerRects(left, top, right, bottom, state) {
  const {
    cornerWidthX: widthX,
    cornerWidthY: widthY,
    cornerLengthX: lengthX,
    cornerLengthY: lengthY,
  } = state;
  return [
    [left, top - widthY, lengthX, widthY],
    [left - widthX, top, widthX, lengthY],
    [left - widthX, top - widthY, widthX, widthY],
    [right - lengthX, top - widthY, lengthX, widthY],
    [right, top, widthX, lengthY],
    [right, top - widthY, widthX, widthY],
    [left, bottom, lengthX, widthY],
    [left - widthX, bottom - lengthY, widthX, lengthY],
    [left - widthX, bottom, widthX, widthY],
    [right - lengthX, bottom, lengthX, widthY],
    [right, bottom - lengthY, widthX, lengthY],
    [right, bottom, widthX, widthY],
  ];
}

export function frameRects(state, left, top, tileLeft, tileTop, imageWidth, imageHeight) {
  return [
    [left, top, state.instanceWidth, state.frameWidthY],
    [left, tileTop, state.frameWidthX, imageHeight],
    [tileLeft + imageWidth, tileTop, state.frameWidthX, imageHeight],
    [left, tileTop + imageHeight, state.instanceWidth, state.frameWidthY],
  ];
}

export function parseColors(state) {
  return {
    background: parseColor(state.background),
    frame: parseColor(state.frameColor),
    corner: parseColor(state.cornerColor),
  };
}

// Composes a single output row straight from the decoded source pixels.
export function composeRow(row, state, image, source, y, colors) {
  const rowWidth = state.outputWidth;
  const { background, frame: frameColor, corner: cornerColor } = colors;
  const sourceStride = source.width * BYTES_PER_PIXEL;

  fillBackgroundRow(row, rowWidth, background);
  for (let instanceRow = 0; instanceRow < state.rows; instanceRow += 1) {
    const instanceTop = state.groupTop + instanceRow * (state.instanceHeight + state.cornerWidthY);
    const instanceBottom = instanceTop + state.instanceHeight;
    // Corner markers reach beyond the instance itself.
    const markerTop = state.cornersEnabled ? instanceTop - state.cornerWidthY : instanceTop;
    const markerBottom = state.cornersEnabled ? instanceBottom + state.cornerWidthY : instanceBottom;
    if (y < markerTop || y >= markerBottom) {
      continue;
    }
    const insideInstance = y >= instanceTop && y < instanceBottom;
    const tileTop = instanceTop + state.frameWidthY;
    const sourceY = y - tileTop;
    for (let column = 0; column < state.columns; column += 1) {
      const instanceLeft = state.groupLeft + column * (state.instanceWidth + state.cornerWidthX);
      const tileLeft = instanceLeft + state.frameWidthX;
      if (insideInstance && sourceY >= 0 && sourceY < source.height) {
        writeImageRow(
          row,
          rowWidth,
          tileLeft,
          source.data,
          sourceY * sourceStride,
          source.width,
          state.mirror,
          background,
        );
      }
      if (insideInstance && state.frameEnabled) {
        for (const [x, rectY, width, height] of frameRects(
          state,
          instanceLeft,
          instanceTop,
          tileLeft,
          tileTop,
          image.width,
          image.height,
        )) {
          if (y >= rectY && y < rectY + height) {
            fillRowSpan(row, rowWidth, x, x + width, frameColor);
          }
        }
      }
      if (state.cornersEnabled) {
        for (const [x, rectY, width, height] of cornerMarkerRects(
          instanceLeft,
          instanceTop,
          instanceLeft + state.instanceWidth,
          instanceBottom,
          state,
        )) {
          if (y >= rectY && y < rectY + height) {
            fillRowSpan(row, rowWidth, x, x + width, cornerColor);
          }
        }
      }
    }
  }
  return row;
}
