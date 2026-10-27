// static/login.js

document.getElementById('login-btn').addEventListener('click', doLogin);
document.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });

async function doLogin() {
    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value.trim();
    const msgEl    = document.getElementById('msg');

    if (!username || !password) {
        show('请输入用户名和密码', 'red'); 
        return;
    }

    try {
        const resp = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await resp.json();

        if (!resp.ok) {
            show('登录失败：' + (data.error || '用户名或密码错误'), 'red'); 
            return;
        }

        // 保存后端颁发并入库验证的 Token 和用户信息
        localStorage.setItem('token',    data.token);
        localStorage.setItem('role',     data.role);
        localStorage.setItem('username', data.username);
        localStorage.setItem('nickname', data.nickname || data.username);

        if (data.role === 'admin') {
            window.location.href = '/admin';
        } else {
            window.location.href = '/user';
        }
    } catch (e) {
        show('网络连接异常，请确认服务器已启动', 'red');
    }
}

function show(msg, color) {
    const el = document.getElementById('msg');
    el.textContent = msg;
    el.style.color = color;
}
