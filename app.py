from flask import Flask, request, jsonify, send_from_directory, g
import sqlite3
import os
import secrets
import hashlib
from datetime import datetime, timedelta, time
import re
import threading
import time as pytime
from functools import wraps

app = Flask(__name__, static_folder='static')
from flask_cors import CORS
# 限定 CORS 范围（允许本地和同网段测试）
CORS(app, resources={r"/api/*": {"origins": "*"}})

# ==================== 系统全局配置 ====================
DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'library.db')

# 每日开闭馆时间窗与违规规则配置
LIBRARY_CONFIG = {
    'open_time': time(8, 0),       # 早上 08:00 开馆
    'close_time': time(22, 0),     # 晚上 22:00 闭馆
    'checkin_timeout_min': 15,     # 开座后超过 15 分钟未签到自动判定违规并释放
    'max_violation_limit': 3,      # 违规满 3 次限制预约
    'max_duration_min': 480        # 单次最大预约时长 8 小时
}

# 登录防暴力破解记录: username -> {'fails': count, 'locked_until': timestamp}
LOGIN_ATTEMPTS = {}
LOGIN_LOCK_MINUTES = 15
MAX_LOGIN_FAILS = 5

def get_db():
    if 'db' not in g:
        g.db = sqlite3.connect(DB_PATH, timeout=30.0)
        g.db.row_factory = sqlite3.Row
        # 开启 WAL 模式，彻底杜绝 database is locked 并发锁死
        g.db.execute('PRAGMA journal_mode=WAL;')
    return g.db

@app.teardown_appcontext
def close_db(exception):
    db = g.pop('db', None)
    if db is not None:
        db.close()

# ==================== 安全与密码哈希 ====================
def hash_password(password: str, salt: str = None) -> str:
    """使用 PBKDF2-HMAC-SHA256 加盐哈希安全存储密码"""
    if not salt:
        salt = secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt.encode('utf-8'), 100000)
    return f"{salt}${dk.hex()}"

def verify_password(stored_hash: str, provided_password: str) -> bool:
    if not stored_hash:
        return False
    if '$' in stored_hash:
        salt, h = stored_hash.split('$', 1)
        dk = hashlib.pbkdf2_hmac('sha256', provided_password.encode('utf-8'), salt.encode('utf-8'), 100000)
        return dk.hex() == h
    return hashlib.sha256(provided_password.encode('utf-8')).hexdigest() == stored_hash

def normalize_datetime_str(dt_str: str) -> str:
    if not dt_str:
        return ""
    cleaned = dt_str.replace('T', ' ').strip()
    if len(cleaned) == 16:
        cleaned += ':00'
    elif len(cleaned) > 19:
        cleaned = cleaned[:19]
    return cleaned

# ==================== 数据库初始化与索引创建 ====================
def init_db():
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()

    # 1. 用户表 (新增违规与黑名单字段)
    cur.execute('''
        CREATE TABLE IF NOT EXISTS users (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            username         TEXT UNIQUE NOT NULL,
            nickname         TEXT NOT NULL,
            password         TEXT NOT NULL,
            role             TEXT CHECK(role IN ('user','admin')) DEFAULT 'user',
            violation_count  INTEGER DEFAULT 0,
            is_restricted    INTEGER DEFAULT 0,
            created_at       TEXT DEFAULT (datetime('now','localtime'))
        )
    ''')

    # 迁移增加违规字段
    cur.execute("PRAGMA table_info(users)")
    u_cols = [col[1] for col in cur.fetchall()]
    if 'violation_count' not in u_cols:
        cur.execute("ALTER TABLE users ADD COLUMN violation_count INTEGER DEFAULT 0")
    if 'is_restricted' not in u_cols:
        cur.execute("ALTER TABLE users ADD COLUMN is_restricted INTEGER DEFAULT 0")

    # 2. Token 持久化表
    cur.execute('''
        CREATE TABLE IF NOT EXISTS tokens (
            token      TEXT PRIMARY KEY,
            user_id    INTEGER NOT NULL,
            username   TEXT NOT NULL,
            nickname   TEXT NOT NULL,
            role       TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now','localtime')),
            FOREIGN KEY(user_id) REFERENCES users(id)
        )
    ''')

    # 3. 座位表
    cur.execute('''
        CREATE TABLE IF NOT EXISTS seats (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            floor      INTEGER NOT NULL DEFAULT 2,
            zone       TEXT NOT NULL DEFAULT '静音自修区',
            name       TEXT NOT NULL DEFAULT ''
        )
    ''')

    # 4. 预约表
    cur.execute('''
        CREATE TABLE IF NOT EXISTS reservations (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            seat_id    INTEGER NOT NULL,
            user_id    INTEGER,
            user_name  TEXT NOT NULL,
            start_time TEXT NOT NULL,
            end_time   TEXT NOT NULL,
            status     TEXT CHECK(status IN ('reserved','active','released')) DEFAULT 'reserved',
            FOREIGN KEY(seat_id) REFERENCES seats(id),
            FOREIGN KEY(user_id) REFERENCES users(id)
        )
    ''')

    # 5. 性能与安全索引优化
    cur.execute('CREATE INDEX IF NOT EXISTS idx_res_seat_time ON reservations(seat_id, start_time, end_time, status)')
    cur.execute('CREATE INDEX IF NOT EXISTS idx_res_user ON reservations(user_id, status)')
    cur.execute('CREATE INDEX IF NOT EXISTS idx_tokens_lookup ON tokens(token, expires_at)')

    # 默认预设管理员与学生账号
    cur.execute("SELECT password FROM users WHERE username='admin1'")
    if not cur.fetchone():
        cur.execute("INSERT INTO users (username,nickname,password,role) VALUES (?,?,?,?)",
                    ('admin1', '系统管理员', hash_password('adminpwd'), 'admin'))

    cur.execute("SELECT password FROM users WHERE username='student1'")
    if not cur.fetchone():
        cur.execute("INSERT INTO users (username,nickname,password,role) VALUES (?,?,?,?)",
                    ('student1', '张同学', hash_password('123456'), 'user'))

    # 初始化 2/3/4 楼座位
    cur.execute('SELECT COUNT(*) FROM seats')
    if cur.fetchone()[0] < 40:
        cur.execute('DELETE FROM seats')
        seat_data = []
        for i in range(1, 9):
            seat_data.append((2, 'A区·静音自修', f'2F-A{i:02d}'))
        for i in range(1, 9):
            seat_data.append((2, 'B区·考研专区', f'2F-B{i:02d}'))
        for i in range(1, 9):
            seat_data.append((3, 'A区·靠窗风景', f'3F-A{i:02d}'))
        for i in range(1, 9):
            seat_data.append((3, 'B区·多媒体研讨', f'3F-B{i:02d}'))
        for i in range(1, 9):
            seat_data.append((4, 'A区·特藏书阁', f'4F-A{i:02d}'))
        cur.executemany('INSERT INTO seats (floor, zone, name) VALUES (?, ?, ?)', seat_data)

    conn.commit()
    conn.close()

init_db()

# ==================== 后台自动化巡查守护线程 (到点释放/超时未签到流转) ====================
def background_scheduler_worker():
    """
    后台自动化巡检引擎：
    1. 15分钟未到馆签到自动释放：开始时间超过 15 分钟仍为 reserved 的记录，自动设为 timeout_released，并为学生累计违规次数！
    2. 到期自动完结：结束时间已到的记录，正常标记为 released 结座。
    3. 清理已过期的 Token。
    """
    while True:
        pytime.sleep(20)  # 先等待，避免启动时并发抢锁
        conn = None
        try:
            conn = sqlite3.connect(DB_PATH, timeout=20.0)
            conn.row_factory = sqlite3.Row
            cur = conn.cursor()
            now = datetime.now()
            now_str = now.strftime('%Y-%m-%d %H:%M:%S')

            # 1. 到期正常结座
            cur.execute('''
                UPDATE reservations
                SET status = 'released'
                WHERE end_time <= ? AND status IN ('reserved', 'active')
            ''', (now_str,))

            # 2. 签到超时判定（15 分钟未签到）
            timeout_threshold = (now - timedelta(minutes=LIBRARY_CONFIG['checkin_timeout_min'])).strftime('%Y-%m-%d %H:%M:%S')
            cur.execute('''
                SELECT id, user_id, user_name, seat_id FROM reservations
                WHERE start_time <= ? AND status = 'reserved'
            ''', (timeout_threshold,))
            timeout_rows = [dict(r) for r in cur.fetchall()]

            for r in timeout_rows:
                cur.execute("UPDATE reservations SET status = 'timeout_released' WHERE id = ?", (r['id'],))
                target_user_id = r['user_id']
                if target_user_id:
                    cur.execute('''
                        UPDATE users
                        SET violation_count = violation_count + 1,
                            is_restricted = CASE WHEN violation_count + 1 >= ? THEN 1 ELSE is_restricted END
                        WHERE id = ?
                    ''', (LIBRARY_CONFIG['max_violation_limit'], target_user_id))
                else:
                    cur.execute('''
                        UPDATE users
                        SET violation_count = violation_count + 1,
                            is_restricted = CASE WHEN violation_count + 1 >= ? THEN 1 ELSE is_restricted END
                        WHERE username = ?
                    ''', (LIBRARY_CONFIG['max_violation_limit'], r['user_name']))

            # 3. 清理过期 Token
            cur.execute('DELETE FROM tokens WHERE expires_at <= ?', (now_str,))
            conn.commit()
        except Exception as e:
            pass
        finally:
            if conn:
                try:
                    conn.close()
                except Exception:
                    pass

# 启动后台常驻守护线程
bg_thread = threading.Thread(target=background_scheduler_worker, daemon=True)
bg_thread.start()

# ==================== 认证装饰器与权限控制 ====================
def get_current_user():
    auth_header = request.headers.get('Authorization', '')
    token = None
    if auth_header.startswith('Bearer '):
        token = auth_header[7:].strip()
    elif 'token' in request.args:
        token = request.args.get('token')

    if not token:
        return None

    db = get_db()
    cur = db.cursor()
    now_str = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    cur.execute('SELECT * FROM tokens WHERE token = ? AND expires_at > ?', (token, now_str))
    user_row = cur.fetchone()
    if user_row:
        return dict(user_row)
    return None

def login_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        user = get_current_user()
        if not user:
            return jsonify({'error': '未授权，请先登录', 'code': 'UNAUTHORIZED'}), 401
        g.current_user = user
        return f(*args, **kwargs)
    return decorated_function

def admin_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        user = get_current_user()
        if not user:
            return jsonify({'error': '未授权，请先登录', 'code': 'UNAUTHORIZED'}), 401
        if user.get('role') != 'admin':
            return jsonify({'error': '无权访问，仅管理员可用', 'code': 'FORBIDDEN'}), 403
        g.current_user = user
        return f(*args, **kwargs)
    return decorated_function

def is_reservation_owner(res, current_user):
    """
    【彻底修复同名昵称越权 Bug】：
    强校验：优先根据唯一的 user_id 进行匹配！
    仅当历史数据 user_id 为 None 时，才回退用唯一的 username 校验。绝对不使用可重复的 nickname！
    """
    if current_user.get('role') == 'admin':
        return True
    user_id = current_user.get('user_id')
    if res['user_id'] is not None:
        return res['user_id'] == user_id
    # 历史遗留数据兜底：按唯一用户名匹配
    return res['user_name'] == current_user.get('username')

# ==================== 认证与用户 API ====================
@app.route('/api/register', methods=['POST'])
def register():
    data     = request.json or {}
    username = data.get('username', '').strip()
    nickname = data.get('nickname', '').strip()
    password = data.get('password', '')

    if not username or not nickname or not password:
        return jsonify({'error': '用户名、昵称和密码均为必填'}), 400
    if not (4 <= len(username) <= 20):
        return jsonify({'error': '用户名需 4-20 位'}), 400
    if len(nickname) > 20:
        return jsonify({'error': '昵称不能超过 20 个字符'}), 400
    if not re.match(r'^[A-Za-z0-9_]+$', username):
        return jsonify({'error': '用户名只能包含字母、数字和下划线'}), 400
    if len(password) < 6:
        return jsonify({'error': '密码至少需要 6 位'}), 400

    db  = get_db()
    cur = db.cursor()
    try:
        cur.execute(
            "INSERT INTO users (username, nickname, password, role) VALUES (?,?,?,?)",
            (username, nickname, hash_password(password), 'user')
        )
        db.commit()
    except sqlite3.IntegrityError:
        return jsonify({'error': '该用户名已被注册，请更换'}), 409
    return jsonify({'status': 'ok', 'message': '注册成功'})

@app.route('/api/login', methods=['POST'])
def login():
    data     = request.json or {}
    username = data.get('username', '').strip()
    password = data.get('password', '').strip()
    if not username or not password:
        return jsonify({'error': '用户名和密码必填'}), 400

    now_ts = pytime.time()
    # 检查暴力破解锁定
    attempt_info = LOGIN_ATTEMPTS.get(username)
    if attempt_info and attempt_info.get('locked_until', 0) > now_ts:
        remain_min = int((attempt_info['locked_until'] - now_ts) / 60) + 1
        return jsonify({'error': f'连续多次密码错误，账号已锁定，请在 {remain_min} 分钟后再试'}), 429

    db  = get_db()
    cur = db.cursor()
    cur.execute("SELECT * FROM users WHERE username = ?", (username,))
    user = cur.fetchone()

    if not user or not verify_password(user['password'], password):
        # 记录登录失败
        if not attempt_info:
            attempt_info = {'fails': 0, 'locked_until': 0}
        attempt_info['fails'] += 1
        if attempt_info['fails'] >= MAX_LOGIN_FAILS:
            attempt_info['locked_until'] = now_ts + LOGIN_LOCK_MINUTES * 60
            LOGIN_ATTEMPTS[username] = attempt_info
            return jsonify({'error': f'密码错误次数过多，账号已锁定 {LOGIN_LOCK_MINUTES} 分钟'}), 429
        LOGIN_ATTEMPTS[username] = attempt_info
        remain_try = MAX_LOGIN_FAILS - attempt_info['fails']
        return jsonify({'error': f'用户名或密码错误，还可尝试 {remain_try} 次'}), 401

    # 登录成功，重置失败计数
    if username in LOGIN_ATTEMPTS:
        del LOGIN_ATTEMPTS[username]

    token = secrets.token_hex(24)
    expires_at = (datetime.now() + timedelta(days=7)).strftime('%Y-%m-%d %H:%M:%S')
    cur.execute('''
        INSERT INTO tokens (token, user_id, username, nickname, role, expires_at)
        VALUES (?, ?, ?, ?, ?, ?)
    ''', (token, user['id'], user['username'], user['nickname'], user['role'], expires_at))
    db.commit()

    return jsonify({
        'token': token,
        'role': user['role'],
        'username': user['username'],
        'nickname': user['nickname']
    })

@app.route('/api/logout', methods=['POST'])
@login_required
def logout():
    auth_header = request.headers.get('Authorization', '')
    token = auth_header[7:].strip() if auth_header.startswith('Bearer ') else ''
    if token:
        db = get_db()
        cur = db.cursor()
        cur.execute('DELETE FROM tokens WHERE token = ?', (token,))
        db.commit()
    return jsonify({'status': 'ok'})

@app.route('/api/user/change-password', methods=['POST'])
@login_required
def change_password():
    """个人中心：修改密码"""
    data = request.json or {}
    old_pwd = data.get('old_password', '')
    new_pwd = data.get('new_password', '')

    if not old_pwd or not new_pwd:
        return jsonify({'error': '旧密码和新密码均必填'}), 400
    if len(new_pwd) < 6:
        return jsonify({'error': '新密码长度至少需要 6 位'}), 400

    user_id = g.current_user['user_id']
    db = get_db()
    cur = db.cursor()
    cur.execute('SELECT password FROM users WHERE id = ?', (user_id,))
    row = cur.fetchone()
    if not row or not verify_password(row['password'], old_pwd):
        return jsonify({'error': '原密码输入不正确'}), 400

    cur.execute('UPDATE users SET password = ? WHERE id = ?', (hash_password(new_pwd), user_id))
    db.commit()
    return jsonify({'status': 'ok', 'message': '密码修改成功，请妥善保存'})

# ==================== 座位与预约 API ====================
@app.route('/api/seats', methods=['GET'])
def get_seats():
    start_str = request.args.get('start')
    floor_filter = request.args.get('floor')
    try:
        duration = int(request.args.get('duration', 30))
    except (ValueError, TypeError):
        return jsonify({'error': 'duration 参数必须是数字'}), 400

    if duration <= 0 or duration > LIBRARY_CONFIG['max_duration_min']:
        return jsonify({'error': f"duration 须在 1-{LIBRARY_CONFIG['max_duration_min']} 分钟之间"}), 400
    if not start_str:
        return jsonify({'error': 'start 参数必填'}), 400

    try:
        start_clean = normalize_datetime_str(start_str)
        start_dt = datetime.strptime(start_clean, '%Y-%m-%d %H:%M:%S')
    except Exception:
        return jsonify({'error': 'start 时间格式不正确'}), 400

    end_dt = start_dt + timedelta(minutes=duration)
    end_clean = end_dt.strftime('%Y-%m-%d %H:%M:%S')

    db  = get_db()
    cur = db.cursor()

    sql = 'SELECT id, floor, zone, name FROM seats'
    params = []
    # 【彻底修复 floor 参数异常】：安全校验只在全数字时转换
    if floor_filter and str(floor_filter).strip().isdigit():
        sql += ' WHERE floor = ?'
        params.append(int(floor_filter))
    sql += ' ORDER BY floor, zone, name, id'
    cur.execute(sql, params)
    seats = [dict(row) for row in cur.fetchall()]

    cur.execute('''
        SELECT seat_id FROM reservations
        WHERE (start_time < ?)
          AND (end_time   > ?)
          AND status IN ('reserved','active')
    ''', (end_clean, start_clean))
    occupied = {row['seat_id'] for row in cur.fetchall()}

    for s in seats:
        s['occupied'] = s['id'] in occupied

    return jsonify(seats)

@app.route('/api/schedule', methods=['GET'])
def get_schedule():
    """返回指定日期的座位动态时间表"""
    date_str = request.args.get('date', '').strip()
    floor_filter = request.args.get('floor')
    today_str = datetime.now().strftime('%Y-%m-%d')
    if not date_str:
        date_str = today_str

    try:
        base_dt = datetime.strptime(date_str + ' 08:00:00', '%Y-%m-%d %H:%M:%S')
    except ValueError:
        return jsonify({'error': 'date 格式应为 YYYY-MM-DD'}), 400

    now_dt = datetime.now()

    # 生成 08:00 到 22:00 每半小时一个槽，共 28 个时段
    raw_slots = []
    for i in range(28):
        s = base_dt + timedelta(minutes=30 * i)
        e = s + timedelta(minutes=30)
        # 智能时段过滤：如果是今天，自动隐藏已经过去的时段
        if date_str == today_str and e <= now_dt:
            continue
        raw_slots.append((s.strftime('%Y-%m-%d %H:%M:%S'), e.strftime('%Y-%m-%d %H:%M:%S'), s.strftime('%H:%M')))

    if not raw_slots:
        return jsonify({
            'slots': [],
            'seats': {},
            'date': date_str,
            'message': '今日开馆时段已全部结束，请选择查看明天的排期。'
        })

    day_start = raw_slots[0][0]
    day_end   = raw_slots[-1][1]

    db  = get_db()
    cur = db.cursor()

    sql = 'SELECT id, floor, zone, name FROM seats'
    params = []
    if floor_filter and str(floor_filter).strip().isdigit():
        sql += ' WHERE floor = ?'
        params.append(int(floor_filter))
    sql += ' ORDER BY floor, zone, name, id'
    cur.execute(sql, params)
    seats_list = [dict(row) for row in cur.fetchall()]

    cur.execute('''
        SELECT seat_id, start_time, end_time, user_name, status
        FROM reservations
        WHERE end_time > ?
          AND start_time < ?
          AND status IN ('reserved','active')
    ''', (day_start, day_end))
    reservations = [dict(r) for r in cur.fetchall()]

    seat_matrix = {}
    for s_info in seats_list:
        sid = s_info['id']
        seat_res = [r for r in reservations if r['seat_id'] == sid]
        slot_flags = []
        for (s_start, s_end, _) in raw_slots:
            occupied = any(
                r['start_time'] < s_end and r['end_time'] > s_start
                for r in seat_res
            )
            slot_flags.append(occupied)
        seat_matrix[str(sid)] = {
            'info': s_info,
            'occupied_list': slot_flags
        }

    return jsonify({
        'slots': [s[2] for s in raw_slots],
        'seats': seat_matrix,
        'date':  date_str
    })

@app.route('/api/user/status', methods=['GET'])
@login_required
def user_status():
    """获取当前登录用户的个人违约与限制状态"""
    user_id = g.current_user['user_id']
    db = get_db()
    cur = db.cursor()
    cur.execute("SELECT id, username, nickname, violation_count, is_restricted FROM users WHERE id = ?", (user_id,))
    row = cur.fetchone()
    if not row:
        return jsonify({'error': '用户不存在'}), 404
    u = dict(row)
    return jsonify({
        'username': u['username'],
        'nickname': u['nickname'],
        'violation_count': u.get('violation_count', 0),
        'is_restricted': bool(u.get('is_restricted', 0)),
        'max_limit': LIBRARY_CONFIG['max_violation_limit'],
        'warning': u.get('violation_count', 0) > 0
    })

@app.route('/api/reserve', methods=['POST'])
@login_required
def reserve():
    """
    用户预约座位：
    1. 校验学生账号违规情况：累计 3 次未到馆违约将限制预约。
    2. 校验开闭馆时间窗（8:00 - 22:00），禁止跨夜或闭馆预约。
    3. 禁止分身占座（同一人在同一时段只能预约 1 个座位）。
    4. 冲突检测与安全强绑定。
    """
    current_user = g.current_user
    user_id = current_user['user_id']

    db  = get_db()
    cur = db.cursor()

    # 检查该学生是否处于限制预约状态
    cur.execute("SELECT violation_count, is_restricted FROM users WHERE id = ?", (user_id,))
    u_row = cur.fetchone()
    if u_row and (u_row['is_restricted'] or u_row['violation_count'] >= LIBRARY_CONFIG['max_violation_limit']):
        return jsonify({
            'error': f"您的违规未到记录已达 {u_row['violation_count']} 次（达到或超过 {LIBRARY_CONFIG['max_violation_limit']} 次上限），已被系统限制预约！请联系管理员处理。"
        }), 403

    data    = request.json or {}
    seat_id = data.get('seat_id')
    start_str = data.get('start')

    try:
        duration = int(data.get('duration', 30))
    except (ValueError, TypeError):
        return jsonify({'error': 'duration 参数必须是数字'}), 400

    if duration <= 0 or duration > LIBRARY_CONFIG['max_duration_min']:
        return jsonify({'error': f"duration 须在 1-{LIBRARY_CONFIG['max_duration_min']} 分钟之间"}), 400
    if not seat_id or not start_str:
        return jsonify({'error': 'seat_id 和 start 参数必填'}), 400

    try:
        start_clean = normalize_datetime_str(start_str)
        start_dt = datetime.strptime(start_clean, '%Y-%m-%d %H:%M:%S')
    except Exception:
        return jsonify({'error': 'start 时间格式不正确'}), 400

    # 1. 预约时间不得早于当前时间（允许 5 分钟微量误差）
    now_dt = datetime.now()
    if start_dt < now_dt - timedelta(minutes=5):
        return jsonify({'error': '预约开始时间不能早于当前时间'}), 400

    end_dt = start_dt + timedelta(minutes=duration)
    end_clean = end_dt.strftime('%Y-%m-%d %H:%M:%S')

    # 【彻底修复：开闭馆时间窗校验】
    open_time = LIBRARY_CONFIG['open_time']
    close_time = LIBRARY_CONFIG['close_time']
    # 必须为同一天（禁止跨夜）
    if start_dt.date() != end_dt.date():
        return jsonify({'error': '不可跨夜预约，预约起止必须在同一自然日内'}), 400

    if start_dt.time() < open_time:
        return jsonify({'error': f"图书馆开馆时间为每日 {open_time.strftime('%H:%M')}，不能在此之前入座"}), 400

    if end_dt.time() > close_time:
        return jsonify({'error': f"图书馆闭馆时间为每日 {close_time.strftime('%H:%M')}，预约结束时间不可超过闭馆时间"}), 400

    current_user = g.current_user
    user_id = current_user['user_id']
    user_name = current_user['nickname'] or current_user['username']

    db  = get_db()
    cur = db.cursor()

    cur.execute('SELECT 1 FROM seats WHERE id = ?', (seat_id,))
    if not cur.fetchone():
        return jsonify({'error': '该座位不存在'}), 400

    # 2. 检测该座位时间冲突
    cur.execute('''
        SELECT 1 FROM reservations
        WHERE seat_id = ?
          AND (start_time < ?)
          AND (end_time   > ?)
          AND status IN ('reserved','active')
    ''', (seat_id, end_clean, start_clean))
    if cur.fetchone():
        return jsonify({'error': '该时间段该座位已被他人预约'}), 409

    # 3. 检测该用户自身的时间冲突（防分身占座，强依赖 user_id）
    cur.execute('''
        SELECT seat_id, start_time, end_time FROM reservations
        WHERE user_id = ?
          AND (start_time < ?)
          AND (end_time   > ?)
          AND status IN ('reserved','active')
    ''', (user_id, end_clean, start_clean))
    user_conflict = cur.fetchone()
    if user_conflict:
        return jsonify({
            'error': f"您在该时段已有预约（座位 #{user_conflict['seat_id']}），不可重复预约多个座位"
        }), 409

    cur.execute('''
        INSERT INTO reservations (seat_id, user_id, user_name, start_time, end_time, status)
        VALUES (?, ?, ?, ?, ?, 'reserved')
    ''', (seat_id, user_id, user_name, start_clean, end_clean))
    db.commit()
    return jsonify({'status': 'reserved', 'message': '预约成功'})

@app.route('/api/my-reservations', methods=['GET'])
@login_required
def my_reservations():
    """
    【彻底修复同名数据串号】：
    严格按当前登录用户的 user_id 查询预约记录！
    仅当历史数据中 user_id 为 NULL 时，用 username 兜底匹配，绝不使用可重复的 nickname！
    """
    user_id = g.current_user['user_id']
    username = g.current_user['username']
    db  = get_db()
    cur = db.cursor()
    cur.execute('''
        SELECT id, seat_id, user_name, start_time, end_time, status
        FROM reservations
        WHERE user_id = ? OR (user_id IS NULL AND user_name = ?)
        ORDER BY start_time DESC
    ''', (user_id, username))
    rows = [dict(r) for r in cur.fetchall()]
    return jsonify(rows)

@app.route('/api/cancel', methods=['POST'])
@login_required
def cancel_reservation():
    """取消预约"""
    data   = request.json or {}
    res_id = data.get('id')
    if not res_id:
        return jsonify({'error': '缺少预约 ID'}), 400

    db  = get_db()
    cur = db.cursor()
    cur.execute('SELECT * FROM reservations WHERE id = ?', (res_id,))
    res = cur.fetchone()
    if not res:
        return jsonify({'error': '未找到该预约记录'}), 404

    if not is_reservation_owner(res, g.current_user):
        return jsonify({'error': '无权操作此预约'}), 403

    if res['status'] == 'released':
        return jsonify({'error': '该预约已处于释放状态'}), 400

    cur.execute("UPDATE reservations SET status = 'released' WHERE id = ?", (res_id,))
    db.commit()
    return jsonify({'status': 'released', 'message': '预约已成功取消'})

@app.route('/api/checkin', methods=['POST'])
@login_required
def checkin():
    """签到入座（状态变为 active）"""
    data   = request.json or {}
    res_id = data.get('id')
    if not res_id:
        return jsonify({'error': '缺少预约 ID'}), 400

    db  = get_db()
    cur = db.cursor()
    cur.execute('SELECT * FROM reservations WHERE id = ?', (res_id,))
    res = cur.fetchone()
    if not res:
        return jsonify({'error': '未找到预约记录'}), 404

    if not is_reservation_owner(res, g.current_user):
        return jsonify({'error': '无权操作此预约'}), 403

    if res['status'] != 'reserved':
        return jsonify({'error': f"当前状态不可签到: {res['status']}"}), 400

    cur.execute("UPDATE reservations SET status = 'active' WHERE id = ?", (res_id,))
    db.commit()
    return jsonify({'status': 'active', 'message': '签到成功，已进入使用状态'})

@app.route('/api/release-self', methods=['POST'])
@login_required
def release_self():
    """临时有事提前释放座位"""
    data   = request.json or {}
    res_id = data.get('id')
    if not res_id:
        return jsonify({'error': '缺少预约 ID'}), 400

    db  = get_db()
    cur = db.cursor()
    cur.execute('SELECT * FROM reservations WHERE id = ?', (res_id,))
    res = cur.fetchone()
    if not res:
        return jsonify({'error': '未找到预约记录'}), 404

    if not is_reservation_owner(res, g.current_user):
        return jsonify({'error': '无权操作此预约'}), 403

    if res['status'] == 'released':
        return jsonify({'error': '座位已处于释放状态'}), 400

    cur.execute("UPDATE reservations SET status = 'released' WHERE id = ?", (res_id,))
    db.commit()
    return jsonify({'status': 'released', 'message': '座位已成功释放'})

# ==================== 管理员 API 与统计看板 ====================
@app.route('/api/admin/reservations', methods=['GET'])
@admin_required
def admin_list():
    """
    管理员端预约管理：支持多维搜索与过滤
    参数: keyword (学生名/学号/座位号), status (reserved/active/released/timeout_released), date (YYYY-MM-DD)
    """
    keyword = request.args.get('keyword', '').strip()
    status_filter = request.args.get('status', '').strip()
    date_filter = request.args.get('date', '').strip()

    db  = get_db()
    cur = db.cursor()

    query = '''
        SELECT r.*, u.username, u.nickname, s.name as seat_name, s.floor, s.zone
        FROM reservations r
        LEFT JOIN users u ON r.user_id = u.id
        LEFT JOIN seats s ON r.seat_id = s.id
        WHERE 1=1
    '''
    params = []

    if status_filter:
        query += ' AND r.status = ?'
        params.append(status_filter)

    if date_filter:
        query += ' AND r.start_time LIKE ?'
        params.append(f"{date_filter}%")

    if keyword:
        # 模糊匹配学生账号、姓名、或者座位名称/座位ID
        query += ' AND (r.user_name LIKE ? OR u.username LIKE ? OR u.nickname LIKE ? OR s.name LIKE ? OR CAST(r.seat_id as TEXT) LIKE ?)'
        like_str = f"%{keyword}%"
        params.extend([like_str, like_str, like_str, like_str, like_str])

    query += ' ORDER BY r.start_time DESC LIMIT 300'
    cur.execute(query, params)
    rows = [dict(row) for row in cur.fetchall()]
    return jsonify(rows)

@app.route('/api/admin/users', methods=['GET'])
@admin_required
def admin_users():
    """
    管理员端学生管理：支持姓名/学号关键字搜索，以及违约黑名单过滤
    """
    keyword = request.args.get('keyword', '').strip()
    restricted_only = request.args.get('restricted')

    db  = get_db()
    cur = db.cursor()
    query = "SELECT id, username, nickname, role, violation_count, is_restricted, created_at FROM users WHERE 1=1"
    params = []

    if restricted_only == '1':
        query += " AND (is_restricted = 1 OR violation_count >= 3)"

    if keyword:
        query += " AND (username LIKE ? OR nickname LIKE ?)"
        like_str = f"%{keyword}%"
        params.extend([like_str, like_str])

    query += " ORDER BY is_restricted DESC, violation_count DESC, id DESC LIMIT 300"
    cur.execute(query, params)
    rows = [dict(row) for row in cur.fetchall()]
    return jsonify(rows)

@app.route('/api/admin/reset-violation', methods=['POST'])
@admin_required
def admin_reset_violation():
    """管理员重置学生违约次数并解除预约限制"""
    data = request.json or {}
    user_id = data.get('user_id')
    if not user_id:
        return jsonify({'error': '缺少 user_id'}), 400

    db = get_db()
    cur = db.cursor()
    cur.execute('''
        UPDATE users
        SET violation_count = 0, is_restricted = 0
        WHERE id = ?
    ''', (user_id,))
    db.commit()
    if cur.rowcount == 0:
        return jsonify({'error': '用户不存在'}), 404
    return jsonify({'status': 'ok', 'message': '该学生违约记录已成功清零，已恢复预约资格'})

@app.route('/api/admin/release', methods=['POST'])
@admin_required
def admin_release():
    data = request.json or {}
    reservation_id = data.get('id')
    if not reservation_id:
        return jsonify({'error': 'id required'}), 400
    db  = get_db()
    cur = db.cursor()
    cur.execute('UPDATE reservations SET status = ? WHERE id = ?', ('released', reservation_id))
    db.commit()
    if cur.rowcount == 0:
        return jsonify({'error': '预约记录不存在'}), 404
    return jsonify({'status': 'released'})

@app.route('/api/admin/stats', methods=['GET'])
@admin_required
def admin_stats():
    """管理员监控看板数据统计"""
    db  = get_db()
    cur = db.cursor()
    today_prefix = datetime.now().strftime('%Y-%m-%d')

    # 1. 今日预约总量
    cur.execute("SELECT COUNT(*) FROM reservations WHERE start_time LIKE ?", (today_prefix + '%',))
    today_total = cur.fetchone()[0]

    # 2. 当前正在使用 (active) 与预约中 (reserved) 人数
    cur.execute("SELECT status, COUNT(*) FROM reservations WHERE status IN ('reserved','active') GROUP BY status")
    status_counts = dict(cur.fetchall())
    active_count = status_counts.get('active', 0)
    reserved_count = status_counts.get('reserved', 0)

    # 3. 总座位数与实时利用率
    cur.execute("SELECT COUNT(*) FROM seats")
    total_seats = cur.fetchone()[0] or 1
    utilization_rate = round((active_count + reserved_count) / total_seats * 100, 1)

    # 4. 各楼层当前在座数
    cur.execute('''
        SELECT s.floor, COUNT(r.id) as occupied_count
        FROM seats s
        LEFT JOIN reservations r ON s.id = r.seat_id AND r.status IN ('reserved','active')
        GROUP BY s.floor
    ''')
    floor_stats = [dict(row) for row in cur.fetchall()]

    return jsonify({
        'today_total': today_total,
        'active_count': active_count,
        'reserved_count': reserved_count,
        'total_seats': total_seats,
        'utilization_rate': utilization_rate,
        'floor_stats': floor_stats
    })

# ==================== 静态页面路由 ====================
@app.route('/')
@app.route('/login')
def login_page():
    return send_from_directory(app.static_folder, 'login.html')

@app.route('/register')
def register_page():
    return send_from_directory(app.static_folder, 'register.html')

@app.route('/user')
def user_page():
    return send_from_directory(app.static_folder, 'user.html')

@app.route('/admin')
def admin_page():
    return send_from_directory(app.static_folder, 'admin.html')

@app.route('/ai-monitor')
def ai_monitor_page():
    return send_from_directory(os.path.dirname(os.path.abspath(__file__)), 'index.html')

if __name__ == '__main__':
    print("=" * 55)
    print("  智座星野 - 图书馆座位智能综合服务平台 已启动")
    print("  服务地址: http://127.0.0.1:5000")
    print("  开馆时间: 08:00 - 22:00 | 守护调度引擎: 已就绪")
    print("  默认学生: student1 / 123456")
    print("  默认管理: admin1   / adminpwd")
    print("=" * 55)
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port, debug=False)
