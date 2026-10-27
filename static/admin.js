// static/admin.js - 图书馆管理与AI监控指挥中心

const token = localStorage.getItem('token');
const role = localStorage.getItem('role');
if (!token || role !== 'admin') {
    alert('需要管理员权限，请重新登录');
    window.location.href = '/login';
}

const adminName = localStorage.getItem('nickname') || localStorage.getItem('username') || '系统管理员';
const adminNameEl = document.getElementById('admin-name');
if (adminNameEl) adminNameEl.textContent = adminName;

// 退出登录
document.getElementById('logout-btn').addEventListener('click', async () => {
    try {
        await fetch('/api/logout', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + token }
        });
    } catch(e) {}
    localStorage.clear();
    window.location.href = '/login';
});

// 通用受保护 fetch
async function authFetch(url, options = {}) {
    options.headers = options.headers || {};
    options.headers['Authorization'] = 'Bearer ' + token;
    const resp = await fetch(url, options);
    if (resp.status === 401 || resp.status === 403) {
        alert('登录态已失效或无管理员权限');
        localStorage.clear();
        window.location.href = '/login';
        throw new Error('Unauthorized');
    }
    return resp;
}

// Tab 切换
function switchTab(name) {
    document.querySelectorAll('.tab-panel').forEach(p => p.style.display = 'none');
    document.querySelectorAll('.desktop-tab-btn').forEach(b => b.classList.remove('active'));

    const targetPanel = document.getElementById('tab-' + name);
    if (targetPanel) targetPanel.style.display = 'block';

    const targetBtn = document.getElementById('tab-btn-' + name);
    if (targetBtn) targetBtn.classList.add('active');

    if (name === 'dashboard') loadStats();
    else if (name === 'reservations') refreshReservations();
    else if (name === 'users') refreshUsers();
}

document.getElementById('tab-btn-dashboard').addEventListener('click', () => switchTab('dashboard'));
document.getElementById('tab-btn-reservations').addEventListener('click', () => switchTab('reservations'));
document.getElementById('tab-btn-users').addEventListener('click', () => switchTab('users'));
document.getElementById('tab-btn-ai').addEventListener('click', () => switchTab('ai'));

// ==================== 1. 监控大屏 ====================
async function loadStats() {
    try {
        const resp = await authFetch('/api/admin/stats');
        const data = await resp.json();

        document.getElementById('stat-today-total').textContent = data.today_total;
        document.getElementById('stat-active').textContent = data.active_count;
        document.getElementById('stat-reserved').textContent = data.reserved_count;
        document.getElementById('stat-utilization').textContent = data.utilization_rate + '%';

        const floorBox = document.getElementById('floor-stat-container');
        floorBox.innerHTML = '';
        data.floor_stats.forEach(f => {
            const card = document.createElement('div');
            card.style.cssText = 'background:#f8f9fa; border:1px solid #e2e8f0; border-radius:6px; padding:0.8rem 1.2rem; min-width:140px; text-align:center;';
            card.innerHTML = `
                <div style="font-weight:bold; color:#4a5568;">🏢 ${f.floor} 楼</div>
                <div style="font-size:1.4rem; font-weight:bold; color:var(--primary); margin:0.3rem 0;">${f.occupied_count} <span style="font-size:0.8rem; color:#718096; font-weight:normal;">人在座</span></div>
            `;
            floorBox.appendChild(card);
        });
    } catch(e) {}
}

// ==================== 2. 预约记录管理 (多维筛选与搜索) ====================
function getStatusBadge(status) {
    const span = document.createElement('span');
    span.className = 'badge-status';
    if (status === 'reserved') {
        span.className += ' status-reserved';
        span.textContent = '已预约 · 待签到';
    } else if (status === 'active') {
        span.className += ' status-active';
        span.textContent = '正在使用中';
    } else if (status === 'released') {
        span.className += ' status-released';
        span.textContent = '正常已释放';
    } else if (status === 'timeout_released') {
        span.style.background = '#ffebee';
        span.style.color = '#c62828';
        span.textContent = '⚠️ 超时未到违规释放';
    } else {
        span.textContent = status;
    }
    return span;
}

async function refreshReservations() {
    const tbody = document.getElementById('tbody');
    const keyword = document.getElementById('res-filter-keyword').value.trim();
    const status = document.getElementById('res-filter-status').value;
    const date = document.getElementById('res-filter-date').value;

    let url = `/api/admin/reservations?keyword=${encodeURIComponent(keyword)}&status=${encodeURIComponent(status)}&date=${encodeURIComponent(date)}`;

    try {
        const resp = await authFetch(url);
        const data = await resp.json();
        tbody.innerHTML = '';
        document.getElementById('res-count-badge').textContent = data.length;

        if (data.length === 0) {
            tbody.innerHTML = '<tr><td colspan="7" style="color:#999; padding:2.5rem;">未检索到符合条件的预约记录</td></tr>';
            return;
        }

        data.forEach(item => {
            const tr = document.createElement('tr');

            const tdId = document.createElement('td');
            tdId.textContent = '#' + item.id;

            const tdSeat = document.createElement('td');
            tdSeat.style.fontWeight = 'bold';
            const seatDesc = item.seat_name ? `${item.seat_name} (${item.floor}F ${item.zone})` : `座位 #${item.seat_id}`;
            tdSeat.textContent = seatDesc;

            // XSS 安全赋值
            const tdUser = document.createElement('td');
            const studentDesc = item.nickname ? `${item.nickname} (@${item.username || item.user_name})` : item.user_name;
            tdUser.textContent = studentDesc;

            const tdStart = document.createElement('td');
            tdStart.textContent = item.start_time;

            const tdEnd = document.createElement('td');
            tdEnd.textContent = item.end_time;

            const tdStatus = document.createElement('td');
            tdStatus.appendChild(getStatusBadge(item.status));

            const tdAction = document.createElement('td');
            if (item.status === 'reserved' || item.status === 'active') {
                const btn = document.createElement('button');
                btn.className = 'btn-action-small release-btn';
                btn.textContent = '强制释放';
                btn.onclick = async () => {
                    if (!confirm(`确认强制提前释放该座位吗？`)) return;
                    const r = await authFetch('/api/admin/release', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ id: item.id })
                    });
                    if (r.ok) refreshReservations();
                };
                tdAction.appendChild(btn);
            } else {
                tdAction.textContent = '—';
            }

            tr.appendChild(tdId);
            tr.appendChild(tdSeat);
            tr.appendChild(tdUser);
            tr.appendChild(tdStart);
            tr.appendChild(tdEnd);
            tr.appendChild(tdStatus);
            tr.appendChild(tdAction);
            tbody.appendChild(tr);
        });
    } catch(e) {
        tbody.innerHTML = '<tr><td colspan="7" style="color:red; padding:1.5rem;">获取预约数据失败</td></tr>';
    }
}

// 绑定筛选事件
document.getElementById('res-filter-btn').addEventListener('click', refreshReservations);
document.getElementById('res-filter-keyword').addEventListener('keydown', e => { if (e.key === 'Enter') refreshReservations(); });
document.getElementById('res-filter-status').addEventListener('change', refreshReservations);
document.getElementById('res-filter-date').addEventListener('change', refreshReservations);
document.getElementById('res-filter-reset').addEventListener('click', () => {
    document.getElementById('res-filter-keyword').value = '';
    document.getElementById('res-filter-status').value = '';
    document.getElementById('res-filter-date').value = '';
    refreshReservations();
});

// ==================== 3. 学生管理 (支持违约与黑名单重置) ====================
async function refreshUsers() {
    const tbody = document.getElementById('users-tbody');
    const keyword = document.getElementById('user-filter-keyword').value.trim();
    const restricted = document.getElementById('user-filter-restricted').value;

    let url = `/api/admin/users?keyword=${encodeURIComponent(keyword)}&restricted=${restricted}`;

    try {
        const resp = await authFetch(url);
        const data = await resp.json();
        tbody.innerHTML = '';
        document.getElementById('user-count-badge').textContent = data.length;

        if (data.length === 0) {
            tbody.innerHTML = '<tr><td colspan="8" style="color:#999; padding:2rem;">未搜索到匹配的学生</td></tr>';
            return;
        }

        data.forEach(u => {
            const tr = document.createElement('tr');

            const tdId = document.createElement('td');
            tdId.textContent = u.id;

            const tdUser = document.createElement('td');
            tdUser.textContent = u.username;

            const tdNick = document.createElement('td');
            tdNick.textContent = u.nickname;

            const tdRole = document.createElement('td');
            const badge = document.createElement('span');
            badge.className = u.role === 'admin' ? 'badge-admin' : 'badge-user';
            badge.textContent = u.role === 'admin' ? '管理员' : '学生';
            tdRole.appendChild(badge);

            // 违约次数
            const tdViolations = document.createElement('td');
            const vCount = u.violation_count || 0;
            if (vCount >= 3) {
                tdViolations.innerHTML = `<strong style="color:#e53e3e;">${vCount} 次 (严重)</strong>`;
            } else if (vCount > 0) {
                tdViolations.innerHTML = `<span style="color:#d69e2e; font-weight:bold;">${vCount} 次</span>`;
            } else {
                tdViolations.innerHTML = `<span style="color:#38a169;">0 次 (良好)</span>`;
            }

            // 状态
            const tdStatus = document.createElement('td');
            const isRestricted = u.is_restricted || vCount >= 3;
            if (isRestricted) {
                tdStatus.innerHTML = `<span class="badge-restricted">🚫 已受限禁止预约</span>`;
            } else {
                tdStatus.innerHTML = `<span class="badge-normal">✅ 正常可预约</span>`;
            }

            const tdTime = document.createElement('td');
            tdTime.textContent = u.created_at || '—';

            // 操作：若有违规，可一键清零并解除限制
            const tdAction = document.createElement('td');
            if (vCount > 0 || isRestricted) {
                const btnReset = document.createElement('button');
                btnReset.className = 'btn-action-small btn-reset-violation';
                btnReset.textContent = '🔓 清零违规并解除限制';
                btnReset.onclick = async () => {
                    if (!confirm(`确认清零学生【${u.nickname} (@${u.username})】的违约记录并恢复其预约资格吗？`)) return;
                    const r = await authFetch('/api/admin/reset-violation', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ user_id: u.id })
                    });
                    const resJson = await r.json();
                    if (r.ok) {
                        alert(resJson.message || '已成功恢复该学生的预约资格！');
                        refreshUsers();
                    } else {
                        alert(resJson.error || '处理失败');
                    }
                };
                tdAction.appendChild(btnReset);
            } else {
                tdAction.textContent = '—';
            }

            tr.appendChild(tdId);
            tr.appendChild(tdUser);
            tr.appendChild(tdNick);
            tr.appendChild(tdRole);
            tr.appendChild(tdViolations);
            tr.appendChild(tdStatus);
            tr.appendChild(tdTime);
            tr.appendChild(tdAction);
            tbody.appendChild(tr);
        });
    } catch(e) {
        tbody.innerHTML = '<tr><td colspan="8" style="color:red; padding:1.5rem;">加载学生列表失败</td></tr>';
    }
}

document.getElementById('user-filter-btn').addEventListener('click', refreshUsers);
document.getElementById('user-filter-keyword').addEventListener('keydown', e => { if (e.key === 'Enter') refreshUsers(); });
document.getElementById('user-filter-restricted').addEventListener('change', refreshUsers);

// ==================== 4. 管理员专属 AI 视觉在馆巡查 ====================
let aiModel = null;
let webcamStream = null;
let detectionInterval = null;

function appendAiLog(text) {
    const logBox = document.getElementById('ai-log');
    if (!logBox) return;
    const timeStr = new Date().toTimeString().split(' ')[0];
    const line = document.createElement('div');
    line.textContent = `[${timeStr}] ${text}`;
    logBox.appendChild(line);
    logBox.scrollTop = logBox.scrollHeight;
}

document.getElementById('start-camera-btn').addEventListener('click', async () => {
    const statusEl = document.getElementById('ai-status');
    const video = document.getElementById('webcam');
    const overlay = document.getElementById('overlay');
    const ctx = overlay.getContext('2d');

    statusEl.textContent = '正在加载 AI 视觉模型...';
    appendAiLog('正在从 CDN 下载并加载 TensorFlow COCO-SSD 模型...');

    try {
        if (!aiModel) {
            aiModel = await cocoSsd.load();
            appendAiLog('✅ COCO-SSD 视觉目标检测模型加载完毕！');
        }

        statusEl.textContent = '正在申请摄像头权限...';
        webcamStream = await navigator.mediaDevices.getUserMedia({
            video: { width: 360, height: 270 },
            audio: false
        });
        video.srcObject = webcamStream;
        appendAiLog('✅ 摄像头视频流已成功捕获并启动实时巡视。');
        statusEl.textContent = '实时巡查中 (绿色=有人)';
        statusEl.style.color = '#28a745';

        // 启动检测循环
        clearInterval(detectionInterval);
        detectionInterval = setInterval(async () => {
            if (!video.videoWidth) return;
            const predictions = await aiModel.detect(video);
            ctx.clearRect(0, 0, overlay.width, overlay.height);

            const persons = predictions.filter(p => p.class === 'person');
            if (persons.length > 0) {
                appendAiLog(`🔍 镜头内识别到 ${persons.length} 位在座读者，置信度 ${(persons[0].score * 100).toFixed(1)}%`);
            }

            predictions.forEach(p => {
                if (p.class === 'person') {
                    ctx.strokeStyle = '#28a745';
                    ctx.lineWidth = 3;
                    ctx.strokeRect(...p.bbox);
                    ctx.fillStyle = '#28a745';
                    ctx.font = '14px sans-serif';
                    ctx.fillText(`读者 (${(p.score * 100).toFixed(0)}%)`, p.bbox[0], p.bbox[1] > 15 ? p.bbox[1] - 5 : 15);
                }
            });
        }, 1500);

    } catch (err) {
        statusEl.textContent = '开启失败: ' + err.message;
        statusEl.style.color = '#dc3545';
        appendAiLog('❌ 摄像头启动异常：请确认已授权摄像头或使用 HTTPS/本地环境');
    }
});

document.getElementById('stop-camera-btn').addEventListener('click', () => {
    if (webcamStream) {
        webcamStream.getTracks().forEach(t => t.stop());
        webcamStream = null;
    }
    clearInterval(detectionInterval);
    const overlay = document.getElementById('overlay');
    if (overlay) overlay.getContext('2d').clearRect(0, 0, overlay.width, overlay.height);
    const statusEl = document.getElementById('ai-status');
    if (statusEl) {
        statusEl.textContent = '已停止巡视';
        statusEl.style.color = '#6c757d';
    }
    appendAiLog('⏹️ 管理员已关闭摄像头巡检。');
});

// 初始加载大屏
loadStats();
