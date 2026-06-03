let model = null;
let running = false;
let stream = null;
let usingCamera = false;
let facingMode = "environment";
let animationFrameId = null;

const visionFrame = document.getElementById("visionFrame");
const video = document.getElementById("video");
const staticDisplay = document.getElementById("staticDisplay");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");

const startBtn = document.getElementById("startCamera");
const switchBtn = document.getElementById("switchCamera");
const stopBtn = document.getElementById("stopCamera");
const downloadBtn = document.getElementById("downloadBtn");
const resetBtn = document.getElementById("resetBtn");
const imageUpload = document.getElementById("imageUpload");
const uploadWrapper = document.getElementById("uploadWrapper");
const statusIndicator = document.getElementById("statusIndicator");
const confidenceSlider = document.getElementById("confidenceSlider");
const confidenceVal = document.getElementById("confidenceValue");
const objectList = document.getElementById("objectList");
const objectSummary = document.getElementById("objectSummary");

confidenceSlider.oninput = () => { confidenceVal.textContent = parseFloat(confidenceSlider.value).toFixed(2); };

const TRACKING_GRACE_PERIOD = 30; 
let activeDetections = new Map(); 

function updateTrackingMemory(currentDetections) {
    activeDetections.forEach((data, key) => {
        data.lifespan -= 1;
        if (data.lifespan <= 0) activeDetections.delete(key); 
    });

    currentDetections.forEach(det => {
        const key = det.class; 
        if (activeDetections.has(key)) {
            const existing = activeDetections.get(key);
            existing.bbox = det.bbox;
            existing.score = det.score;
            existing.lifespan = TRACKING_GRACE_PERIOD;
            existing.stale = false;
        } else {
            activeDetections.set(key, { class: det.class, bbox: det.bbox, score: det.score, lifespan: TRACKING_GRACE_PERIOD, stale: false });
        }
    });

    activeDetections.forEach((data) => { if (data.lifespan < TRACKING_GRACE_PERIOD - 5) data.stale = true; });
    return Array.from(activeDetections.values());
}

function setUIState(state) {
    startBtn.classList.add("hidden"); switchBtn.classList.add("hidden");
    stopBtn.classList.add("hidden"); downloadBtn.classList.add("hidden");
    resetBtn.classList.add("hidden"); uploadWrapper.classList.add("hidden");

    switch (state) {
        case "loading":
            uploadWrapper.classList.remove("hidden"); imageUpload.disabled = true;
            break;
        case "ready":
            startBtn.classList.remove("hidden"); uploadWrapper.classList.remove("hidden");
            startBtn.disabled = false; imageUpload.disabled = false;
            statusIndicator.textContent = "READY"; statusIndicator.className = "status-tag ready";
            activeDetections.clear(); 
            video.classList.add("hidden"); staticDisplay.classList.add("hidden");
            break;
        case "streaming":
            stopBtn.classList.remove("hidden"); switchBtn.classList.remove("hidden"); downloadBtn.classList.remove("hidden");
            stopBtn.disabled = false; switchBtn.disabled = false; downloadBtn.disabled = false;
            statusIndicator.textContent = "LIVE"; statusIndicator.className = "status-tag streaming";
            video.classList.remove("hidden"); staticDisplay.classList.add("hidden");
            break;
        case "static":
            resetBtn.classList.remove("hidden"); uploadWrapper.classList.remove("hidden"); downloadBtn.classList.remove("hidden");
            resetBtn.disabled = false; imageUpload.disabled = false; downloadBtn.disabled = false;
            statusIndicator.textContent = "ANALYSIS COMPLETE"; statusIndicator.className = "status-tag ready";
            video.classList.add("hidden"); staticDisplay.classList.remove("hidden");
            break;
    }
}

async function initEngine() {
    setUIState("loading");
    try { model = await cocoSsd.load(); setUIState("ready"); } 
    catch (err) { statusIndicator.textContent = "ERROR"; alert("Failed to initialize ML engine."); }
}

function getRenderScale(source) {
    const sWidth = source.videoWidth || source.naturalWidth || source.width; 
    const sHeight = source.videoHeight || source.naturalHeight || source.height;
    
    const frameRect = visionFrame.getBoundingClientRect();
    const fWidth = frameRect.width; 
    const fHeight = frameRect.height;
    
    const srcRatio = sWidth / sHeight; 
    const frameRatio = fWidth / fHeight;

    let renderWidth, renderHeight, offsetX, offsetY;

    if (srcRatio > frameRatio) {
        renderWidth = fWidth; 
        renderHeight = fWidth / srcRatio;
        offsetX = 0; 
        offsetY = (fHeight - renderHeight) / 2;
    } else {
        renderHeight = fHeight; 
        renderWidth = fHeight * srcRatio;
        offsetX = (fWidth - renderWidth) / 2; 
        offsetY = 0;
    }

    return { scaleX: renderWidth / sWidth, scaleY: renderHeight / sHeight, offsetX: offsetX, offsetY: offsetY };
}

function renderTelemetry(source, stabilizedDetections) {
    const displayRect = visionFrame.getBoundingClientRect();
    canvas.width = displayRect.width * window.devicePixelRatio;
    canvas.height = displayRect.height * window.devicePixelRatio;
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
    ctx.clearRect(0, 0, displayRect.width, displayRect.height);

    const mapping = getRenderScale(source);

    stabilizedDetections.forEach(p => {
        if (p.stale && usingCamera) return; 

        const [bboxX, bboxY, bboxW, bboxH] = p.bbox;
        const x = (bboxX * mapping.scaleX) + mapping.offsetX;
        const y = (bboxY * mapping.scaleY) + mapping.offsetY;
        const w = bboxW * mapping.scaleX; 
        const h = bboxH * mapping.scaleY;

        ctx.strokeStyle = "rgba(255, 255, 255, 0.9)"; 
        ctx.lineWidth = 1.5; ctx.lineJoin = "round";
        ctx.strokeRect(x, y, w, h);

        const txt = `${p.class.charAt(0).toUpperCase() + p.class.slice(1)} ${(p.score * 100).toFixed(0)}%`;
        ctx.font = "500 11px -apple-system, BlinkMacSystemFont, 'Inter', sans-serif";
        const textWidth = ctx.measureText(txt).width;
        
        const badgeY = y - 24 > 0 ? y - 24 : y + 8;
        
        ctx.fillStyle = "rgba(28, 28, 30, 0.75)";
        ctx.beginPath();
        ctx.roundRect(x, badgeY, textWidth + 12, 20, 6);
        ctx.fill();

        ctx.fillStyle = "#FFFFFF";
        ctx.fillText(txt, x + 6, badgeY + 14);
    });
}

function writeTelemetryLists(stabilizedDetections) {
    if (stabilizedDetections.length === 0) {
        objectList.innerHTML = '<li class="placeholder-text">No subjects detected</li>';
        objectSummary.innerHTML = '<li class="placeholder-text">—</li>';
        return;
    }

    const sorted = [...stabilizedDetections].sort((a, b) => a.class.localeCompare(b.class));
    objectList.innerHTML = ""; objectSummary.innerHTML = "";
    const aggregator = {};

    sorted.forEach(p => {
        aggregator[p.class] = (aggregator[p.class] || 0) + 1;
        const li = document.createElement("li");
        if (p.stale) li.classList.add("stale");
        li.innerHTML = `<span>${p.class.charAt(0).toUpperCase() + p.class.slice(1)}</span> <span style="font-weight:600; color:var(--text-muted)">${(p.score * 100).toFixed(0)}%</span>`;
        objectList.appendChild(li);
    });

    for (const key in aggregator) {
        const li = document.createElement("li");
        li.innerHTML = `<span>${key.charAt(0).toUpperCase() + key.slice(1)}</span> <span style="background:rgba(255,255,255,0.1); padding:2px 8px; border-radius:10px;">${aggregator[key]}</span>`;
        objectSummary.appendChild(li);
    }
}

async function analyticalProcessLoop() {
    if (!running) return;
    if (usingCamera && video.readyState !== 4) { animationFrameId = requestAnimationFrame(analyticalProcessLoop); return; }
    
    const currentThreshold = parseFloat(confidenceSlider.value);
    try {
        const rawDetections = await model.detect(usingCamera ? video : staticDisplay);
        const filtered = rawDetections.filter(p => p.score >= currentThreshold);
        const stabilizedDetections = updateTrackingMemory(filtered);
        
        renderTelemetry(usingCamera ? video : staticDisplay, stabilizedDetections);
        writeTelemetryLists(stabilizedDetections);
    } catch (e) { console.error(e); }
    animationFrameId = requestAnimationFrame(analyticalProcessLoop);
}

async function startCamera() {
    if (stream) stopCamera();
    setUIState("loading");

    try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facingMode }, audio: false });
        video.srcObject = stream;
        await new Promise((resolve) => video.onloadedmetadata = resolve);
        await video.play();

        usingCamera = true; running = true;
        activeDetections.clear(); 
        setUIState("streaming");
        analyticalProcessLoop();
    } catch (err) {
        alert("Camera access denied or unavailable.");
        setUIState("ready");
    }
}

function stopCamera() {
    running = false;
    if (animationFrameId) cancelAnimationFrame(animationFrameId);
    if (stream) { stream.getTracks().forEach(track => track.stop()); stream = null; }
    video.srcObject = null;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    setUIState("ready");
    objectList.innerHTML = '<li class="placeholder-text">Ready</li>';
    objectSummary.innerHTML = '<li class="placeholder-text">—</li>';
}

function resetStaticImage() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    staticDisplay.src = "";
    setUIState("ready");
    objectList.innerHTML = '<li class="placeholder-text">Ready</li>';
    objectSummary.innerHTML = '<li class="placeholder-text">—</li>';
}

function executeSnapshot() {
    const anchor = document.createElement("a");
    anchor.download = `VisionDetect_${Date.now()}.png`;
    anchor.href = canvas.toDataURL("image/png");
    anchor.click();
}

startBtn.onclick = startCamera;
stopBtn.onclick = stopCamera;
resetBtn.onclick = resetStaticImage;
downloadBtn.onclick = executeSnapshot;

switchBtn.onclick = async () => {
    facingMode = facingMode === "environment" ? "user" : "environment";
    await startCamera();
};

imageUpload.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    stopCamera(); setUIState("loading");
    const localUri = URL.createObjectURL(file);

    staticDisplay.onload = async () => {
        usingCamera = false; running = false;
        const currentThreshold = parseFloat(confidenceSlider.value);
        
        try {
            const rawDetections = await model.detect(staticDisplay);
            const filtered = rawDetections.filter(p => p.score >= currentThreshold);
            renderTelemetry(staticDisplay, filtered);
            writeTelemetryLists(filtered);
            setUIState("static");
        } catch (err) {
            setUIState("ready");
        }
        URL.revokeObjectURL(localUri);
        imageUpload.value = "";
    };
    staticDisplay.src = localUri;
};

initEngine();