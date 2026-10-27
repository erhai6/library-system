// static/register.js

// 密码强度条
document.getElementById('password').addEventListener('input', function () {
    const val = this.value;
    const bar = document.getElementById('strength-bar');
    if (val.length === 0) {
        bar.style.background = '#eee'; bar.style.width = '100%'; return;
    }
    let score = 0;
    if (val.length >= 6)  score++;
    if (val.length >= 10) score++;
    if (/[A-Z]/.test(val)) score++;
    if (/[0-9]/.test(val)) score++;
    if (/[^A-Za-z0-9]/.test(val)) score++;
    const colors = ['#eee', '#f44', '#fa0', '#4a90e2', '#2a0', '#1a0'];
    const widths  = ['100%', '20%', '40%', '60%', '80%', '100%'];
    bar.style.background = colors[score];
    bar.style.width       = widths[score];
});

document.getElementById('register-btn').addEventListener('click', async () => {
    const username  = document.getElementById('username').value.trim();
    const nickname  = document.getElementById('nickname').value.trim();
    const password  = document.getElementById('password').value;
    const password2 = document.getElementById('password2').value;
    const msgEl     = document.getElementById('msg');

    // 前端校验
    if (!username || !nickname || !password || !password2) {
        show('请填写所有字段', 'red'); return;
    }
    if (!/^[A-Za-z0-9_]{4,20}$/.test(username)) {
        show('用户名需4-20位，只能含字母、数字、下划线', 'red'); return;
    }
    if (password.length < 6) {
        show('密码至少6位', 'red'); return;
    }
    if (password !== password2) {
        show('两次密码不一致', 'red'); return;
    }

    // 提交注册
    try {
        const resp = await fetch('/api/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, nickname, password })
        });
        const data = await resp.json();
        if (resp.ok) {
            show('✅ 注册成功！2秒后跳转到登录页...', 'green');
            setTimeout(() => { window.location.href = '/login'; }, 2000);
        } else {
            show('❌ ' + (data.error || '注册失败'), 'red');
        }
    } catch (e) {
        show('❌ 网络错误，请检查服务器是否启动', 'red');
    }
});

function show(msg, color) {
    const el = document.getElementById('msg');
    el.textContent = msg;
    el.style.color = color;
}
