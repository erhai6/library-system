// script.js
// Simple demo: seat reservation + webcam AI monitoring (COCO-SSD)

const SEAT_COUNT = 20; // 4 rows x 5 columns
const SEAT_GRID_ID = "seat-grid";
const STATUS_EL = document.getElementById("status");
const CURRENT_SEAT_EL = document.getElementById("current-seat");
const ACTION_SECTION = document.getElementById("action-section");
const TIMER_EL = document.getElementById("timer");
const BREAK_BTN = document.getElementById("break-btn");
const RELEASE_BTN = document.getElementById("release-btn");

let selectedSeat = null;
let timerInterval = null;
let remainingSec = 0;

function initSeats() {
  const grid = document.getElementById(SEAT_GRID_ID);
  for (let i = 1; i <= SEAT_COUNT; i++) {
    const seat = document.createElement("div");
    seat.className = "seat";
    seat.textContent = i;
    seat.dataset.id = i;
    seat.onclick = () => selectSeat(seat);
    grid.appendChild(seat);
  }
}

function selectSeat(seatDiv) {
  // deselect previous
  if (selectedSeat) selectedSeat.classList.remove("selected");
  selectedSeat = seatDiv;
  selectedSeat.classList.add("selected");
  CURRENT_SEAT_EL.textContent = selectedSeat.dataset.id;
  ACTION_SECTION.style.display = "block";
  // start usage timer (30 min demo)
  startTimer(30 * 60);
}

function startTimer(seconds) {
  clearInterval(timerInterval);
  remainingSec = seconds;
  updateTimerDisplay();
  timerInterval = setInterval(() => {
    remainingSec--;
    if (remainingSec <= 0) {
      clearInterval(timerInterval);
      releaseSeat();
    }
    updateTimerDisplay();
  }, 1000);
}

function updateTimerDisplay() {
  const m = Math.floor(remainingSec / 60).toString().padStart(2, "0");
  const s = (remainingSec % 60).toString().padStart(2, "0");
  TIMER_EL.textContent = `${m}:${s}`;
}

function releaseSeat() {
  if (selectedSeat) {
    selectedSeat.classList.remove("selected");
    selectedSeat.classList.add("occupied"); // show as used
    selectedSeat = null;
  }
  ACTION_SECTION.style.display = "none";
  clearInterval(timerInterval);
  STATUS_EL.textContent = "座位已释放";
}

BREAK_BTN.onclick = () => {
  // 暂离 5 分钟
  startTimer(5 * 60);
  STATUS_EL.textContent = "已报暂离，5 分钟后自动恢复";
};

RELEASE_BTN.onclick = () => {
  releaseSeat();
};

// ---------- AI 监控部分 ----------
async function runCamera() {
  const video = document.getElementById("webcam");
  const stream = await navigator.mediaDevices.getUserMedia({ video: true });
  video.srcObject = stream;
  const model = await cocoSsd.load();
  STATUS_EL.textContent = "模型加载完成";
  detectLoop(video, model);
}

async function detectLoop(video, model) {
  const canvas = document.getElementById("overlay");
  const ctx = canvas.getContext("2d");
  while (true) {
    const predictions = await model.detect(video);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    let personDetected = false;
    let bagDetected = false;
    predictions.forEach(p => {
      if (p.class === "person" && p.score > 0.6) personDetected = true;
      if ((p.class === "backpack" || p.class === "handbag" || p.class === "suitcase" || p.class === "book") && p.score > 0.6) bagDetected = true;
      // draw box for demo
      ctx.strokeStyle = p.class === "person" ? "#00ff00" : "#ff0000";
      ctx.lineWidth = 2;
      ctx.strokeRect(p.bbox[0], p.bbox[1], p.bbox[2], p.bbox[3]);
    });
    // 状态判定逻辑
    if (personDetected) {
      STATUS_EL.textContent = "有人在座（正常）";
    } else if (bagDetected) {
      STATUS_EL.textContent = "检测到物品留座，5 秒后自动释放";
      // 简易模拟：5 秒后调用 releaseSeat()
      setTimeout(() => {
        if (!personDetected) releaseSeat();
      }, 5000);
    } else {
      STATUS_EL.textContent = "座位空闲";
    }
    await new Promise(r => setTimeout(r, 500)); // 0.5s 间隔
  }
}

// 初始化
initSeats();
runCamera();
