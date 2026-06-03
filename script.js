let model = null;
let appState = "loading"; // loading, ready, streaming, review
let stream = null;
let usingCamera = false;
let facingMode = "environment";
let animationFrameId = null;
let renderFrameId = null;

const visionFrame = document.getElementById("visionFrame");
const video = document.getElementById("video");
const staticDisplay = document.getElementById("staticDisplay");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");

const reviewVideo = document.getElementById("reviewVideo");
const reviewImage = document.getElementById("reviewImage");

const startBtn = document.getElementById("startCamera");
const switchBtn = document.getElementById("switchCamera");
const shutterWrapper = document.getElementById("shutterWrapper");
const shutterBtn = document.getElementById("shutterBtn");
const discardBtn = document.getElementById("discardBtn");
const saveBtn = document.getElementById("saveBtn");
const uploadWrapper = document.getElementById("uploadWrapper");
const imageUpload = document.getElementById("imageUpload");
const statusIndicator = document.getElementById("statusIndicator");
const confidenceSlider = document.getElementById("confidenceSlider");
const confidenceVal = document.getElementById("confidenceValue");
const objectList = document.getElementById("objectList");
const objectSummary = document.getElementById("objectSummary");

confidenceSlider.oninput = () => { confidenceVal.textContent = parseFloat(confidenceSlider.value).toFixed(2); };

const TRACKING_GRACE_PERIOD = 30; 
let activeDetectionsArray = [];
let detectionMemory = new Map(); 

// --- Shutter Variables ---
let isRecording = false;
let holdTimeout;
let mediaRecorder;
let recordedChunks = [];
let reviewType = null; // 'photo' or 'video'
let reviewDataUrl = null;

function updateTrackingMemory(currentDetections) {
    detectionMemory.forEach((data, key) => {
        data.lifespan -= 1;
        if (data.lifespan <= 0) detectionMemory.delete(key); 
    });

    currentDetections.forEach(det => {
        const key = det.class; 
        if (detectionMemory.has(key)) {
            const existing = detectionMemory.get(key);
            existing.bbox = det.bbox;
            existing.score = det.score;
            existing.lifespan = TRACKING_GRACE_PERIOD;
            existing.stale = false;
        } else {
            detectionMemory.set(key, { class: det.class, bbox: det.bbox, score: det.score, lifespan: TRACKING_GRACE_PERIOD, stale: false });
        }
    });

    detectionMemory.forEach((data) => { if (data.lifespan < TRACKING_GRACE_PERIOD - 5) data.stale = true; });
    return Array.from(detectionMemory.values());
}

function setUIState(newState) {
    appState = newState;
    
    startBtn.classList.add("hidden"); switchBtn.classList.add("hidden");
    shutterWrapper.classList.add("hidden"); uploadWrapper.classList.add("hidden");
    discardBtn.classList.add("hidden"); saveBtn.classList.add("hidden");
    reviewVideo.classList.add("hidden"); reviewImage.classList.add("hidden");
    canvas.style.opacity = "1";

    switch (appState) {
        case "loading":
            uploadWrapper.classList.remove("hidden"); imageUpload.disabled = true;
            break;
        case "ready":
            startBtn.classList.remove("hidden"); uploadWrapper.classList.remove("hidden");
            startBtn.disabled = false; imageUpload.disabled = false;
            statusIndicator.textContent = "READY"; statusIndicator.className = "status-tag ready";
            activeDetectionsArray = []; detectionMemory.clear(); 
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            break;
        case "streaming":
            shutterWrapper.classList.remove("hidden"); switchBtn.classList.remove("hidden");
            statusIndicator.textContent = "LIVE"; statusIndicator.className = "status-tag streaming";
            break;
        case "review":
            discardBtn.classList.remove("hidden"); saveBtn.classList.remove("hidden");
            statusIndicator.textContent = "REVIEW"; statusIndicator.className = "status-tag ready";
            canvas.style.opacity = "0"; // Hide live canvas, show review media
            
            if (reviewType === 'video') {
                reviewVideo.classList.remove("hidden");
                reviewVideo.src = reviewDataUrl;
            } else {
                reviewImage.classList.remove("hidden");
                reviewImage.src = reviewDataUrl;
            }
            break;
    }
}

async function initEngine() {
    setUIState("loading");
    try { model = await cocoSsd.load(); setUIState("ready"); } 
    catch (err) { statusIndicator.textContent = "ERROR"; alert("Failed to initialize ML engine."); }
}

function getRenderScale(source) {
    const sWidth = source.videoWidth || source.naturalWidth || source.width || 1; 
    const sHeight = source.videoHeight || source.naturalHeight || source.height || 1;
    
    const frameRect = visionFrame.getBoundingClientRect();
    const fWidth = frameRect.width; const fHeight = frameRect.height;
    const srcRatio = sWidth / sHeight; const frameRatio = fWidth / fHeight;

    let renderWidth, renderHeight, offsetX, offsetY;

    if (srcRatio > frameRatio) {
        renderWidth = fWidth; renderHeight = fWidth / srcRatio;
        offsetX = 0; offsetY = (fHeight - renderHeight) / 2;
    } else {
        renderHeight = fHeight; renderWidth = fHeight * srcRatio;
        offsetX = (fWidth - renderWidth) / 2; offsetY = 0;
    }

    return { scaleX: renderWidth / sWidth, scaleY: renderHeight / sHeight, offsetX: offsetX, offsetY: offsetY };
}

// Master Render Pipeline: Flattens Video + HUD onto the Canvas
function executeRenderTick() {
    if (appState !== "streaming" && appState !== "ready") return; // Stop drawing during review

    const displayRect = visionFrame.getBoundingClientRect();
    canvas.width = displayRect.width * window.devicePixelRatio;
    canvas.height = displayRect.height * window.devicePixelRatio;
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
    
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, displayRect.width, displayRect.height);

    const source = usingCamera ? video : staticDisplay;
    
    if (source.readyState >= 2 || source.complete) {
        const mapping = getRenderScale(source);
        const sWidth = source.videoWidth || source.naturalWidth || source.width;
        const sHeight = source.videoHeight || source.naturalHeight || source.height;

        // Draw Source Image/Video base
        ctx.drawImage(source, 0, 0, sWidth, sHeight, mapping.offsetX, mapping.offsetY, sWidth * mapping.scaleX, sHeight * mapping.scaleY);

        // Draw HUD Overlays
        activeDetectionsArray.forEach(p => {
            if (p.stale && usingCamera) return; 

            const [bboxX, bboxY, bboxW, bboxH] = p.bbox;
            const x = (bboxX * mapping.scaleX) + mapping.offsetX;
            const y = (bboxY * mapping.scaleY) + mapping.offsetY;
            const w = bboxW * mapping.scaleX; const h = bboxH * mapping.scaleY;

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

    renderFrameId = requestAnimationFrame(executeRenderTick);
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

// Background AI Process
async function analyticalProcessLoop() {
    if (appState !== "streaming") return;
    if (usingCamera && video.readyState !== 4) { animationFrameId = requestAnimationFrame(analyticalProcessLoop); return; }
    
    const currentThreshold = parseFloat(confidenceSlider.value);
    try {
        const rawDetections = await model.detect(usingCamera ? video : staticDisplay);
        const filtered = rawDetections.filter(p => p.score >= currentThreshold);
        activeDetectionsArray = updateTrackingMemory(filtered);
        writeTelemetryLists(activeDetectionsArray);
    } catch (e) {}
    animationFrameId = requestAnimationFrame(analyticalProcessLoop);
}

// ==========================================
// SHUTTER INTERACTION LOGIC (Tap vs Hold)
// ==========================================
shutterWrapper.addEventListener('pointerdown', (e) => {
    if(appState !== 'streaming') return;
    shutterWrapper.style.transform = "scale(0.92)";
    holdTimeout = setTimeout(() => { startVideoRecording(); }, 400); // 400ms hold triggers video
});

const endShutterInteraction = () => {
    shutterWrapper.style.transform = "scale(1)";
    if (isRecording) {
        stopVideoRecording();
    } else {
        clearTimeout(holdTimeout);
        takePhotoSnapshot();
    }
};

shutterWrapper.addEventListener('pointerup', endShutterInteraction);
shutterWrapper.addEventListener('pointerleave', () => {
    shutterWrapper.style.transform = "scale(1)";
    clearTimeout(holdTimeout);
    if (isRecording) stopVideoRecording();
});
shutterWrapper.addEventListener('pointercancel', () => {
    shutterWrapper.style.transform = "scale(1)";
    clearTimeout(holdTimeout);
    if (isRecording) stopVideoRecording();
});

// Snap Photo
function takePhotoSnapshot() {
    // Canvas already contains the flattened video + HUD
    reviewDataUrl = canvas.toDataURL("image/png");
    reviewType = 'photo';
    
    stopCameraBackground();
    setUIState("review");
}

// Record Video (Baking canvas stream into a file)
function startVideoRecording() {
    isRecording = true;
    shutterBtn.classList.add("recording");
    
    const canvasStream = canvas.captureStream(30);
    
    let mimeType = 'video/webm; codecs=vp9';
    if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = 'video/webm; codecs=vp8';
    if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = 'video/webm';
    if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = ''; // Let browser decide
    
    mediaRecorder = new MediaRecorder(canvasStream, { mimeType: mimeType });
    recordedChunks = [];
    
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); };
    
    mediaRecorder.onstop = () => {
        const blob = new Blob(recordedChunks, { type: mediaRecorder.mimeType || 'video/webm' });
        reviewDataUrl = URL.createObjectURL(blob);
        reviewType = 'video';
        
        stopCameraBackground();
        setUIState("review");
    };
    
    mediaRecorder.start();
}

function stopVideoRecording() {
    isRecording = false;
    shutterBtn.classList.remove("recording");
    if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
}

// Handle Review Actions
discardBtn.onclick = () => {
    if (reviewType === 'video' && reviewDataUrl) URL.revokeObjectURL(reviewDataUrl);
    reviewDataUrl = null;
    startCamera(); // Go back to live view
};

saveBtn.onclick = () => {
    const anchor = document.createElement("a");
    anchor.download = `VisionDetect_${Date.now()}.${reviewType === 'video' ? 'webm' : 'png'}`;
    anchor.href = reviewDataUrl;
    anchor.click();
    
    // Optional: Return to live camera after saving
    discardBtn.click(); 
};

// ==========================================
// CAMERA / SYSTEM LIFECYCLE
// ==========================================
async function startCamera() {
    if (stream) stopCameraBackground();
    setUIState("loading");

    try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facingMode }, audio: false });
        video.srcObject = stream;
        await new Promise((resolve) => video.onloadedmetadata = resolve);
        await video.play();

        usingCamera = true; 
        setUIState("streaming");
        
        // Kick off both loops
        executeRenderTick();
        analyticalProcessLoop();
    } catch (err) {
        alert("Camera access denied or unavailable.");
        setUIState("ready");
    }
}

function stopCameraBackground() {
    if (animationFrameId) cancelAnimationFrame(animationFrameId);
    if (renderFrameId) cancelAnimationFrame(renderFrameId);
    if (stream) { stream.getTracks().forEach(track => track.stop()); stream = null; }
    video.srcObject = null;
}

startBtn.onclick = startCamera;

switchBtn.onclick = async () => {
    facingMode = facingMode === "environment" ? "user" : "environment";
    await startCamera();
};

imageUpload.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    if (stream) stopCameraBackground();
    setUIState("loading");
    const localUri = URL.createObjectURL(file);

    staticDisplay.onload = async () => {
        usingCamera = false; 
        try {
            const currentThreshold = parseFloat(confidenceSlider.value);
            const rawDetections = await model.detect(staticDisplay);
            activeDetectionsArray = rawDetections.filter(p => p.score >= currentThreshold);
            
            // Force a single manual render tick to draw the image + boxes to canvas
            appState = "streaming"; // temporarily bypass safety check
            executeRenderTick();
            cancelAnimationFrame(renderFrameId); 
            writeTelemetryLists(activeDetectionsArray);
            
            // Immediately transition to review mode to allow save/discard
            reviewDataUrl = canvas.toDataURL("image/png");
            reviewType = 'photo';
            setUIState("review");
            
        } catch (err) {
            setUIState("ready");
        }
        URL.revokeObjectURL(localUri);
        imageUpload.value = "";
    };
    staticDisplay.src = localUri;
};

initEngine();