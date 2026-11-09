import { PngWriter } from "./png-writer.js";

const controls = Object.fromEntries(
  [...document.querySelectorAll("input, select")].map((element) => [element.id, element]),
);

const preview = document.querySelector("#preview");
const previewViewport = document.querySelector("#preview-viewport");
const previewStage = document.querySelector("#preview-stage");
const emptyPreview = document.querySelector("#empty-preview");
const status = document.querySelector("#status");
const imageDetails = document.querySelector("#image-details");
const downloadButton = document.querySelector("#download");
const manualRepetitions = document.querySelector("#manual-repetitions");
const cornerFields = document.querySelector("#corner-fields");
const frameFields = document.querySelector("#frame-fields");
const resetButton = document.querySelector("#reset");
const help = document.querySelector(".help");
const STORAGE_KEY = "image-tiler-controls-v1";
// Largest canvas area that every supported browser renders in one go.
const MAX_SINGLE_CANVAS_AREA = 16_777_216;
const EXPORT_BLOCK_WIDTH = 8192;
const EXPORT_BLOCK_AREA = 8_388_608;
const MAX_EXPORT_BYTES = 1_500_000_000;
const MILLIMETRES_PER_UNIT = { mm: 1, in: 25.4, cm: 10, px: 25.4 / 96 };
const PREVIEW_SIDE_MARGIN = 0.03;
const PREVIEW_PATTERN_CONTRAST = 0.3;
const dimensionIds = [
  "input-mm-x",
  "input-mm-y",
  "output-mm-x",
  "output-mm-y",
  "corner-width",
  "corner-length",
  "frame-width",
];
const controlElements = [...document.querySelectorAll("input, select")]
  .filter((element) => element.id !== "image-file");
const defaultControlValues = Object.fromEntries(controlElements.map((element) => [
  element.id,
  element.type === "checkbox" ? element.checked : element.value,
]));

let sourceImage;
let sourceFilename = "image";
let layout;
let previewBaseScale = 1;
let previewZoom = 1;
let dragState;
let resizeAnimationFrame;
let centerAnimationFrame;
let initialPreviewAnimationFrame;
let sourceMedianGray = 128;
let exporting = false;

function numeric(id) {
  const value = Number(controls[id].value);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${id.replaceAll("-", " ")} must be greater than zero.`);
  }
  return value;
}

function integer(id) {
  const value = Number(controls[id].value);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${id.replaceAll("-", " ")} must be a whole number of at least one.`);
  }
  return value;
}

function dimensionMm(id) {
  return numeric(id) * MILLIMETRES_PER_UNIT[controls[`${id}-unit`].value];
}

function colorChannels(color) {
  return [
    Number.parseInt(color.slice(1, 3), 16),
    Number.parseInt(color.slice(3, 5), 16),
    Number.parseInt(color.slice(5, 7), 16),
  ];
}

function rgba(color, alpha) {
  const [red, green, blue] = colorChannels(color);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function calculateMedianGray(image) {
  const maximumSampleDimension = 256;
  const scale = Math.min(1, maximumSampleDimension / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const sample = document.createElement("canvas");
  sample.width = width;
  sample.height = height;
  const context = sample.getContext("2d", { willReadFrequently: true });
  context.drawImage(image, 0, 0, width, height);

  const histogram = new Uint32Array(256);
  let totalOpacity = 0;
  const pixels = context.getImageData(0, 0, width, height).data;
  for (let index = 0; index < pixels.length; index += 4) {
    const alpha = pixels[index + 3];
    if (alpha === 0) {
      continue;
    }
    const gray = Math.round(
      0.2126 * pixels[index] + 0.7152 * pixels[index + 1] + 0.0722 * pixels[index + 2],
    );
    histogram[gray] += alpha;
    totalOpacity += alpha;
  }
  if (totalOpacity === 0) {
    return 128;
  }

  const medianOpacity = totalOpacity / 2;
  let accumulatedOpacity = 0;
  for (let gray = 0; gray < histogram.length; gray += 1) {
    accumulatedOpacity += histogram[gray];
    if (accumulatedOpacity >= medianOpacity) {
      return gray;
    }
  }
  return 128;
}

function updatePreviewPattern() {
  const backgroundColor = controls["background-color"].value;
  const inverseMedianGray = 255 - sourceMedianGray;
  const checkerColor = colorChannels(backgroundColor).map((channel) => Math.round(
    channel + (inverseMedianGray - channel) * PREVIEW_PATTERN_CONTRAST,
  ));
  preview.style.setProperty("--preview-background", backgroundColor);
  preview.style.setProperty("--preview-checker", `rgb(${checkerColor.join(", ")})`);
}

function ceilPixels(mm, imagePixels, imageMm) {
  return Math.ceil((mm * imagePixels) / imageMm);
}

function getSettings() {
  const inputMmX = dimensionMm("input-mm-x");
  const inputMmY = dimensionMm("input-mm-y");
  const outputMmX = dimensionMm("output-mm-x");
  const outputMmY = dimensionMm("output-mm-y");
  const cornersEnabled = controls["corners-enabled"].checked;
  const frameEnabled = controls["frame-enabled"].checked;
  const cornerWidth = cornersEnabled ? dimensionMm("corner-width") : 0;
  const cornerLength = cornersEnabled ? dimensionMm("corner-length") : 0;
  const frameWidth = frameEnabled ? dimensionMm("frame-width") : 0;

  return {
    inputMmX,
    inputMmY,
    outputMmX,
    outputMmY,
    mirror: controls.mirror.checked,
    repetitionMode: controls["repetition-mode"].value,
    columns: integer("columns"),
    rows: integer("rows"),
    background: Number(controls["background-alpha"].value) === 0
      ? "rgba(0, 0, 0, 0)"
      : rgba(controls["background-color"].value, controls["background-alpha"].value),
    cornersEnabled,
    cornerColor: rgba(controls["corner-color"].value, controls["corner-alpha"].value),
    cornerWidth,
    cornerLength,
    frameEnabled,
    frameColor: rgba(controls["frame-color"].value, controls["frame-alpha"].value),
    frameWidth,
  };
}

function calculateLayout() {
  const settings = getSettings();
  const outputWidth = Math.ceil((sourceImage.width * settings.outputMmX) / settings.inputMmX);
  const outputHeight = Math.ceil((sourceImage.height * settings.outputMmY) / settings.inputMmY);
  const cornerWidthX = settings.cornersEnabled
    ? ceilPixels(settings.cornerWidth, sourceImage.width, settings.inputMmX) : 0;
  const cornerWidthY = settings.cornersEnabled
    ? ceilPixels(settings.cornerWidth, sourceImage.height, settings.inputMmY) : 0;
  const cornerLengthX = settings.cornersEnabled
    ? ceilPixels(settings.cornerLength, sourceImage.width, settings.inputMmX) : 0;
  const cornerLengthY = settings.cornersEnabled
    ? ceilPixels(settings.cornerLength, sourceImage.height, settings.inputMmY) : 0;
  const frameWidthX = settings.frameEnabled
    ? ceilPixels(settings.frameWidth, sourceImage.width, settings.inputMmX) : 0;
  const frameWidthY = settings.frameEnabled
    ? ceilPixels(settings.frameWidth, sourceImage.height, settings.inputMmY) : 0;
  const instanceWidth = sourceImage.width + 2 * frameWidthX;
  const instanceHeight = sourceImage.height + 2 * frameWidthY;

  const availableWidth = outputWidth - 2 * cornerWidthX;
  const availableHeight = outputHeight - 2 * cornerWidthY;
  let columns = settings.columns;
  let rows = settings.rows;
  if (settings.repetitionMode === "auto") {
    columns = Math.floor((availableWidth + cornerWidthX) / (instanceWidth + cornerWidthX));
    rows = Math.floor((availableHeight + cornerWidthY) / (instanceHeight + cornerWidthY));
  }
  if (columns < 1 || rows < 1) {
    throw new Error("Output dimensions are too small for one framed instance and its corner markers.");
  }

  const groupWidth = columns * instanceWidth + (columns - 1) * cornerWidthX;
  const groupHeight = rows * instanceHeight + (rows - 1) * cornerWidthY;
  const groupLeft = Math.floor((outputWidth - groupWidth) / 2);
  const groupTop = Math.floor((outputHeight - groupHeight) / 2);
  if (
    groupWidth > outputWidth
    || groupHeight > outputHeight
    || groupLeft < cornerWidthX
    || groupTop < cornerWidthY
    || outputWidth - groupLeft - groupWidth < cornerWidthX
    || outputHeight - groupTop - groupHeight < cornerWidthY
  ) {
    throw new Error("Output dimensions do not leave enough outer margin for the corner markers.");
  }

  return {
    ...settings,
    outputWidth,
    outputHeight,
    cornerWidthX,
    cornerWidthY,
    cornerLengthX,
    cornerLengthY,
    frameWidthX,
    frameWidthY,
    instanceWidth,
    instanceHeight,
    columns,
    rows,
    groupLeft,
    groupTop,
  };
}

function fillRect(context, x, y, width, height) {
  if (width > 0 && height > 0) {
    context.fillRect(x, y, width, height);
  }
}

function drawCornerMarkers(context, left, top, right, bottom, layoutState) {
  const { cornerWidthX: widthX, cornerWidthY: widthY, cornerLengthX: lengthX, cornerLengthY: lengthY } = layoutState;
  context.fillStyle = layoutState.cornerColor;
  fillRect(context, left, top - widthY, lengthX, widthY);
  fillRect(context, left - widthX, top, widthX, lengthY);
  fillRect(context, left - widthX, top - widthY, widthX, widthY);
  fillRect(context, right - lengthX, top - widthY, lengthX, widthY);
  fillRect(context, right, top, widthX, lengthY);
  fillRect(context, right, top - widthY, widthX, widthY);
  fillRect(context, left, bottom, lengthX, widthY);
  fillRect(context, left - widthX, bottom - lengthY, widthX, lengthY);
  fillRect(context, left - widthX, bottom, widthX, widthY);
  fillRect(context, right - lengthX, bottom, lengthX, widthY);
  fillRect(context, right, bottom - lengthY, widthX, lengthY);
  fillRect(context, right, bottom, widthX, widthY);
}

function drawLayout(context, state = layout, image = sourceImage) {
  context.fillStyle = state.background;
  context.fillRect(0, 0, state.outputWidth, state.outputHeight);

  for (let row = 0; row < state.rows; row += 1) {
    for (let column = 0; column < state.columns; column += 1) {
      const instanceLeft = state.groupLeft + column * (state.instanceWidth + state.cornerWidthX);
      const instanceTop = state.groupTop + row * (state.instanceHeight + state.cornerWidthY);
      const tileLeft = instanceLeft + state.frameWidthX;
      const tileTop = instanceTop + state.frameWidthY;
      const instanceRight = instanceLeft + state.instanceWidth;
      const instanceBottom = instanceTop + state.instanceHeight;

      context.save();
      if (state.mirror) {
        context.translate(tileLeft + image.width, tileTop);
        context.scale(-1, 1);
        context.drawImage(image, 0, 0);
      } else {
        context.drawImage(image, tileLeft, tileTop);
      }
      context.restore();

      if (state.frameEnabled) {
        context.fillStyle = state.frameColor;
        fillRect(context, instanceLeft, instanceTop, state.instanceWidth, state.frameWidthY);
        fillRect(context, instanceLeft, tileTop, state.frameWidthX, image.height);
        fillRect(context, tileLeft + image.width, tileTop, state.frameWidthX, image.height);
        fillRect(context, instanceLeft, tileTop + image.height, state.instanceWidth, state.frameWidthY);
      }

      if (state.cornersEnabled) {
        drawCornerMarkers(context, instanceLeft, instanceTop, instanceRight, instanceBottom, state);
      }
    }
  }
}

function render(canvas, scale = 1) {
  const context = canvas.getContext("2d", { alpha: true });
  canvas.width = Math.max(1, Math.round(layout.outputWidth * scale));
  canvas.height = Math.max(1, Math.round(layout.outputHeight * scale));
  context.setTransform(scale, 0, 0, scale, 0, 0);
  context.clearRect(0, 0, layout.outputWidth, layout.outputHeight);
  drawLayout(context);
}

// Draws a rectangular window of the layout at full resolution so that exports
// never need a canvas the size of the whole image.
function renderRegion(canvas, context, state, image, left, top, width, height) {
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, width, height);
  context.setTransform(1, 0, 0, 1, -left, -top);
  drawLayout(context, state, image);
}

function viewportWidth() {
  return previewViewport.offsetWidth - 2 * previewViewport.clientLeft;
}

function viewportHeight() {
  return previewViewport.offsetHeight - 2 * previewViewport.clientTop;
}

function resizePreviewStage() {
  const horizontalMargin = preview.width * PREVIEW_SIDE_MARGIN;
  const verticalMargin = preview.height * PREVIEW_SIDE_MARGIN;
  const stageWidth = Math.max(
    viewportWidth(),
    preview.width + 2 * horizontalMargin,
  );
  const stageHeight = Math.max(
    viewportHeight(),
    preview.height + 2 * verticalMargin,
  );
  previewViewport.style.overflow = stageWidth <= viewportWidth() && stageHeight <= viewportHeight()
    ? "hidden"
    : "";
  previewStage.style.width = `${stageWidth}px`;
  previewStage.style.height = `${stageHeight}px`;
  preview.style.left = `${stageWidth === viewportWidth()
    ? (stageWidth - preview.width) / 2
    : horizontalMargin}px`;
  preview.style.top = `${stageHeight === viewportHeight()
    ? (stageHeight - preview.height) / 2
    : verticalMargin}px`;
}

function centerPreview() {
  const targetLeft = Math.max(0, (viewportWidth() - preview.width) / 2);
  const targetTop = Math.max(0, (viewportHeight() - preview.height) / 2);
  previewViewport.scrollLeft = Math.max(0, Number.parseFloat(preview.style.left) - targetLeft);
  previewViewport.scrollTop = Math.max(0, Number.parseFloat(preview.style.top) - targetTop);
}

function renderPreview(center = false) {
  render(preview, previewBaseScale * previewZoom);
  resizePreviewStage();
  if (center) {
    centerPreview();
    if (!centerAnimationFrame) {
      centerAnimationFrame = requestAnimationFrame(() => {
        centerAnimationFrame = undefined;
        resizePreviewStage();
        centerPreview();
      });
    }
  }
}

function minimumPreviewZoom() {
  return Math.min(
    1,
    viewportWidth() * (1 - 2 * PREVIEW_SIDE_MARGIN)
      / (layout.outputWidth * previewBaseScale),
  );
}

function zoomPreview(event) {
  if (!layout) {
    return;
  }
  event.preventDefault();
  const previousScale = previewBaseScale * previewZoom;
  const previewBounds = preview.getBoundingClientRect();
  const imageX = (event.clientX - previewBounds.left) / previousScale;
  const imageY = (event.clientY - previewBounds.top) / previousScale;
  const zoomFactor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
  const minimumZoom = minimumPreviewZoom();
  const nextZoom = Math.min(8, Math.max(minimumZoom, previewZoom * zoomFactor));
  if (nextZoom === previewZoom) {
    if (nextZoom === minimumZoom) {
      centerPreview();
    }
    return;
  }

  previewZoom = nextZoom;
  const reachedMinimum = nextZoom <= minimumZoom + Number.EPSILON;
  renderPreview(reachedMinimum);
  if (reachedMinimum) {
    return;
  }

  const nextScale = previewBaseScale * previewZoom;
  const nextBounds = preview.getBoundingClientRect();
  const targetLeft = event.clientX - imageX * nextScale;
  const targetTop = event.clientY - imageY * nextScale;
  previewViewport.scrollLeft += nextBounds.left - targetLeft;
  previewViewport.scrollTop += nextBounds.top - targetTop;
}

function startPan(event) {
  if (event.button !== 0 || !layout) {
    return;
  }
  event.preventDefault();
  dragState = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    scrollLeft: previewViewport.scrollLeft,
    scrollTop: previewViewport.scrollTop,
  };
  preview.setPointerCapture(event.pointerId);
  previewViewport.classList.add("dragging");
}

function panPreview(event) {
  if (!dragState || event.pointerId !== dragState.pointerId) {
    return;
  }
  event.preventDefault();
  previewViewport.scrollLeft = dragState.scrollLeft - (event.clientX - dragState.startX);
  previewViewport.scrollTop = dragState.scrollTop - (event.clientY - dragState.startY);
}

function stopPan(event) {
  if (!dragState || event.pointerId !== dragState.pointerId) {
    return;
  }
  preview.releasePointerCapture(event.pointerId);
  dragState = undefined;
  previewViewport.classList.remove("dragging");
}

function updateAlphaOutput(input, output) {
  output.value = Number(input.value).toFixed(2);
}

let statusMessage = "";
let statusIsError = false;
let hoverPosition;

function renderStatus() {
  const coordinates = hoverPosition
    ? ` · x: ${String(hoverPosition.x).padStart(4, "0")} · y: ${String(hoverPosition.y).padStart(4, "0")}`
    : "";
  status.textContent = statusMessage + coordinates;
  status.classList.toggle("error", statusIsError);
}

function setStatus(message, isError = false) {
  statusMessage = message;
  statusIsError = isError;
  renderStatus();
}

function trackPosition(event) {
  if (!layout) {
    return;
  }
  const scale = previewBaseScale * previewZoom;
  const bounds = preview.getBoundingClientRect();
  const x = Math.floor((event.clientX - bounds.left) / scale);
  const y = Math.floor((event.clientY - bounds.top) / scale);
  const inside = x >= 0 && y >= 0 && x < layout.outputWidth && y < layout.outputHeight;
  const nextPosition = inside ? { x, y } : undefined;
  if (nextPosition?.x !== hoverPosition?.x || nextPosition?.y !== hoverPosition?.y) {
    hoverPosition = nextPosition;
    renderStatus();
  }
}

function clearPosition() {
  hoverPosition = undefined;
  renderStatus();
}

function rememberControls() {
  const savedControls = Object.fromEntries(controlElements.map((element) => [
    element.id,
    element.type === "checkbox" ? element.checked : element.value,
  ]));
  localStorage.setItem(STORAGE_KEY, JSON.stringify(savedControls));
}

function setControlValue(element, value) {
  if (element.type === "checkbox") {
    element.checked = Boolean(value);
  } else {
    element.value = String(value);
  }
}

function initializeUnitTracking() {
  dimensionIds.forEach((id) => {
    controls[`${id}-unit`].dataset.previousUnit = controls[`${id}-unit`].value;
  });
}

function restoreControls() {
  try {
    const savedControls = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!savedControls) {
      initializeUnitTracking();
      return;
    }
    controlElements.forEach((element) => {
      if (Object.hasOwn(savedControls, element.id)) {
        setControlValue(element, savedControls[element.id]);
      }
    });
  } catch {
    localStorage.removeItem(STORAGE_KEY);
  }
  initializeUnitTracking();
}

function convertUnit(id) {
  const selector = controls[`${id}-unit`];
  const previousUnit = selector.dataset.previousUnit || selector.value;
  const value = Number(controls[id].value);
  if (Number.isFinite(value) && value > 0) {
    const millimetres = value * MILLIMETRES_PER_UNIT[previousUnit];
    const converted = millimetres / MILLIMETRES_PER_UNIT[selector.value];
    controls[id].value = Number(converted.toFixed(6)).toString();
  }
  selector.dataset.previousUnit = selector.value;
}

function resetControls() {
  localStorage.removeItem(STORAGE_KEY);
  controlElements.forEach((element) => setControlValue(element, defaultControlValues[element.id]));
  initializeUnitTracking();
  updatePreview();
}

function updateVisibility() {
  manualRepetitions.classList.toggle("hidden", controls["repetition-mode"].value !== "manual");
  cornerFields.classList.toggle("hidden", !controls["corners-enabled"].checked);
  frameFields.classList.toggle("hidden", !controls["frame-enabled"].checked);
}

function updatePreview() {
  updateVisibility();
  hoverPosition = undefined;
  updateAlphaOutput(controls["background-alpha"], document.querySelector("#background-alpha-value"));
  updateAlphaOutput(controls["corner-alpha"], document.querySelector("#corner-alpha-value"));
  updateAlphaOutput(controls["frame-alpha"], document.querySelector("#frame-alpha-value"));

  if (!sourceImage) {
    return;
  }
  try {
    layout = calculateLayout();
    updatePreviewPattern();
    previewBaseScale = Math.min(1, 1000 / Math.max(layout.outputWidth, layout.outputHeight));
    previewViewport.classList.add("initializing");
    previewZoom = minimumPreviewZoom();
    preview.style.display = "block";
    renderPreview(true);
    if (initialPreviewAnimationFrame) {
      cancelAnimationFrame(initialPreviewAnimationFrame);
    }
    initialPreviewAnimationFrame = requestAnimationFrame(() => {
      initialPreviewAnimationFrame = undefined;
      previewViewport.classList.remove("initializing");
      previewZoom = minimumPreviewZoom();
      renderPreview(true);
    });
    emptyPreview.hidden = true;
    downloadButton.disabled = false;
    setStatus(`${layout.columns} x ${layout.rows} instances · ${layout.outputWidth} x ${layout.outputHeight} pixels`);
  } catch (error) {
    preview.style.display = "none";
    emptyPreview.hidden = false;
    downloadButton.disabled = true;
    setStatus(error.message, true);
  }
}

async function loadImage(file) {
  sourceImage = await createImageBitmap(file);
  sourceMedianGray = calculateMedianGray(sourceImage);
  sourceFilename = file.name.replace(/\.png$/i, "") || "image";
  imageDetails.textContent = `${file.name} · ${sourceImage.width} x ${sourceImage.height} pixels`;
  updatePreview();
}

controls["image-file"].addEventListener("change", async (event) => {
  const [file] = event.target.files;
  if (!file) {
    return;
  }
  try {
    await loadImage(file);
  } catch (error) {
    setStatus(`Could not load image: ${error.message}`, true);
  }
});

document.querySelectorAll("input, select").forEach((element) => {
  if (element.id !== "image-file") {
    const refresh = () => {
      if (element.id.endsWith("-unit")) {
        convertUnit(element.id.slice(0, -5));
      }
      rememberControls();
      updatePreview();
    };
    element.addEventListener("input", refresh);
    element.addEventListener("change", refresh);
  }
});

resetButton.addEventListener("click", resetControls);
document.addEventListener("click", (event) => {
  if (help.open && !help.contains(event.target)) {
    help.open = false;
  }
});
preview.addEventListener("pointermove", trackPosition);
preview.addEventListener("pointerleave", clearPosition);
preview.addEventListener("wheel", zoomPreview, { passive: false });
preview.addEventListener("pointerdown", startPan);
preview.addEventListener("pointermove", panPreview);
preview.addEventListener("pointerup", stopPan);
preview.addEventListener("pointercancel", stopPan);
previewViewport.addEventListener("wheel", (event) => {
  if (event.target !== preview) {
    event.preventDefault();
  }
}, { passive: false });
let lastViewportBox = "";
new ResizeObserver((entries) => {
  const box = entries[0].borderBoxSize?.[0];
  const key = box ? `${box.inlineSize}x${box.blockSize}` : "";
  const unchanged = key !== "" && key === lastViewportBox;
  lastViewportBox = key;
  if (!layout || resizeAnimationFrame || unchanged) {
    return;
  }
  resizeAnimationFrame = requestAnimationFrame(() => {
    resizeAnimationFrame = undefined;
    renderPreview(true);
  });
}).observe(previewViewport);

function formatBytes(bytes) {
  if (bytes >= 1e9) {
    return `${(bytes / 1e9).toFixed(1)} GB`;
  }
  if (bytes >= 1e6) {
    return `${(bytes / 1e6).toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1e3))} kB`;
}

function outputFilename(state) {
  const mirrorSuffix = state.mirror ? "-mirrored" : "";
  return `${sourceFilename}-${state.inputMmX}x${state.inputMmY}mm-to-${state.outputMmX}x${state.outputMmY}mm-${state.columns}x${state.rows}${mirrorSuffix}.png`;
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.download = filename;
  link.href = url;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// Rebuilds the layout in horizontal bands of blocks and feeds the pixels to a
// streaming PNG encoder, so the memory needed stays independent of the output
// size and no canvas ever has to hold the whole image.
async function encodeLargePng(state, image, onProgress) {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { alpha: true });
  if (!context) {
    throw new Error("Canvas rendering is not available.");
  }
  const blockWidth = Math.min(state.outputWidth, EXPORT_BLOCK_WIDTH);
  const blockHeight = Math.min(
    state.outputHeight,
    Math.max(1, Math.floor(EXPORT_BLOCK_AREA / blockWidth)),
  );
  const row = new Uint8Array(state.outputWidth * 4);
  const writer = new PngWriter(state.outputWidth, state.outputHeight, { maxBytes: MAX_EXPORT_BYTES });

  try {
    for (let bandTop = 0; bandTop < state.outputHeight; bandTop += blockHeight) {
      const bandHeight = Math.min(blockHeight, state.outputHeight - bandTop);
      const blocks = [];
      for (let blockLeft = 0; blockLeft < state.outputWidth; blockLeft += blockWidth) {
        const width = Math.min(blockWidth, state.outputWidth - blockLeft);
        renderRegion(canvas, context, state, image, blockLeft, bandTop, width, bandHeight);
        const { data } = context.getImageData(0, 0, width, bandHeight);
        blocks.push({ left: blockLeft, width, data });
      }
      for (let offset = 0; offset < bandHeight; offset += 1) {
        for (const block of blocks) {
          const start = offset * block.width * 4;
          row.set(block.data.subarray(start, start + block.width * 4), block.left * 4);
        }
        await writer.writeRow(row);
      }
      onProgress((bandTop + bandHeight) / state.outputHeight);
      // Yield so the status text repaints between bands.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return await writer.finish();
  } catch (error) {
    await writer.abort();
    throw error;
  }
}

downloadButton.addEventListener("click", async () => {
  if (!layout || exporting) {
    return;
  }
  const state = layout;
  const filename = outputFilename(state);

  if (state.outputWidth * state.outputHeight <= MAX_SINGLE_CANVAS_AREA) {
    const output = document.createElement("canvas");
    render(output);
    const link = document.createElement("a");
    link.download = filename;
    link.href = output.toDataURL("image/png");
    link.click();
    return;
  }

  if (typeof CompressionStream !== "function") {
    setStatus("This browser cannot export images of this size. Reduce the output dimensions or use a current browser.", true);
    return;
  }

  const summary = `${state.columns} x ${state.rows} instances · ${state.outputWidth} x ${state.outputHeight} pixels`;
  exporting = true;
  downloadButton.disabled = true;
  try {
    const blob = await encodeLargePng(state, sourceImage, (fraction) => {
      setStatus(`Encoding ${summary}… ${Math.round(fraction * 100)}%`);
    });
    saveBlob(blob, filename);
    setStatus(`${summary} · ${formatBytes(blob.size)} PNG`);
  } catch (error) {
    setStatus(`Could not export PNG: ${error.message}`, true);
  } finally {
    exporting = false;
    downloadButton.disabled = false;
  }
});

restoreControls();
updatePreview();
