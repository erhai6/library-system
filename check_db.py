import sqlite3
import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, 'library.db')

conn = sqlite3.connect(DB_PATH)
conn.row_factory = sqlite3.Row
cur = conn.cursor()

print("=" * 60)
print(f"检查数据库: {DB_PATH}")
print("=" * 60)

print("\n[1. 用户列表 Users]")
rows = cur.execute('SELECT id, username, nickname, role, created_at FROM users').fetchall()
for r in rows:
    print(f"ID={r['id']} 用户名={r['username']} 姓名={r['nickname']} 角色={r['role']}")

print("\n[2. 预约列表 Reservations]")
rows = cur.execute('SELECT * FROM reservations ORDER BY start_time DESC LIMIT 10').fetchall()
if not rows:
    print("暂无预约")
for r in rows:
    print(f"ID={r['id']} 座位={r['seat_id']} 用户={r['user_name']} 开始={r['start_time']} 结束={r['end_time']} 状态={r['status']}")

print("\n[3. 有效 Token 数量]")
cur.execute('SELECT COUNT(*) FROM tokens')
print(f"当前有效 Token 记录数: {cur.fetchone()[0]}")

conn.close()
