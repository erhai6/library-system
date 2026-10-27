import sys
import time
import requests
import io

# 确保在 Windows 控制台输出中文不崩溃
if sys.platform == 'win32':
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

USERNAME = 'erhai6'
TOKEN = 'f4b08dd6ca3f333bd489f29b6e14380a7010d52d'
AUTH_HEADERS = {'Authorization': f'Token {TOKEN}'}
BASE_API = f'https://www.pythonanywhere.com/api/v0/user/{USERNAME}/'
DOMAIN = f'{USERNAME}.pythonanywhere.com'

try:
    print("[1/3] 正在检查云端控制台状态...")
    r_cons = requests.get(f'{BASE_API}consoles/', headers=AUTH_HEADERS, timeout=15)
    consoles = r_cons.json() if r_cons.status_code == 200 else []
    bash_console = None
    for c in consoles:
        if c.get('executable') == 'bash':
            bash_console = c
            break

    if not bash_console:
        print("正在创建新的云端 Bash 控制台...")
        r_new = requests.post(f'{BASE_API}consoles/', headers=AUTH_HEADERS, data={'executable': 'bash'}, timeout=15)
        bash_console = r_new.json()

    console_id = bash_console['id']

    print("[2/3] 正在命令云端服务器拉取最新代码 (git pull)...")
    cmd = "cd ~/library-system && git pull && echo SYNC_COMPLETE_FLAG\n"
    requests.post(f"{BASE_API}consoles/{console_id}/send_input/", headers=AUTH_HEADERS, json={'input': cmd}, timeout=15)

    # 等待 3 秒确保 git pull 执行完毕
    time.sleep(3)

    print("[3/3] 正在热重启云端 Web 服务以立即生效...")
    r_reload = requests.post(f"{BASE_API}webapps/{DOMAIN}/reload/", headers=AUTH_HEADERS, timeout=20)

    if r_reload.status_code == 200:
        print("\n========================================================")
        print("  [OK] 恭喜！最新修改已成功全自动同步到云端服务器！")
        print("  云端网址: https://" + DOMAIN)
        print("========================================================\n")
    else:
        print(f"[提示] 重启返回状态: {r_reload.status_code}")
except Exception as e:
    print(f"[错误] 同步过程中出现异常: {e}")
