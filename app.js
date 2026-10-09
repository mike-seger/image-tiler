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

function render(canvas, scale = 1) {
  const context = canvas.getContext("2d", { alpha: true });
  canvas.width = Math.max(1, Math.round(layout.outputWidth * scale));
  canvas.height = Math.max(1, Math.round(layout.outputHeight * scale));
  context.setTransform(scale, 0, 0, scale, 0, 0);
  context.clearRect(0, 0, layout.outputWidth, layout.outputHeight);
  context.fillStyle = layout.background;
  context.fillRect(0, 0, layout.outputWidth, layout.outputHeight);

  for (let row = 0; row < layout.rows; row += 1) {
    for (let column = 0; column < layout.columns; column += 1) {
      const instanceLeft = layout.groupLeft + column * (layout.instanceWidth + layout.cornerWidthX);
      const instanceTop = layout.groupTop + row * (layout.instanceHeight + layout.cornerWidthY);
      const tileLeft = instanceLeft + layout.frameWidthX;
      const tileTop = instanceTop + layout.frameWidthY;
      const instanceRight = instanceLeft + layout.instanceWidth;
      const instanceBottom = instanceTop + layout.instanceHeight;

      context.save();
      if (layout.mirror) {
        context.translate(tileLeft + sourceImage.width, tileTop);
        context.scale(-1, 1);
        context.drawImage(sourceImage, 0, 0);
      } else {
        context.drawImage(sourceImage, tileLeft, tileTop);
      }
      context.restore();

      if (layout.frameEnabled) {
        context.fillStyle = layout.frameColor;
        fillRect(context, instanceLeft, instanceTop, layout.instanceWidth, layout.frameWidthY);
        fillRect(context, instanceLeft, tileTop, layout.frameWidthX, sourceImage.height);
        fillRect(context, tileLeft + sourceImage.width, tileTop, layout.frameWidthX, sourceImage.height);
        fillRect(context, instanceLeft, tileTop + sourceImage.height, layout.instanceWidth, layout.frameWidthY);
      }

      if (layout.cornersEnabled) {
        drawCornerMarkers(context, instanceLeft, instanceTop, instanceRight, instanceBottom, layout);
      }
    }
  }
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

function setStatus(message, isError = false) {
  status.textContent = message;
  status.classList.toggle("error", isError);
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

downloadButton.addEventListener("click", () => {
  if (!layout) {
    return;
  }
  const output = document.createElement("canvas");
  render(output);
  const link = document.createElement("a");
  const mirrorSuffix = layout.mirror ? "-mirrored" : "";
  link.download = `${sourceFilename}-${layout.inputMmX}x${layout.inputMmY}mm-to-${layout.outputMmX}x${layout.outputMmY}mm-${layout.columns}x${layout.rows}${mirrorSuffix}.png`;
  link.href = output.toDataURL("image/png");
  link.click();
});

restoreControls();
updatePreview();
