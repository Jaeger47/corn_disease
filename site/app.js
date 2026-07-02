"use strict";

const CLOUD_MODEL_URL = "https://cdn.jsdelivr.net/gh/Jaeger47/corn_disease@v1.0.0/models/maize-disease-efficientnetb0.onnx";
const LOCAL_MODEL_URL = new URL("../models/maize-disease-efficientnetb0.onnx", document.baseURI).href;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const MODEL_URL = LOCAL_HOSTS.has(window.location.hostname) ? LOCAL_MODEL_URL : CLOUD_MODEL_URL;
const WASM_PATH = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/";
const DEMO_URL = new URL("./demo-leaf.jpg", document.baseURI).href;
const IMAGE_SIZE = 300;
const MIN_SUPPORTED_CONFIDENCE = 0.7;
const MIN_SUPPORTED_MARGIN = 0.2;
const LABELS = [
  {
    name: "Healthy",
    icon: "✓",
    guide: "healthy",
    summary: "No strong visual match for the three supported diseases was found. Keep monitoring the plant, especially if symptoms are new or changing."
  },
  {
    name: "Gray leaf spot",
    icon: "▦",
    guide: "gray-leaf-spot",
    summary: "The leaf resembles gray leaf spot. Look for rectangular gray-to-brown lesions whose straight sides are limited by leaf veins."
  },
  {
    name: "Northern leaf blight",
    icon: "≈",
    guide: "blight",
    summary: "The leaf resembles northern corn leaf blight. Check for long, tan, canoe-shaped lesions that often begin on lower leaves."
  },
  {
    name: "Common rust",
    icon: "••",
    guide: "common-rust",
    summary: "The leaf resembles common rust. Look for raised cinnamon-brown pustules on both the upper and lower leaf surfaces."
  }
];

const elements = {
  webcam: document.querySelector("#webcam"),
  snapshot: document.querySelector("#snapshot"),
  cameraEmpty: document.querySelector("#cameraEmpty"),
  frameGuide: document.querySelector("#frameGuide"),
  cameraSelect: document.querySelector("#cameraSelect"),
  startCamera: document.querySelector("#startCamera"),
  switchCamera: document.querySelector("#switchCamera"),
  photoInput: document.querySelector("#photoInput"),
  samplePhoto: document.querySelector("#samplePhoto"),
  analyzeButton: document.querySelector("#analyzeButton"),
  cameraMessage: document.querySelector("#cameraMessage"),
  modelStatus: document.querySelector("#modelStatus"),
  modelStatusText: document.querySelector("#modelStatusText"),
  resultPlaceholder: document.querySelector("#resultPlaceholder"),
  resultContent: document.querySelector("#resultContent"),
  resultIcon: document.querySelector("#resultIcon"),
  confidenceBadge: document.querySelector("#confidenceBadge"),
  resultKicker: document.querySelector("#resultKicker"),
  resultName: document.querySelector("#resultName"),
  resultSummary: document.querySelector("#resultSummary"),
  probabilities: document.querySelector("#probabilities"),
  guideLink: document.querySelector("#guideLink"),
  installButton: document.querySelector("#installButton")
};

let session = null;
let stream = null;
let sourceMode = null;
let sourceReady = false;
let analyzing = false;
let deferredInstallPrompt = null;

function setModelStatus(message, state = "loading") {
  elements.modelStatusText.textContent = message;
  elements.modelStatus.classList.toggle("ready", state === "ready");
  elements.modelStatus.classList.toggle("error", state === "error");
}

function setCameraMessage(message, isError = false) {
  elements.cameraMessage.textContent = message;
  elements.cameraMessage.classList.toggle("error", isError);
}

function updateAnalyzeButton() {
  elements.analyzeButton.disabled = !sourceReady || !session || analyzing;
}

async function fetchModelBytes() {
  const response = await fetch(MODEL_URL, { cache: "force-cache" });
  if (!response.ok) throw new Error(`Model download failed (${response.status})`);

  const total = Number(response.headers.get("content-length")) || 0;
  if (!response.body || !total) {
    return new Uint8Array(await response.arrayBuffer());
  }

  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    setModelStatus(`Preparing detector · ${Math.min(100, Math.round(received / total * 100))}%`);
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

async function loadModel() {
  try {
    if (!window.ort) throw new Error("ONNX Runtime did not load");
    ort.env.wasm.wasmPaths = {
      mjs: `${WASM_PATH}ort-wasm-simd-threaded.mjs`,
      wasm: `${WASM_PATH}ort-wasm-simd-threaded.wasm`
    };
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;

    const modelBytes = await fetchModelBytes();
    setModelStatus("Starting on-device detector…");
    session = await ort.InferenceSession.create(modelBytes, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all"
    });

    setModelStatus("Detector ready · works offline", "ready");
    updateAnalyzeButton();
  } catch (error) {
    console.error("Could not load the disease model", error);
    setModelStatus("Detector unavailable", "error");
    setCameraMessage("The detector could not start. Check your connection once, then reload.", true);
  }
}

function stopCamera() {
  if (stream) {
    stream.getTracks().forEach((track) => track.stop());
    stream = null;
  }
  elements.webcam.srcObject = null;
}

function waitForVideo(video) {
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return Promise.resolve();
  return new Promise((resolve) => video.addEventListener("loadeddata", resolve, { once: true }));
}

async function populateCameraList(preferredId = "") {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cameras = devices.filter((device) => device.kind === "videoinput");
  elements.cameraSelect.replaceChildren();

  cameras.forEach((camera, index) => {
    const option = document.createElement("option");
    option.value = camera.deviceId;
    option.textContent = camera.label || `Camera ${index + 1}`;
    elements.cameraSelect.append(option);
  });

  const rearCamera = cameras.find((camera) => /back|rear|environment/i.test(camera.label));
  const selected = cameras.find((camera) => camera.deviceId === preferredId) || rearCamera || cameras[0];
  if (selected) elements.cameraSelect.value = selected.deviceId;
  elements.cameraSelect.disabled = cameras.length < 2;
  elements.switchCamera.hidden = cameras.length < 2;
}

async function startCamera(deviceId = elements.cameraSelect.value) {
  if (!navigator.mediaDevices?.getUserMedia) {
    setCameraMessage("Camera access is not supported here. Choose a saved photo instead.", true);
    return;
  }

  elements.startCamera.disabled = true;
  setCameraMessage("Requesting camera access…");
  stopCamera();

  try {
    const video = deviceId
      ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 1280 } }
      : { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 1280 } };

    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video });
    elements.webcam.srcObject = stream;
    await elements.webcam.play();
    await waitForVideo(elements.webcam);

    sourceMode = "camera";
    sourceReady = true;
    elements.webcam.hidden = false;
    elements.snapshot.hidden = true;
    elements.cameraEmpty.hidden = true;
    elements.frameGuide.hidden = false;
    elements.startCamera.innerHTML = "<span>Retake with camera</span>";
    setCameraMessage("Keep the leaf still, fill the guide, then analyze.");

    const activeId = stream.getVideoTracks()[0]?.getSettings().deviceId || deviceId;
    await populateCameraList(activeId);
    updateAnalyzeButton();
  } catch (error) {
    console.error("Camera access failed", error);
    sourceReady = sourceMode === "photo";
    setCameraMessage("Camera access was blocked or unavailable. You can still choose a saved photo.", true);
    updateAnalyzeButton();
  } finally {
    elements.startCamera.disabled = false;
  }
}

function drawSquareImage(source, sourceWidth, sourceHeight) {
  const context = elements.snapshot.getContext("2d", { willReadFrequently: true });
  const side = Math.min(sourceWidth, sourceHeight);
  const sourceX = (sourceWidth - side) / 2;
  const sourceY = (sourceHeight - side) / 2;
  context.clearRect(0, 0, IMAGE_SIZE, IMAGE_SIZE);
  context.drawImage(source, sourceX, sourceY, side, side, 0, 0, IMAGE_SIZE, IMAGE_SIZE);
}

async function usePhoto(file) {
  if (!file) return;
  if (!file.type.startsWith("image/")) {
    setCameraMessage("Please choose an image file.", true);
    return;
  }

  const url = URL.createObjectURL(file);
  const image = new Image();
  image.decoding = "async";

  try {
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = reject;
      image.src = url;
    });
    drawSquareImage(image, image.naturalWidth, image.naturalHeight);
    stopCamera();
    sourceMode = "photo";
    sourceReady = true;
    elements.webcam.hidden = true;
    elements.snapshot.hidden = false;
    elements.cameraEmpty.hidden = true;
    elements.frameGuide.hidden = true;
    setCameraMessage("Photo ready. Analyze when the leaf is clear and centered.");
    updateAnalyzeButton();
  } catch (error) {
    console.error("Could not read image", error);
    setCameraMessage("That photo could not be read. Please choose another image.", true);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function useDemoPhoto() {
  const image = new Image();
  image.decoding = "async";
  elements.samplePhoto.disabled = true;
  setCameraMessage("Loading the demo leaf…");

  try {
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = reject;
      image.src = DEMO_URL;
    });
    drawSquareImage(image, image.naturalWidth, image.naturalHeight);
    stopCamera();
    sourceMode = "photo";
    sourceReady = true;
    elements.webcam.hidden = true;
    elements.snapshot.hidden = false;
    elements.cameraEmpty.hidden = true;
    elements.frameGuide.hidden = true;
    setCameraMessage("Demo leaf ready. Select Analyze leaf to test the detector.");
    updateAnalyzeButton();
  } catch (error) {
    console.error("Could not load demo image", error);
    setCameraMessage("The demo photo could not be loaded.", true);
  } finally {
    elements.samplePhoto.disabled = false;
  }
}

function canvasToTensor() {
  const context = elements.snapshot.getContext("2d", { willReadFrequently: true });
  const rgba = context.getImageData(0, 0, IMAGE_SIZE, IMAGE_SIZE).data;
  const rgb = new Float32Array(IMAGE_SIZE * IMAGE_SIZE * 3);

  for (let source = 0, target = 0; source < rgba.length; source += 4) {
    rgb[target++] = rgba[source];
    rgb[target++] = rgba[source + 1];
    rgb[target++] = rgba[source + 2];
  }
  return new ort.Tensor("float32", rgb, [1, IMAGE_SIZE, IMAGE_SIZE, 3]);
}

function confidenceText(probability) {
  if (probability >= 0.75) return "Strong visual match";
  if (probability >= 0.5) return "Moderate visual match";
  return "Low confidence · verify";
}

function isUnsupportedResult(results) {
  const [top, runnerUp] = results;
  return top.probability < MIN_SUPPORTED_CONFIDENCE
    || top.probability - runnerUp.probability < MIN_SUPPORTED_MARGIN;
}

function renderResult(scores) {
  const results = LABELS.map((label, index) => ({ ...label, probability: Number(scores[index]) }))
    .sort((a, b) => b.probability - a.probability);
  const top = results[0];
  const unsupported = isUnsupportedResult(results);

  elements.resultPlaceholder.hidden = true;
  elements.resultContent.hidden = false;
  elements.resultIcon.textContent = unsupported ? "?" : top.icon;
  elements.confidenceBadge.textContent = unsupported
    ? "No reliable corn-leaf match"
    : confidenceText(top.probability);
  elements.resultKicker.textContent = unsupported
    ? `Best supported match: ${top.name} at ${(top.probability * 100).toFixed(1)}%`
    : `${(top.probability * 100).toFixed(1)}% model confidence`;
  elements.resultName.textContent = unsupported ? "Other or unsupported object" : top.name;
  elements.resultSummary.textContent = unsupported
    ? "This photo does not clearly match a supported corn-leaf class. It may show another object, an unsupported plant or disease, or a leaf that is too unclear to screen safely."
    : top.summary;
  elements.guideLink.hidden = unsupported;
  if (!unsupported) elements.guideLink.href = `./menu/corn_mang.html#${top.guide}`;
  elements.probabilities.replaceChildren();

  results.forEach((result, index) => {
    const row = document.createElement("div");
    row.className = `probability-row${index === 0 ? " top" : ""}`;

    const label = document.createElement("span");
    label.className = "probability-label";
    label.textContent = result.name;

    const value = document.createElement("span");
    value.className = "probability-value";
    value.textContent = `${(result.probability * 100).toFixed(1)}%`;

    const track = document.createElement("div");
    track.className = "probability-track";
    const fill = document.createElement("div");
    fill.className = "probability-fill";
    fill.style.width = `${Math.max(0, Math.min(100, result.probability * 100))}%`;
    track.append(fill);
    row.append(label, value, track);
    elements.probabilities.append(row);
  });

  if (window.innerWidth < 850) {
    elements.resultContent.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return unsupported;
}

async function analyzeLeaf() {
  if (!session || !sourceReady || analyzing) return;
  analyzing = true;
  updateAnalyzeButton();
  elements.analyzeButton.querySelector("span").textContent = "Analyzing on this device…";
  setCameraMessage("Reading leaf patterns…");

  try {
    if (sourceMode === "camera") {
      drawSquareImage(elements.webcam, elements.webcam.videoWidth, elements.webcam.videoHeight);
      elements.webcam.hidden = true;
      elements.snapshot.hidden = false;
      elements.frameGuide.hidden = true;
    }

    const feeds = { [session.inputNames[0]]: canvasToTensor() };
    const output = await session.run(feeds);
    const scores = output[session.outputNames[0]].data;
    if (scores.length !== LABELS.length) throw new Error("Unexpected model output");

    const unsupported = renderResult(scores);
    setCameraMessage(unsupported
      ? "No supported corn-leaf match found. Try a clear, centered photo of one corn leaf."
      : "Analysis complete. Retake or choose another photo to compare.");
  } catch (error) {
    console.error("Leaf analysis failed", error);
    setCameraMessage("Analysis failed. Please try a clearer photo.", true);
  } finally {
    analyzing = false;
    elements.analyzeButton.querySelector("span").textContent = "Analyze leaf";
    updateAnalyzeButton();
  }
}

async function switchCamera() {
  const options = [...elements.cameraSelect.options];
  if (options.length < 2) return;
  const currentIndex = Math.max(0, options.findIndex((option) => option.value === elements.cameraSelect.value));
  const next = options[(currentIndex + 1) % options.length];
  elements.cameraSelect.value = next.value;
  await startCamera(next.value);
}

elements.startCamera.addEventListener("click", () => startCamera());
elements.switchCamera.addEventListener("click", switchCamera);
elements.cameraSelect.addEventListener("change", () => startCamera(elements.cameraSelect.value));
elements.photoInput.addEventListener("change", (event) => usePhoto(event.target.files?.[0]));
elements.samplePhoto.addEventListener("click", useDemoPhoto);
elements.analyzeButton.addEventListener("click", analyzeLeaf);
window.addEventListener("pagehide", stopCamera);

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  elements.installButton.hidden = false;
});

elements.installButton.addEventListener("click", async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  elements.installButton.hidden = true;
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js").catch((error) => {
      console.warn("Offline support could not be enabled", error);
    });
  });
}

loadModel();
