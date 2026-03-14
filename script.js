let model = null;
let running = false;
let stream = null;
let usingCamera = true;
let facingMode = "environment";

const video = document.getElementById("video");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");

const imageUpload = document.getElementById("imageUpload");
const startBtn = document.getElementById("startCamera");
const stopBtn = document.getElementById("stopCamera");
const turnBtn = document.createElement("button");
const downloadBtn = document.getElementById("downloadBtn");
turnBtn.textContent = "Turn Camera";
startBtn.parentNode.insertBefore(turnBtn, stopBtn.nextSibling);

const confidenceSlider = document.getElementById("confidenceSlider");
const confidenceVal = document.getElementById("confidenceValue");
const objectList = document.getElementById("objectList");
const objectSummary = document.getElementById("objectSummary");


confidenceVal.textContent = confidenceSlider.value;
confidenceSlider.oninput = () => { confidenceVal.textContent = confidenceSlider.value; };


async function loadModel() {
    console.log("Loading COCO-SSD...");
    model = await cocoSsd.load();
    console.log("Model loaded!");
}


async function detectSource(source) {
    if(!model) return [];
    try {
        return await model.detect(source);
    } catch(err) {
        console.error("Detection error:", err);
        return [];
    }
}


function drawDetections(source, detections) {
    canvas.width = source.videoWidth || source.width;
    canvas.height = source.videoHeight || source.height;
    ctx.drawImage(source, 0, 0);

    detections.forEach(det => {
        const [x,y,width,height] = det.bbox;
        ctx.strokeStyle = "#d4af37";
        ctx.lineWidth = 2;
        ctx.strokeRect(x,y,width,height);
        ctx.fillStyle = "#d4af37";
        ctx.font = "16px Inter";
        ctx.fillText(det.class + " " + (det.score*100).toFixed(1)+"%", x, y>10?y-5:10);
    });
}


function updateList(predictions) {
    objectList.innerHTML = "";
    objectSummary.innerHTML = "";

    if(predictions.length === 0) {
        const li = document.createElement("li");
        li.textContent = "No objects detected";
        objectList.appendChild(li);

        const li2 = document.createElement("li");
        li2.textContent = "—";
        objectSummary.appendChild(li2);
        return;
    }

    const counts = {};
    predictions.forEach(p => {
        counts[p.class] = (counts[p.class] || 0) + 1;
        const li = document.createElement("li");
        li.textContent = `${p.class} (${(p.score*100).toFixed(1)}%)`;
        objectList.appendChild(li);
    });

    for(const key in counts) {
        const li = document.createElement("li");
        li.textContent = `${key}: ${counts[key]}`;
        objectSummary.appendChild(li);
    }
}


async function detectFrame() {
    if(!running) return;
    let source = usingCamera ? video : canvas;

    if(usingCamera && video.readyState !== 4){
        requestAnimationFrame(detectFrame);
        return;
    }

    const threshold = parseFloat(confidenceSlider.value);
    const predictions = await detectSource(source);
    const filtered = predictions.filter(p => p.score >= threshold);
    drawDetections(source, filtered);
    updateList(filtered);

    requestAnimationFrame(detectFrame);
}


async function startCamera() {
    try {
        stream = await navigator.mediaDevices.getUserMedia({
         video: {
          facingMode: "environment",
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 }
          },
          audio: false
        });
        video.srcObject = stream;
        await video.play();
        usingCamera = true;
        running = true;
        detectFrame();
    } catch(err) {
        console.error("Camera start failed:", err);
        alert("Cannot access camera: " + err.message);
    }
}

function stopCamera() {
    if(!stream) return;
    stream.getTracks().forEach(t => t.stop());
    video.srcObject = null;
    stream = null;
    running = false;
}



function downloadAnnotated(canvas) {
    const link = document.createElement("a");
    link.download = "vision-detection.png";
    link.href = canvas.toDataURL("image/png");
    link.click();
}




turnBtn.onclick = async () => {
    facingMode = facingMode === "environment" ? "user" : "environment";
    if(stream) stopCamera();
    await startCamera();
}


imageUpload.onchange = async e => {
    const file = e.target.files[0];
    if(!file) return;

    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = async () => {
        usingCamera = false;
        stopCamera();
        canvas.width = img.width;
        canvas.height = img.height;
        ctx.drawImage(img, 0, 0);

        const threshold = parseFloat(confidenceSlider.value);
        const predictions = await detectSource(img);
        const filtered = predictions.filter(p => p.score >= threshold);
        drawDetections(img, filtered);
        updateList(filtered);

        imageUpload.value = "";
    }
    img.src = URL.createObjectURL(file);
}




startBtn.onclick = startCamera;
stopBtn.onclick = stopCamera;
downloadBtn.onclick = () => downloadAnnotated(canvas);




(async () => {
    await loadModel();
})(); 
