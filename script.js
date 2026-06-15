let model = null;
let appState = "loading"; 
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

const telemetryPanel = document.getElementById("telemetryPanel");
const sliderSection = document.getElementById("sliderSection");

confidenceSlider.oninput = () => { confidenceVal.textContent = parseFloat(confidenceSlider.value).toFixed(2); };

const TRACKING_GRACE_PERIOD = 30; 
let activeDetectionsArray = [];
let detectionMemory = new Map(); 

let isRecording = false;
let holdTimeout;
let mediaRecorder;
let recordedChunks = [];
let reviewType = null; 
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
    
    const loadingOverlay = document.getElementById("loadingOverlay");
    if (loadingOverlay) {
        if (appState === "loading") {
            loadingOverlay.classList.remove("fade-out");
            const statusText = loadingOverlay.querySelector(".loading-status");
            if (statusText) {
                statusText.textContent = (model === null) ? "Waking up Neural Engine..." : "Processing Image...";
            }
        } else {
            loadingOverlay.classList.add("fade-out");
        }
    }
    
    switchBtn.classList.add("hidden");
    shutterWrapper.classList.add("hidden"); 
    uploadWrapper.classList.add("hidden");
    discardBtn.classList.add("hidden"); 
    saveBtn.classList.add("hidden");
    reviewVideo.classList.add("hidden"); 
    reviewImage.classList.add("hidden");
    telemetryPanel.classList.add("hidden");
    sliderSection.classList.add("hidden");
    canvas.style.opacity = "1";

    switch (appState) {
        case "loading":
            statusIndicator.textContent = "INITIALIZING"; 
            statusIndicator.className = "status-tag loading";
            break;
        case "streaming":
            shutterWrapper.classList.remove("hidden"); 
            switchBtn.classList.remove("hidden");
            uploadWrapper.classList.remove("hidden");
            telemetryPanel.classList.remove("hidden");
            if (window.innerWidth >= 900) sliderSection.classList.remove("hidden");
            
            statusIndicator.textContent = "LIVE"; 
            statusIndicator.className = "status-tag streaming";
            ctx.clearRect(0, 0, canvas.width, canvas.height); 
            break;
        case "review":
            discardBtn.classList.remove("hidden"); 
            saveBtn.classList.remove("hidden");
            telemetryPanel.classList.remove("hidden");
            
            statusIndicator.textContent = "REVIEW"; 
            statusIndicator.className = "status-tag ready";
            canvas.style.opacity = "0"; 
            
            if (reviewType === 'video') {
                reviewVideo.classList.remove("hidden");
                reviewVideo.src = reviewDataUrl;
            } else {
                reviewImage.classList.remove("hidden");
                reviewImage.src = reviewDataUrl;
            }
            break;
        case "error":
            uploadWrapper.classList.remove("hidden");
            statusIndicator.textContent = "CAMERA ERROR"; 
            statusIndicator.className = "status-tag loading";
            break;
    }
}

async function initEngine() {
    setUIState("loading");
    try { 
        model = await cocoSsd.load(); 
        await startCamera(); 
    } 
    catch (err) { 
        setUIState("error"); 
    }
}


function getRenderScale(source) {
    const sWidth = source.videoWidth || source.naturalWidth || source.width || 1; 
    const sHeight = source.videoHeight || source.naturalHeight || source.height || 1;
    
    const frameRect = visionFrame.getBoundingClientRect();
    const fWidth = frameRect.width; const fHeight = frameRect.height;
    
    const scale = Math.max(fWidth / sWidth, fHeight / sHeight);
    
    const renderWidth = sWidth * scale;
    const renderHeight = sHeight * scale;
    
    const offsetX = (fWidth - renderWidth) / 2;
    const offsetY = (fHeight - renderHeight) / 2;

    return { scaleX: scale, scaleY: scale, offsetX: offsetX, offsetY: offsetY };
}

function executeRenderTick() {
    if (appState !== "streaming") return; 

    const displayRect = visionFrame.getBoundingClientRect();
    canvas.width = displayRect.width * window.devicePixelRatio;
    canvas.height = displayRect.height * window.devicePixelRatio;
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
    
    ctx.clearRect(0, 0, displayRect.width, displayRect.height);

    const source = usingCamera ? video : staticDisplay;
    
    if (source.readyState >= 2 || source.complete) {
        const mapping = getRenderScale(source);
        const sWidth = source.videoWidth || source.naturalWidth || source.width;
        const sHeight = source.videoHeight || source.naturalHeight || source.height;

        ctx.drawImage(source, 0, 0, sWidth, sHeight, mapping.offsetX, mapping.offsetY, sWidth * mapping.scaleX, sHeight * mapping.scaleY);

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
            
            ctx.fillStyle = "rgba(0, 0, 0, 0.5)";
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
        objectList.innerHTML = '<li class="placeholder-text">Scanning area...</li>';
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
        li.innerHTML = `<span>${p.class.charAt(0).toUpperCase() + p.class.slice(1)}</span> <span style="font-weight:600;">${(p.score * 100).toFixed(0)}%</span>`;
        objectList.appendChild(li);
    });

    for (const key in aggregator) {
        const li = document.createElement("li");
        li.innerHTML = `<span>${key.charAt(0).toUpperCase() + key.slice(1)}</span> <span style="background:rgba(255,255,255,0.2); padding:2px 8px; border-radius:10px;">${aggregator[key]}</span>`;
        objectSummary.appendChild(li);
    }
}

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

shutterWrapper.addEventListener('pointerdown', (e) => {
    if(appState !== 'streaming') return;
    shutterWrapper.style.transform = "scale(0.92)";
    holdTimeout = setTimeout(() => { startVideoRecording(); }, 400); 
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

function takePhotoSnapshot() {
    reviewDataUrl = canvas.toDataURL("image/png");
    reviewType = 'photo';
    stopCameraBackground();
    setUIState("review");
}

function startVideoRecording() {
    isRecording = true;
    shutterBtn.classList.add("recording");
    
    const canvasStream = canvas.captureStream(30);
    
    let mimeType = 'video/webm; codecs=vp9';
    if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = 'video/webm; codecs=vp8';
    if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = 'video/webm';
    if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = ''; 
    
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

discardBtn.onclick = () => {
    if (reviewType === 'video' && reviewDataUrl) URL.revokeObjectURL(reviewDataUrl);
    reviewDataUrl = null;
    startCamera(); 
};

saveBtn.onclick = () => {
    const anchor = document.createElement("a");
    anchor.download = `VisionDetect_${Date.now()}.${reviewType === 'video' ? 'webm' : 'png'}`;
    anchor.href = reviewDataUrl;
    anchor.click();
    discardBtn.click(); 
};

async function startCamera() {
    if (stream) stopCameraBackground();

    try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facingMode }, audio: false });
        video.srcObject = stream;
        await new Promise((resolve) => video.onloadedmetadata = resolve);
        await video.play();

        usingCamera = true; 
        activeDetectionsArray = [];
        detectionMemory.clear();
        setUIState("streaming");
        
        executeRenderTick();
        analyticalProcessLoop();
    } catch (err) {
        setUIState("error");
    }
}

function stopCameraBackground() {
    if (animationFrameId) cancelAnimationFrame(animationFrameId);
    if (renderFrameId) cancelAnimationFrame(renderFrameId);
    if (stream) { stream.getTracks().forEach(track => track.stop()); stream = null; }
    video.srcObject = null;
}

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
            
            appState = "streaming"; 
            executeRenderTick();
            cancelAnimationFrame(renderFrameId); 
            writeTelemetryLists(activeDetectionsArray);
            
            reviewDataUrl = canvas.toDataURL("image/png");
            reviewType = 'photo';
            setUIState("review");
            
        } catch (err) {
            startCamera(); 
        }
        URL.revokeObjectURL(localUri);
        imageUpload.value = ""; 
    };
    staticDisplay.src = localUri;
};

initEngine();