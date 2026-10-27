// static/user.js - 移动端专属交互

// 鉴权守卫
const token = localStorage.getItem('token');
if (!token) {
    alert('请先登录系统');
    window.location.href = '/login';
}

const currentNickname = localStorage.getItem('nickname') || localStorage.getItem('username') || '同学';
const currentUsername = localStorage.getItem('username') || '';

const welcomeEl = document.getElementById('welcome-name');
if (welcomeEl) welcomeEl.textContent = currentNickname;

// 默认日期为今天
const todayStr = new Date().toISOString().slice(0, 10);
const dateInput = document.getElementById('schedule-date');
if (dateInput) dateInput.value = todayStr;

// 默认开始时间设为当前时间向上取整到半小时
const now = new Date();
now.setMinutes(Math.ceil(now.getMinutes() / 30) * 30, 0, 0);
const pad = n => String(n).padStart(2, '0');
const defaultStart = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
const startTimeInput = document.getElementById('start-time');
if (startTimeInput) startTimeInput.value = defaultStart;

let currentSelectedFloor = '';
let currentScheduleFloor = '';
window.selectedSeatId = null;
window.selectedSeatInfo = null;
window.isUserRestricted = false;

// 检查并展示学生违约与限制状态
async function checkUserViolationStatus() {
    try {
        const resp = await authFetch('/api/user/status');
        if (!resp.ok) return;
        const data = await resp.json();
        
        const banner = document.getElementById('violation-banner');
        const textEl = document.getElementById('violation-text');
        const resBtn = document.getElementById('reserve-btn');
        const deskResBtn = document.getElementById('desk-reserve-btn');

        if (data.is_restricted) {
            window.isUserRestricted = true;
            banner.className = 'violation-banner violation-danger';
            textEl.innerHTML = `🚫 <strong>功能受限：</strong>您已累计违规 ${data.violation_count} 次（预约后 15 分钟内未签到到馆），已被系统限制预约！请联系图书馆管理员处理。`;
            banner.style.display = 'flex';
            if (resBtn) { resBtn.disabled = true; resBtn.textContent = '❌ 已被限制预约'; }
            if (deskResBtn) { deskResBtn.disabled = true; deskResBtn.textContent = '❌ 已被限制预约'; }
        } else if (data.warning) {
            banner.className = 'violation-banner violation-warning';
            textEl.innerHTML = `⚠️ <strong>违规预警：</strong>您已有 <strong>${data.violation_count}</strong> 次预约后 15 分钟内未到馆签到的违规记录！累计达到 <strong>${data.max_limit}</strong> 次将被系统限制预约（当前：${data.violation_count}/${data.max_limit}）。`;
            banner.style.display = 'flex';
        } else {
            banner.style.display = 'none';
        }
    } catch(e) {}
}

checkUserViolationStatus();

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

// 通用带 Token 的 fetch 请求
async function authFetch(url, options = {}) {
    options.headers = options.headers || {};
    options.headers['Authorization'] = 'Bearer ' + token;
    const resp = await fetch(url, options);
    if (resp.status === 401) {
        alert('登录态已失效，请重新登录');
        localStorage.clear();
        window.location.href = '/login';
        throw new Error('Unauthorized');
    }
    return resp;
}

// ==================== 双端导航 Tab 切换 (Mobile & Desktop) ====================
function switchTab(name) {
    document.querySelectorAll('.tab-panel').forEach(p => p.style.display = 'none');
    document.querySelectorAll('.tab-bar-item').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.desktop-tab-btn').forEach(b => b.classList.remove('active'));

    const activePanel = document.getElementById('tab-' + name);
    if (activePanel) activePanel.style.display = 'block';

    // 手机端高亮
    const activeNav = document.getElementById('nav-' + name);
    if (activeNav) activeNav.classList.add('active');

    // 电脑端高亮
    const activeDeskTab = document.getElementById('desk-tab-' + name);
    if (activeDeskTab) activeDeskTab.classList.add('active');

    // 手机端悬浮条控制
    const isMobile = window.innerWidth < 768;
    const floatBar = document.getElementById('floating-action-bar');
    if (floatBar) {
        floatBar.style.display = (name === 'book' && window.selectedSeatId && isMobile) ? 'flex' : 'none';
    }

    if (name === 'mine') {
        loadMyReservations();
    } else if (name === 'schedule') {
        loadSchedule();
    } else if (name === 'book') {
        loadSeats();
    }

    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// 绑定移动端 TabBar
document.getElementById('nav-book').addEventListener('click', () => switchTab('book'));
document.getElementById('nav-schedule').addEventListener('click', () => switchTab('schedule'));
document.getElementById('nav-mine').addEventListener('click', () => switchTab('mine'));

// 绑定电脑端顶部 Tabs
document.getElementById('desk-tab-book').addEventListener('click', () => switchTab('book'));
document.getElementById('desk-tab-schedule').addEventListener('click', () => switchTab('schedule'));
document.getElementById('desk-tab-mine').addEventListener('click', () => switchTab('mine'));

// ==================== 楼层筛选滑轨 ====================
document.querySelectorAll('#book-floor-bar .floor-pill').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('#book-floor-bar .floor-pill').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentSelectedFloor = btn.dataset.floor;
        loadSeats();
    });
});

document.querySelectorAll('#sched-floor-bar .floor-pill').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('#sched-floor-bar .floor-pill').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentScheduleFloor = btn.dataset.floor;
        loadSchedule();
    });
});

// ==================== Tab 1: 选座预约 ====================
document.getElementById('fetch-seats').addEventListener('click', () => loadSeats());

async function loadSeats(targetSelectId = null) {
    const start = document.getElementById('start-time').value;
    const duration = document.getElementById('duration').value;
    const container = document.getElementById('zones-container');
    const msgEl = document.getElementById('msg');
    msgEl.textContent = '';

    if (!start) {
        alert('请选择开始时间');
        return;
    }

    container.innerHTML = '<p style="text-align:center; color:#999; padding:2rem 0;">正在拉取实时余座...</p>';

    try {
        let url = `/api/seats?start=${encodeURIComponent(start)}&duration=${duration}`;
        if (currentSelectedFloor) url += `&floor=${currentSelectedFloor}`;
        
        const resp = await fetch(url);
        const seats = await resp.json();
        if (!resp.ok) {
            container.innerHTML = `<p style="color:red; text-align:center;">${seats.error || '查询失败'}</p>`;
            return;
        }

        // 按 [楼层 + 分区] 分组
        const groupMap = {};
        seats.forEach(s => {
            const key = `${s.floor}F - ${s.zone}`;
            if (!groupMap[key]) groupMap[key] = [];
            groupMap[key].push(s);
        });

        let allCollapsed = false;
        container.innerHTML = '';
        const groupKeys = Object.keys(groupMap).sort();

        groupKeys.forEach((gKey, idx) => {
            const gSeats = groupMap[gKey];
            const freeCount = gSeats.filter(s => !s.occupied).length;
            const containsTarget = targetSelectId && gSeats.some(s => s.id == targetSelectId);

            const block = document.createElement('div');
            block.className = 'zone-block';
            // 优化移动端长页面：如果目标未命中，除了第一个区默认展开外，其他分区默认收起
            if (!containsTarget && idx > 0) {
                block.classList.add('collapsed');
            }

            const header = document.createElement('div');
            header.className = 'zone-header';
            header.innerHTML = `
                <div class="zone-title-wrap">
                    <span class="zone-title">📍 ${gKey}</span>
                </div>
                <div class="zone-header-right">
                    <span class="zone-stats">空座 <strong style="color:var(--success); font-weight:bold;">${freeCount}</strong> / ${gSeats.length}</span>
                    <span class="zone-arrow">▼</span>
                </div>
            `;

            // 点击标题栏展开/收起手风琴
            header.onclick = () => {
                block.classList.toggle('collapsed');
            };

            block.appendChild(header);

            const bodyDiv = document.createElement('div');
            bodyDiv.className = 'zone-body';

            const grid = document.createElement('div');
            grid.className = 'seat-grid';

            gSeats.forEach(s => {
                const div = document.createElement('div');
                div.className = 'seat' + (s.occupied ? ' occupied' : '');
                
                const nameSpan = document.createElement('span');
                nameSpan.textContent = s.name || `座位 #${s.id}`;
                div.appendChild(nameSpan);

                const tagSpan = document.createElement('span');
                tagSpan.className = 'seat-zone-tag';
                tagSpan.textContent = s.occupied ? '占用' : '空闲';
                div.appendChild(tagSpan);

                if (!s.occupied) {
                    div.onclick = (e) => {
                        e.stopPropagation();
                        document.querySelectorAll('.seat.selected').forEach(el => el.classList.remove('selected'));
                        div.classList.add('selected');
                        window.selectedSeatId = s.id;
                        window.selectedSeatInfo = s;
                        updateFloatingBar();
                    };

                    if (targetSelectId && s.id == targetSelectId) {
                        div.classList.add('selected');
                        window.selectedSeatId = s.id;
                        window.selectedSeatInfo = s;
                        block.classList.remove('collapsed'); // 确保命中的分区被展开
                        updateFloatingBar();
                    }
                }
                grid.appendChild(div);
            });

            bodyDiv.appendChild(grid);
            block.appendChild(bodyDiv);
            container.appendChild(block);
        });

        // 绑定一键展开/折叠总控按钮
        const toggleAllBtn = document.getElementById('toggle-all-zones-btn');
        if (toggleAllBtn) {
            toggleAllBtn.onclick = () => {
                allCollapsed = !allCollapsed;
                document.querySelectorAll('.zone-block').forEach(b => {
                    b.classList.toggle('collapsed', allCollapsed);
                });
                toggleAllBtn.textContent = allCollapsed ? '展开全部' : '折叠全部';
            };
        }

        updateFloatingBar();
    } catch (e) {
        container.innerHTML = '<p style="color:red; text-align:center;">网络异常，请刷新重试</p>';
    }
}

function updateFloatingBar() {
    const floatBar = document.getElementById('floating-action-bar');
    const nameEl = document.getElementById('selected-seat-name');
    const deskNameEl = document.getElementById('desk-selected-seat-name');
    const isMobile = window.innerWidth < 768;

    if (window.selectedSeatInfo) {
        const fullDesc = `${window.selectedSeatInfo.name} (${window.selectedSeatInfo.floor}F ${window.selectedSeatInfo.zone})`;
        if (nameEl) nameEl.textContent = fullDesc;
        if (deskNameEl) {
            deskNameEl.textContent = fullDesc;
            deskNameEl.style.color = 'var(--primary)';
        }
        if (floatBar) {
            floatBar.style.display = isMobile ? 'flex' : 'none';
        }
    } else {
        if (nameEl) nameEl.textContent = '--';
        if (deskNameEl) {
            deskNameEl.textContent = '尚未选择（请点击上方任意绿色空闲座位）';
            deskNameEl.style.color = '#888';
        }
        if (floatBar) {
            floatBar.style.display = 'none';
        }
    }
}

// 统一的预约提交逻辑
async function doReserveSubmit() {
    const seatId = window.selectedSeatId;
    const start = document.getElementById('start-time').value;
    const duration = document.getElementById('duration').value;
    const msgEl = document.getElementById('msg');

    if (!seatId) {
        alert('请在上方选定一个绿色空闲座位！');
        return;
    }

    try {
        const resp = await authFetch('/api/reserve', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ seat_id: seatId, start, duration })
        });
        const data = await resp.json();
        if (resp.ok) {
            msgEl.textContent = `🎉 预约成功：${window.selectedSeatInfo ? window.selectedSeatInfo.name : '座位 #' + seatId}`;
            msgEl.style.color = 'var(--success)';
            window.selectedSeatId = null;
            window.selectedSeatInfo = null;
            updateFloatingBar();
            loadSeats();
            setTimeout(() => {
                switchTab('mine');
            }, 1200);
        } else {
            msgEl.textContent = '❌ ' + (data.error || '预约失败');
            msgEl.style.color = 'var(--danger)';
        }
    } catch (e) {
        msgEl.textContent = '❌ 网络通信故障，未能提交';
        msgEl.style.color = 'var(--danger)';
    }
}

// 绑定手机端与电脑端两个确认按钮
const mobileReserveBtn = document.getElementById('reserve-btn');
if (mobileReserveBtn) mobileReserveBtn.addEventListener('click', doReserveSubmit);

const deskReserveBtn = document.getElementById('desk-reserve-btn');
if (deskReserveBtn) deskReserveBtn.addEventListener('click', doReserveSubmit);

// ==================== Tab 2: 时段动态看板 ====================
document.getElementById('load-schedule-btn').addEventListener('click', loadSchedule);

async function loadSchedule() {
    const dateVal = document.getElementById('schedule-date').value;
    if (!dateVal) {
        alert('请选择日期');
        return;
    }
    const wrapper = document.getElementById('schedule-wrapper');
    wrapper.innerHTML = '<p style="text-align:center; color:#999; padding:2rem 0;">正在拉取时刻数据...</p>';

    try {
        let url = `/api/schedule?date=${dateVal}`;
        if (currentScheduleFloor) url += `&floor=${currentScheduleFloor}`;

        const resp = await fetch(url);
        if (!resp.ok) throw new Error('时刻表加载失败');
        const data = await resp.json();

        if (!data.slots || data.slots.length === 0) {
            wrapper.innerHTML = `<div style="text-align:center; padding:2rem; color:#888;">${data.message || '今日开放时段已全部结束，请查看明天的排期。'}</div>`;
            return;
        }

        const table = document.createElement('table');
        table.id = 'schedule-table';

        // 表头
        const thead = document.createElement('thead');
        const headerRow = document.createElement('tr');
        
        const thSeat = document.createElement('th');
        thSeat.style.minWidth = '100px';
        thSeat.textContent = '座位 (分区)';
        headerRow.appendChild(thSeat);

        data.slots.forEach(slot => {
            const th = document.createElement('th');
            th.textContent = slot;
            headerRow.appendChild(th);
        });
        thead.appendChild(headerRow);
        table.appendChild(thead);

        // 表体
        const tbody = document.createElement('tbody');
        const seatKeys = Object.keys(data.seats);

        seatKeys.forEach(sidKey => {
            const item = data.seats[sidKey];
            const sInfo = item.info;
            const flags = item.occupied_list;

            const tr = document.createElement('tr');
            const tdTitle = document.createElement('td');
            tdTitle.style.textAlign = 'left';
            tdTitle.textContent = `${sInfo.name}`;
            tr.appendChild(tdTitle);

            flags.forEach((occupied, idx) => {
                const td = document.createElement('td');
                const slotTime = data.slots[idx];
                td.className = occupied ? 'slot-taken' : 'slot-free';
                td.textContent = occupied ? '占' : '空';

                if (!occupied) {
                    td.onclick = () => {
                        selectSlotFromSchedule(sInfo, dateVal, slotTime, td);
                    };
                }
                tr.appendChild(td);
            });
            tbody.appendChild(tr);
        });

        table.appendChild(tbody);
        wrapper.innerHTML = '';
        wrapper.appendChild(table);
    } catch (e) {
        wrapper.innerHTML = '<p style="color:red; text-align:center;">时段数据加载出错</p>';
    }
}

function selectSlotFromSchedule(sInfo, dateStr, slotTime, clickedTd) {
    document.querySelectorAll('.slot-selected').forEach(el => el.classList.remove('slot-selected'));
    clickedTd.classList.add('slot-selected');

    // 预填预约表单
    const fullStartTime = `${dateStr}T${slotTime}`;
    document.getElementById('start-time').value = fullStartTime;

    currentSelectedFloor = String(sInfo.floor);
    document.querySelectorAll('#book-floor-bar .floor-pill').forEach(b => {
        b.classList.toggle('active', b.dataset.floor == currentSelectedFloor);
    });

    switchTab('book');

    setTimeout(() => {
        loadSeats(sInfo.id);
    }, 150);
}

// ==================== Tab 3: 我的预约 (手机卡片流) ====================
document.getElementById('refresh-mine').addEventListener('click', loadMyReservations);

async function loadMyReservations() {
    const wrap = document.getElementById('my-reservations-wrap');
    wrap.innerHTML = '<p style="text-align:center; color:#999; padding:2rem 0;">正在拉取您的预约...</p>';

    try {
        const resp = await authFetch('/api/my-reservations');
        const data = await resp.json();

        if (!data || data.length === 0) {
            wrap.innerHTML = `
                <div style="text-align:center; padding:3rem 1rem; color:#a0aec0;">
                    <div style="font-size:2.5rem; margin-bottom:0.5rem;">📭</div>
                    <div>您当前没有任何预约记录</div>
                </div>
            `;
            return;
        }

        wrap.innerHTML = '';

        data.forEach(item => {
            const isTimeout  = item.status === 'timeout_released';
            const isReleased = item.status === 'released' || isTimeout;
            const isActive   = item.status === 'active';
            const isReserved = item.status === 'reserved';

            const card = document.createElement('div');
            card.className = 'reservation-card';

            let statusBadgeClass = 'status-released';
            let statusText = '已释放 / 历史';
            if (isTimeout) {
                statusBadgeClass = 'status-released';
                statusText = '⚠️ 15分钟未到违规释放';
            } else if (isActive) {
                statusBadgeClass = 'status-active';
                statusText = '正在使用中';
            } else if (isReserved) {
                statusBadgeClass = 'status-reserved';
                statusText = '已预约 · 待入座';
            }

            let actionsHtml = '';
            if (isActive) {
                actionsHtml = `
                    <button class="btn-mobile btn-release-action" style="background:#dc3545; color:white;" data-id="${item.id}">
                        🚪 临时有事·提前释放
                    </button>
                `;
            } else if (isReserved) {
                actionsHtml = `
                    <button class="btn-mobile btn-checkin-action" style="background:#28a745; color:white;" data-id="${item.id}">
                        📍 入座签到
                    </button>
                    <button class="btn-mobile btn-cancel-action" style="background:#f8f9fa; border:1px solid #cbd5e0; color:#4a5568;" data-id="${item.id}">
                        ❌ 取消预约
                    </button>
                `;
            }

            card.innerHTML = `
                <div class="res-card-header">
                    <span class="res-seat-tag">💺 座位 #${item.seat_id}</span>
                    <span class="badge-status ${statusBadgeClass}">${statusText}</span>
                </div>
                <div class="res-time-row">
                    <span>🕒 开始：</span><strong>${item.start_time}</strong>
                </div>
                <div class="res-time-row">
                    <span>🏁 结束：</span><strong>${item.end_time}</strong>
                </div>
                <div class="res-actions">
                    ${actionsHtml}
                </div>
            `;

            // 绑定按钮事件
            const btnRel = card.querySelector('.btn-release-action');
            if (btnRel) {
                btnRel.onclick = async () => {
                    if (!confirm('确定提前释放该座位吗？释放后其他同学即可预约该时段。')) return;
                    const r = await authFetch('/api/release-self', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ id: item.id })
                    });
                    if (r.ok) {
                        alert('座位已提前释放完毕');
                        loadMyReservations();
                    }
                };
            }

            const btnChk = card.querySelector('.btn-checkin-action');
            if (btnChk) {
                btnChk.onclick = async () => {
                    const r = await authFetch('/api/checkin', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ id: item.id })
                    });
                    if (r.ok) {
                        alert('签到成功，已进入使用状态');
                        loadMyReservations();
                    } else {
                        const err = await r.json();
                        alert(err.error || '签到失败');
                    }
                };
            }

            const btnCan = card.querySelector('.btn-cancel-action');
            if (btnCan) {
                btnCan.onclick = async () => {
                    if (!confirm('确定取消此次预约吗？')) return;
                    const r = await authFetch('/api/cancel', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ id: item.id })
                    });
                    if (r.ok) {
                        alert('预约已成功取消');
                        loadMyReservations();
                    } else {
                        const err = await r.json();
                        alert(err.error || '取消失败');
                    }
                };
            }

            wrap.appendChild(card);
        });

    } catch (e) {
        wrap.innerHTML = '<p style="color:red; text-align:center; padding:1.5rem 0;">拉取预约数据出错</p>';
    }
}

// 首次进入默认加载
loadSeats();
