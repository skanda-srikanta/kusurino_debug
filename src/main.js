import "./styles.css";
import * as CortexDecoder from "codecorp-web_sdk";

const MAX_BARCODES_TO_DECODE = 10;
const EXACT_MATCH = false;
const DUPLICATE_DELAY_MS = 500;
const LICENSE_STORAGE_KEY = "kusurino-debug-license-key";
const RESOLUTION_STORAGE_KEY = "kusurino-debug-resolution";
const GROUP_SEPARATOR = String.fromCharCode(29);
const RESOLUTION_OPTIONS = {
  RES640x360: { label: "640 x 360", value: "RES640x360", width: 640, height: 360 },
  RES1280x720: { label: "1280 x 720", value: "RES1280x720", width: 1280, height: 720 },
  RES1920x1080: { label: "1920 x 1080", value: "RES1920x1080", width: 1920, height: 1080 },
  RES3840x2160: { label: "3840 x 2160", value: "RES3840x2160", width: 3840, height: 2160 },
};

const METRIC_STATUS_CLASSES = ["metric-card--good", "metric-card--warning", "metric-card--bad", "metric-card--neutral"];
const METRIC_VALUE_STATUS_CLASSES = ["metric-value--good", "metric-value--warning", "metric-value--bad", "metric-value--neutral"];

let isSDKInitialized = false;
let initializationPromise = null;
let isCameraStreamActive = false;
let cameraOperationLock = Promise.resolve();

const defaultMetrics = () => ({
  previewFps: "-",
  uiFps: "-",
  decodeCallbacksPerSecond: "-",
  decodedBarcodesPerSecond: "-",
  longTasksPerSecond: "-",
  maxLongTaskDuration: "-",
  eventLoopLag: "-",
  memoryUsage: "Unavailable",
  actualResolution: "-",
});

const defaultMetricSamples = () => ({
  actualResolutionPixels: null,
  previewFps: null,
  uiFps: null,
  decodeCallbacksPerSecond: null,
  decodedBarcodesPerSecond: null,
  longTasksPerSecond: null,
  maxLongTaskDuration: null,
  eventLoopLag: null,
  memoryUsageRatio: null,
});

const diagnostics = {
  previewFrames: 0,
  uiFrames: 0,
  decodeCallbacks: 0,
  decodedBarcodes: 0,
  longTasks: 0,
  maxLongTaskDuration: 0,
  eventLoopLagSum: 0,
  eventLoopSamples: 0,
  lastSampleTime: 0,
  metricsIntervalId: null,
  eventLoopIntervalId: null,
  uiAnimationFrameId: null,
  videoFrameRequestId: null,
  longTaskObserver: null,
};

const appState = {
  initialized: false,
  activeLicenseKey: "",
  isCameraActive: false,
  scanMethodType: "EACH_SCAN",
  selectedResolutionKey: "RES3840x2160",
  scannedSet: new Set(),
  results: [],
  metrics: defaultMetrics(),
  metricSamples: defaultMetricSamples(),
};

const elements = {
  licenseKey: document.querySelector("#licenseKey"),
  scanMode: document.querySelector("#scanMode"),
  resolutionSelect: document.querySelector("#resolutionSelect"),
  startButton: document.querySelector("#startButton"),
  stopButton: document.querySelector("#stopButton"),
  clearButton: document.querySelector("#clearButton"),
  statusMessage: document.querySelector("#statusMessage"),
  errorMessage: document.querySelector("#errorMessage"),
  cameraContainer: document.querySelector("#cameraContainer"),
  video: document.querySelector("#video"),
  overlayCanvas: document.querySelector("#overlayCanvas"),
  resultsList: document.querySelector("#resultsList"),
  resultsEmptyState: document.querySelector("#resultsEmptyState"),
  selectedResolutionMetric: document.querySelector("#selectedResolutionMetric"),
  actualResolutionMetric: document.querySelector("#actualResolutionMetric"),
  previewFpsMetric: document.querySelector("#previewFpsMetric"),
  uiFpsMetric: document.querySelector("#uiFpsMetric"),
  decodeRateMetric: document.querySelector("#decodeRateMetric"),
  barcodeRateMetric: document.querySelector("#barcodeRateMetric"),
  longTaskMetric: document.querySelector("#longTaskMetric"),
  longTaskMaxMetric: document.querySelector("#longTaskMaxMetric"),
  eventLoopLagMetric: document.querySelector("#eventLoopLagMetric"),
  memoryMetric: document.querySelector("#memoryMetric"),
};

function getSelectedResolution() {
  return RESOLUTION_OPTIONS[appState.selectedResolutionKey] ?? RESOLUTION_OPTIONS.RES3840x2160;
}

function getResolutionPixelCount(resolutionKey = appState.selectedResolutionKey) {
  const resolution = RESOLUTION_OPTIONS[resolutionKey] ?? RESOLUTION_OPTIONS.RES3840x2160;
  return resolution.width * resolution.height;
}

function getResolutionEnumValue() {
  const resolution = getSelectedResolution();
  return CortexDecoder.CDResolution[resolution.value];
}

function formatRate(value) {
  return Number.isFinite(value) ? value.toFixed(1) : "-";
}

function formatMilliseconds(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)} ms` : "-";
}

function formatBytesToMegabytes(value) {
  if (!Number.isFinite(value)) {
    return "Unavailable";
  }

  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function classifyHigherIsBetter(value, warningMinimum, goodMinimum) {
  if (!Number.isFinite(value)) {
    return "neutral";
  }

  if (value >= goodMinimum) {
    return "good";
  }

  if (value >= warningMinimum) {
    return "warning";
  }

  return "bad";
}

function classifyLowerIsBetter(value, goodMaximum, warningMaximum) {
  if (!Number.isFinite(value)) {
    return "neutral";
  }

  if (value <= goodMaximum) {
    return "good";
  }

  if (value <= warningMaximum) {
    return "warning";
  }

  return "bad";
}

function classifyResolutionLoad(pixelCount) {
  return classifyLowerIsBetter(pixelCount, 1280 * 720, 1920 * 1080);
}

function classifySparseActivity(value, warningMinimum, goodMinimum) {
  if (!Number.isFinite(value) || value <= 0) {
    return "neutral";
  }

  return classifyHigherIsBetter(value, warningMinimum, goodMinimum);
}

function setMetricStatus(element, status) {
  const metricCard = element.closest(".metric-card");

  metricCard?.classList.remove(...METRIC_STATUS_CLASSES);
  element.classList.remove(...METRIC_VALUE_STATUS_CLASSES);

  metricCard?.classList.add(`metric-card--${status}`);
  element.classList.add(`metric-value--${status}`);
}

function updateMetricStatuses() {
  setMetricStatus(elements.selectedResolutionMetric, classifyResolutionLoad(getResolutionPixelCount()));
  setMetricStatus(elements.actualResolutionMetric, classifyResolutionLoad(appState.metricSamples.actualResolutionPixels));
  setMetricStatus(elements.previewFpsMetric, classifyHigherIsBetter(appState.metricSamples.previewFps, 24, 30));
  setMetricStatus(elements.uiFpsMetric, classifyHigherIsBetter(appState.metricSamples.uiFps, 24, 30));
  setMetricStatus(
    elements.decodeRateMetric,
    classifySparseActivity(appState.metricSamples.decodeCallbacksPerSecond, 4, 8)
  );
  setMetricStatus(
    elements.barcodeRateMetric,
    classifySparseActivity(appState.metricSamples.decodedBarcodesPerSecond, 0.3, 1)
  );
  setMetricStatus(elements.longTaskMetric, classifyLowerIsBetter(appState.metricSamples.longTasksPerSecond, 0.2, 1));
  setMetricStatus(elements.longTaskMaxMetric, classifyLowerIsBetter(appState.metricSamples.maxLongTaskDuration, 50, 100));
  setMetricStatus(elements.eventLoopLagMetric, classifyLowerIsBetter(appState.metricSamples.eventLoopLag, 50, 100));
  setMetricStatus(elements.memoryMetric, classifyLowerIsBetter(appState.metricSamples.memoryUsageRatio, 0.5, 0.7));
}

function updateMetricsView() {
  elements.selectedResolutionMetric.textContent = getSelectedResolution().label;
  elements.actualResolutionMetric.textContent = appState.metrics.actualResolution;
  elements.previewFpsMetric.textContent = appState.metrics.previewFps;
  elements.uiFpsMetric.textContent = appState.metrics.uiFps;
  elements.decodeRateMetric.textContent = appState.metrics.decodeCallbacksPerSecond;
  elements.barcodeRateMetric.textContent = appState.metrics.decodedBarcodesPerSecond;
  elements.longTaskMetric.textContent = appState.metrics.longTasksPerSecond;
  elements.longTaskMaxMetric.textContent = appState.metrics.maxLongTaskDuration;
  elements.eventLoopLagMetric.textContent = appState.metrics.eventLoopLag;
  elements.memoryMetric.textContent = appState.metrics.memoryUsage;
  updateMetricStatuses();
}

function resetMetrics() {
  appState.metrics = defaultMetrics();
  appState.metricSamples = defaultMetricSamples();
  diagnostics.previewFrames = 0;
  diagnostics.uiFrames = 0;
  diagnostics.decodeCallbacks = 0;
  diagnostics.decodedBarcodes = 0;
  diagnostics.longTasks = 0;
  diagnostics.maxLongTaskDuration = 0;
  diagnostics.eventLoopLagSum = 0;
  diagnostics.eventLoopSamples = 0;
  diagnostics.lastSampleTime = performance.now();
  updateMetricsView();
}

function captureActualResolution() {
  const width = elements.video?.videoWidth ?? 0;
  const height = elements.video?.videoHeight ?? 0;
  appState.metrics.actualResolution = width && height ? `${width} x ${height}` : "-";
  appState.metricSamples.actualResolutionPixels = width && height ? width * height : null;
}

function sampleMemoryUsage() {
  const memory = performance.memory;
  if (!memory) {
    appState.metrics.memoryUsage = "Unavailable";
    appState.metricSamples.memoryUsageRatio = null;
    return;
  }

  appState.metrics.memoryUsage = `${formatBytesToMegabytes(memory.usedJSHeapSize)} / ${formatBytesToMegabytes(memory.jsHeapSizeLimit)}`;
  appState.metricSamples.memoryUsageRatio = memory.jsHeapSizeLimit > 0 ? memory.usedJSHeapSize / memory.jsHeapSizeLimit : null;
}

function sampleMetricsWindow() {
  const now = performance.now();
  const elapsedMilliseconds = Math.max(now - diagnostics.lastSampleTime, 1);
  const elapsedSeconds = elapsedMilliseconds / 1000;
  const previewFps = diagnostics.previewFrames / elapsedSeconds;
  const uiFps = diagnostics.uiFrames / elapsedSeconds;
  const decodeCallbacksPerSecond = diagnostics.decodeCallbacks / elapsedSeconds;
  const decodedBarcodesPerSecond = diagnostics.decodedBarcodes / elapsedSeconds;
  const longTasksPerSecond = diagnostics.longTasks / elapsedSeconds;
  const maxLongTaskDuration = diagnostics.maxLongTaskDuration > 0 ? diagnostics.maxLongTaskDuration : null;
  const eventLoopLag = diagnostics.eventLoopSamples > 0
    ? diagnostics.eventLoopLagSum / diagnostics.eventLoopSamples
    : null;

  captureActualResolution();
  sampleMemoryUsage();
  appState.metricSamples.previewFps = previewFps;
  appState.metricSamples.uiFps = uiFps;
  appState.metricSamples.decodeCallbacksPerSecond = decodeCallbacksPerSecond;
  appState.metricSamples.decodedBarcodesPerSecond = decodedBarcodesPerSecond;
  appState.metricSamples.longTasksPerSecond = longTasksPerSecond;
  appState.metricSamples.maxLongTaskDuration = maxLongTaskDuration;
  appState.metricSamples.eventLoopLag = eventLoopLag;

  appState.metrics.previewFps = formatRate(previewFps);
  appState.metrics.uiFps = formatRate(uiFps);
  appState.metrics.decodeCallbacksPerSecond = formatRate(decodeCallbacksPerSecond);
  appState.metrics.decodedBarcodesPerSecond = formatRate(decodedBarcodesPerSecond);
  appState.metrics.longTasksPerSecond = formatRate(longTasksPerSecond);
  appState.metrics.maxLongTaskDuration = maxLongTaskDuration !== null ? formatMilliseconds(maxLongTaskDuration) : "-";
  appState.metrics.eventLoopLag = eventLoopLag !== null ? formatMilliseconds(eventLoopLag) : "-";

  diagnostics.previewFrames = 0;
  diagnostics.uiFrames = 0;
  diagnostics.decodeCallbacks = 0;
  diagnostics.decodedBarcodes = 0;
  diagnostics.longTasks = 0;
  diagnostics.maxLongTaskDuration = 0;
  diagnostics.eventLoopLagSum = 0;
  diagnostics.eventLoopSamples = 0;
  diagnostics.lastSampleTime = now;
  updateMetricsView();
}

function startUiFrameLoop() {
  const tick = () => {
    diagnostics.uiFrames += 1;
    diagnostics.uiAnimationFrameId = requestAnimationFrame(tick);
  };

  diagnostics.uiAnimationFrameId = requestAnimationFrame(tick);
}

function stopUiFrameLoop() {
  if (diagnostics.uiAnimationFrameId) {
    cancelAnimationFrame(diagnostics.uiAnimationFrameId);
    diagnostics.uiAnimationFrameId = null;
  }
}

function startPreviewFrameLoop() {
  if (typeof elements.video.requestVideoFrameCallback === "function") {
    const tick = () => {
      diagnostics.previewFrames += 1;
      diagnostics.videoFrameRequestId = elements.video.requestVideoFrameCallback(tick);
    };

    diagnostics.videoFrameRequestId = elements.video.requestVideoFrameCallback(tick);
    return;
  }

  appState.metrics.previewFps = "Unsupported";
  updateMetricsView();
}

function stopPreviewFrameLoop() {
  if (
    diagnostics.videoFrameRequestId !== null &&
    typeof elements.video.cancelVideoFrameCallback === "function"
  ) {
    elements.video.cancelVideoFrameCallback(diagnostics.videoFrameRequestId);
  }

  diagnostics.videoFrameRequestId = null;
}

function startLongTaskObserver() {
  if (!("PerformanceObserver" in window)) {
    appState.metrics.longTasksPerSecond = "Unsupported";
    appState.metrics.maxLongTaskDuration = "Unsupported";
    updateMetricsView();
    return;
  }

  try {
    diagnostics.longTaskObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        diagnostics.longTasks += 1;
        diagnostics.maxLongTaskDuration = Math.max(diagnostics.maxLongTaskDuration, entry.duration);
      }
    });

    diagnostics.longTaskObserver.observe({ entryTypes: ["longtask"] });
  } catch {
    appState.metrics.longTasksPerSecond = "Unsupported";
    appState.metrics.maxLongTaskDuration = "Unsupported";
    updateMetricsView();
  }
}

function stopLongTaskObserver() {
  diagnostics.longTaskObserver?.disconnect();
  diagnostics.longTaskObserver = null;
}

function startEventLoopMonitor() {
  let expected = performance.now() + 500;
  diagnostics.eventLoopIntervalId = window.setInterval(() => {
    const now = performance.now();
    diagnostics.eventLoopLagSum += Math.max(0, now - expected);
    diagnostics.eventLoopSamples += 1;
    expected = now + 500;
  }, 500);
}

function stopEventLoopMonitor() {
  if (diagnostics.eventLoopIntervalId !== null) {
    clearInterval(diagnostics.eventLoopIntervalId);
    diagnostics.eventLoopIntervalId = null;
  }
}

function startMetricsCollection() {
  resetMetrics();
  startUiFrameLoop();
  startPreviewFrameLoop();
  startLongTaskObserver();
  startEventLoopMonitor();
  diagnostics.metricsIntervalId = window.setInterval(sampleMetricsWindow, 1000);
}

function stopMetricsCollection() {
  if (diagnostics.metricsIntervalId !== null) {
    clearInterval(diagnostics.metricsIntervalId);
    diagnostics.metricsIntervalId = null;
  }

  stopUiFrameLoop();
  stopPreviewFrameLoop();
  stopLongTaskObserver();
  stopEventLoopMonitor();
}

function setStatus(message) {
  elements.statusMessage.textContent = message;
}

function setError(message = "") {
  elements.errorMessage.textContent = message;
  elements.errorMessage.classList.toggle("hidden", !message);
}

function updateButtons(isBusy = false) {
  elements.startButton.disabled = isBusy || appState.isCameraActive;
  elements.stopButton.disabled = isBusy || !appState.isCameraActive;
  elements.clearButton.disabled = isBusy || appState.results.length === 0;
}

function updateCameraVisibility() {
  elements.cameraContainer.classList.toggle("is-hidden", !appState.isCameraActive);
}

function renderResults() {
  elements.resultsList.replaceChildren();
  elements.resultsEmptyState.classList.toggle("hidden", appState.results.length > 0);

  for (const result of appState.results) {
    const article = document.createElement("article");
    article.className = "result-card";

    const heading = document.createElement("h3");
    heading.textContent = result.data;

    const meta = document.createElement("div");
    meta.className = "result-meta";

    const symbology = document.createElement("div");
    symbology.textContent = `Symbology: ${result.symbology}`;

    const composite = document.createElement("div");
    composite.textContent = `Composite data: ${result.compositeData || "-"}`;

    const timestamp = document.createElement("div");
    timestamp.textContent = `Captured at: ${result.timestamp}`;

    meta.append(symbology, composite, timestamp);
    article.append(heading, meta);
    elements.resultsList.append(article);
  }

  updateButtons();
}

function clearResults() {
  appState.results = [];
  appState.scannedSet.clear();
  renderResults();
}

function addResult(result) {
  appState.results.unshift({
    ...result,
    timestamp: new Date().toLocaleTimeString(),
  });
  renderResults();
}

async function withCameraLock(operation) {
  const previousLock = cameraOperationLock;
  let releaseLock = () => {};
  cameraOperationLock = new Promise((resolve) => {
    releaseLock = resolve;
  });

  try {
    await previousLock;
    return await operation();
  } finally {
    releaseLock();
  }
}

async function initializeSDK() {
  if (isSDKInitialized) {
    return;
  }

  if (initializationPromise) {
    await initializationPromise;
    return;
  }

  initializationPromise = (async () => {
    try {
      await CortexDecoder.CDDecoder.init("/wasm/");
      isSDKInitialized = true;
    } catch (error) {
      initializationPromise = null;
      throw error;
    }
  })();

  await initializationPromise;
}

async function authenticateLicense(licenseKey) {
  await CortexDecoder.CDLicense.activateLicense(licenseKey);
  const status = CortexDecoder.CDLicense.checkLicense();
  if (status !== "ACTIVATED" && status !== "VALID") {
    throw new Error(`License authentication failed: ${status}`);
  }
}

async function configureDecoder() {
  CortexDecoder.CDDevice.audio = true;
  CortexDecoder.CDDevice.vibration = true;

  const cdSymbology = new CortexDecoder.CDSymbology();
  // cdSymbology.GS1Databar.enable = true;
  // cdSymbology.Code128.enable = true;

  // cdSymbology.QR.enable = false;
  // cdSymbology.DataMatrix.enable = false;
  // cdSymbology.Aztec.enable = false;
  // cdSymbology.MaxiCode.enable = false;
  // cdSymbology.DotCode.enable = false;
  // cdSymbology.GridMatrix.enable = false;
  // cdSymbology.HanXinCode.enable = false;
  // cdSymbology.HongKong2of5.enable = false;
  // cdSymbology.IATA2of5.enable = false;
  // cdSymbology.Interleaved2of5.enable = false;
  // cdSymbology.Matrix2of5.enable = false;
  // cdSymbology.Straight2of5.enable = false;
  // cdSymbology.NEC2of5.enable = false;
  // cdSymbology.Codabar.enable = false;
  // cdSymbology.Code11.enable = false;
  // cdSymbology.Code32.enable = false;
  // cdSymbology.Code39.enable = false;
  // cdSymbology.Code49.enable = false;
  // cdSymbology.Code93.enable = false;
  // cdSymbology.CompositeCode.enable = false;
  // cdSymbology.CodablockF.enable = false;
  // cdSymbology.EAN13.enable = false;
  // cdSymbology.UPCA.enable = false;
  // cdSymbology.EAN8.enable = false;
  // cdSymbology.UPCE.enable = false;
  // cdSymbology.Trioptic.enable = false;
  // cdSymbology.Telepen.enable = false;
  // cdSymbology.Plessey.enable = false;
  // cdSymbology.PDF417.enable = false;
  // cdSymbology.MSIPlessey.enable = false;
  // cdSymbology.AustraliaPost.enable = false;
  // cdSymbology.CanadaPost.enable = false;
  // cdSymbology.DutchPost.enable = false;
  // cdSymbology.JapanPost.enable = false;
  // cdSymbology.KoreaPost.enable = false;
  // cdSymbology.RoyalMail.enable = false;
  // cdSymbology.UPU.enable = false;
  // cdSymbology.USPSIntelligent.enable = false;
  // cdSymbology.USPSPlanet.enable = false;
  // cdSymbology.USPSPostnet.enable = false;

  CortexDecoder.CDPerformanceFeatures.lowContrast = true;

//   await CortexDecoder.CDDecoder.setBarcodesToDecode(1, true);
//   CortexDecoder.CDDecoder.setDuplicateDelay(DUPLICATE_DELAY_MS);
  await CortexDecoder.CDDecoder.setBarcodesToDecode(MAX_BARCODES_TO_DECODE, EXACT_MATCH);
}

function isCameraPermissionError(error) {
  if (error instanceof DOMException) {
    return error.name === "NotAllowedError" || error.name === "PermissionDeniedError";
  }

  if (error instanceof Error && error.message) {
    return /NotAllowed|PermissionDenied|Permission\s*denied|access\s+was\s+denied/i.test(error.message);
  }

  return false;
}

function normalizeBarcodeData(data) {
  return data.replace(/\(|\)/g, "");
}

function extractExpiryAndLot(data) {
  const normalizedData = normalizeBarcodeData(data);
  const payload = normalizedData.replaceAll(GROUP_SEPARATOR, "");
  const gs1Payload = payload.startsWith("01") ? payload.slice(16) : payload;

  let cursor = 0;
  let expiryDate = "";
  let lotNumber = "";

  while (cursor < gs1Payload.length) {
    const ai = gs1Payload.slice(cursor, cursor + 2);

    if (ai === "17" && gs1Payload.length >= cursor + 8) {
      expiryDate = gs1Payload.slice(cursor + 2, cursor + 8);
      cursor += 8;
      continue;
    }

    if (ai === "10") {
      lotNumber = gs1Payload.slice(cursor + 2);
      break;
    }

    break;
  }

  return { expiryDate, lotNumber };
}

function processBarcode(data, symbology) {
  const normalizedData = normalizeBarcodeData(data);
  const isCode128 = symbology.toLowerCase().replace(/\s/g, "").includes("code128");

  if (isCode128 && /^01\d{14}/.test(normalizedData)) {
    const gtin = normalizedData.slice(0, 16);
    const { expiryDate, lotNumber } = extractExpiryAndLot(normalizedData);
    return {
      data: gtin,
      compositeData: `${expiryDate ?? ""}${lotNumber ?? ""}`,
      symbology,
    };
  }

  return { data, compositeData: "", symbology };
}

async function startCameraWithLock(videoElement, onResults) {
  return withCameraLock(async () => {
    if (isCameraStreamActive) {
      return;
    }

    if (elements.overlayCanvas) {
      elements.overlayCanvas.width = 0;
      elements.overlayCanvas.height = 0;
    }

    await CortexDecoder.CDCamera.init(videoElement, elements.overlayCanvas ?? undefined);
    await CortexDecoder.CDCamera.setHighlightBarcodes(true);
    await CortexDecoder.CDCamera.setResolution(getResolutionEnumValue());

    const cameras = CortexDecoder.CDCamera.getConnectedCameras();
    const tripleCamera = cameras.find((camera) => camera.label.includes("背面トリプルカメラ"));

    if (tripleCamera) {
      await CortexDecoder.CDCamera.setCamera(tripleCamera);
    } else {
      const hasBackCamera = cameras.some((camera) => {
        const label = camera.label.toLowerCase();
        return (
          label.includes("back") ||
          label.includes("rear") ||
          camera.label.includes("背面") ||
          camera.label.includes("環境")
        );
      });

      if (hasBackCamera) {
        await CortexDecoder.CDCamera.setCameraPosition(CortexDecoder.CDPosition.BACK, false);
      } else {
        await CortexDecoder.CDCamera.setCameraPosition(CortexDecoder.CDPosition.FRONT, false);
      }
    }

    await CortexDecoder.CDCamera.startCamera();
    await CortexDecoder.CDCamera.startPreview(onResults);

    CortexDecoder.CDDecoder.decoding = true;

    if (CortexDecoder.CDCamera.isFocusSupported()) {
      CortexDecoder.CDCamera.setFocus(CortexDecoder.CDFocus.AUTO);
    }

    isCameraStreamActive = true;
  });
}

async function stopCameraWithLock() {
  return withCameraLock(async () => {
    if (!isCameraStreamActive) {
      return;
    }

    try {
      CortexDecoder.CDDecoder.decoding = false;
      await CortexDecoder.CDCamera.stopCamera();
      isCameraStreamActive = false;
    } catch {
      isCameraStreamActive = false;
    }
  });
}

function handleScanResults(results) {
  if (!results || results.length === 0) {
    return;
  }

  diagnostics.decodeCallbacks += 1;

  const validResults = results.filter((result) => result.barcodeData !== "");
  if (validResults.length === 0) {
    return;
  }

  diagnostics.decodedBarcodes += validResults.length;

  if (appState.scanMethodType === "EACH_SCAN") {
    const processed = processBarcode(validResults[0].barcodeData, validResults[0].symbology);
    if (appState.scannedSet.has(processed.data)) {
      return;
    }

    appState.scannedSet.add(processed.data);
    addResult(processed);
    setStatus("Barcode captured. Camera stopped for single-scan mode.");
    void deactivateCamera(false);
    return;
  }

  for (const result of validResults) {
    const processed = processBarcode(result.barcodeData, result.symbology);
    if (appState.scannedSet.has(processed.data)) {
      continue;
    }

    appState.scannedSet.add(processed.data);
    addResult(processed);
  }
}

async function ensureScannerInitialized(licenseKey) {
  await initializeSDK();
  await authenticateLicense(licenseKey);
  await configureDecoder();

  appState.initialized = true;
  appState.activeLicenseKey = licenseKey;
}

async function activateCamera() {
  if (!elements.video) {
    throw new Error("Video element is not available.");
  }

  appState.scannedSet.clear();

  await startCameraWithLock(elements.video, (results) => {
    handleScanResults(results);
  });

  appState.isCameraActive = true;
  updateCameraVisibility();
  updateButtons();
  startMetricsCollection();
}

async function deactivateCamera(updateStatusMessage = true) {
  stopMetricsCollection();
  await stopCameraWithLock();
  appState.isCameraActive = false;
  updateCameraVisibility();
  updateButtons();

  if (updateStatusMessage) {
    setStatus("Camera stopped.");
  }
}

async function handleStartClick() {
  const licenseKey = elements.licenseKey.value.trim();
  appState.scanMethodType = elements.scanMode.value;
  appState.selectedResolutionKey = elements.resolutionSelect.value;

  if (!licenseKey) {
    setError("Enter a valid license key before starting the scanner.");
    return;
  }

  localStorage.setItem(LICENSE_STORAGE_KEY, licenseKey);
  localStorage.setItem(RESOLUTION_STORAGE_KEY, appState.selectedResolutionKey);
  setError("");
  setStatus("Initializing scanner...");
  updateButtons(true);

  try {
    if (!appState.initialized || appState.activeLicenseKey !== licenseKey) {
      await ensureScannerInitialized(licenseKey);
    }

    await activateCamera();
    setStatus("Camera active. Point it at a barcode.");
  } catch (error) {
    const message = isCameraPermissionError(error)
      ? "Camera access is not permitted. Allow camera access in the browser or device settings."
      : error instanceof Error
        ? error.message
        : "Failed to start the scanner.";

    setError(message);
    setStatus("Scanner initialization failed.");
    await deactivateCamera(false);
  } finally {
    updateButtons();
  }
}

async function handleResolutionChange(event) {
  const nextResolutionKey = event.target.value;
  appState.selectedResolutionKey = nextResolutionKey;
  localStorage.setItem(RESOLUTION_STORAGE_KEY, nextResolutionKey);
  updateMetricsView();

  if (!appState.isCameraActive) {
    setStatus(`Resolution set to ${getSelectedResolution().label}. Start the camera to test it.`);
    return;
  }

  setStatus(`Applying ${getSelectedResolution().label}...`);
  updateButtons(true);

  try {
    await deactivateCamera(false);
    await activateCamera();
    setStatus(`Camera restarted at ${getSelectedResolution().label}.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to apply the requested resolution.";
    setError(message);
    setStatus("Resolution change failed.");
    await deactivateCamera(false);
  } finally {
    updateButtons();
  }
}

async function handleStopClick() {
  setError("");
  setStatus("Stopping camera...");
  updateButtons(true);

  try {
    await deactivateCamera();
  } finally {
    updateButtons();
  }
}

function hydrateFormDefaults() {
  const storedLicenseKey = localStorage.getItem(LICENSE_STORAGE_KEY);
  const storedResolution = localStorage.getItem(RESOLUTION_STORAGE_KEY);
  if (storedLicenseKey) {
    elements.licenseKey.value = storedLicenseKey;
  }

  if (storedResolution && RESOLUTION_OPTIONS[storedResolution]) {
    appState.selectedResolutionKey = storedResolution;
  }

  elements.scanMode.value = appState.scanMethodType;
  elements.resolutionSelect.value = appState.selectedResolutionKey;
  updateMetricsView();
}

function registerEvents() {
  elements.startButton.addEventListener("click", () => {
    void handleStartClick();
  });

  elements.stopButton.addEventListener("click", () => {
    void handleStopClick();
  });

  elements.clearButton.addEventListener("click", clearResults);

  elements.scanMode.addEventListener("change", (event) => {
    appState.scanMethodType = event.target.value;
  });

  elements.resolutionSelect.addEventListener("change", (event) => {
    void handleResolutionChange(event);
  });

  window.addEventListener("beforeunload", () => {
    stopMetricsCollection();
    void stopCameraWithLock();
  });
}

function bootstrap() {
  hydrateFormDefaults();
  renderResults();
  updateCameraVisibility();
  updateButtons();
  registerEvents();
}

bootstrap();