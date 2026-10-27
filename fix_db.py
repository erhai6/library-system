"""修复数据库中旧的 ISO 格式时间（T分隔符）为 SQLite 兼容格式（空格分隔符），并删除重复预约"""
import sqlite3, os

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'library.db')
conn = sqlite3.connect(DB_PATH)
conn.row_factory = sqlite3.Row
cur = conn.cursor()

# 1. 修复时间格式 T -> 空格
cur.execute("SELECT id, start_time, end_time FROM reservations")
rows = cur.fetchall()
fixed = 0
for r in rows:
    new_start = r['start_time'].replace('T', ' ')
    new_end   = r['end_time'].replace('T', ' ')
    if new_start != r['start_time'] or new_end != r['end_time']:
        cur.execute("UPDATE reservations SET start_time=?, end_time=? WHERE id=?",
                    (new_start, new_end, r['id']))
        fixed += 1
print(f"修复时间格式：{fixed} 条记录")

# 2. 找出并删除重复预约（同一座位、时间重叠、status 非 released）
cur.execute("SELECT * FROM reservations WHERE status != 'released' ORDER BY id")
active = cur.fetchall()
to_delete = set()
for i, a in enumerate(active):
    for b in active[i+1:]:
        if a['seat_id'] != b['seat_id']:
            continue
        # 检查时间重叠
        if a['start_time'] < b['end_time'] and a['end_time'] > b['start_time']:
            # 保留较早的预约（id 较小），删除后来的
            to_delete.add(b['id'])
            print(f"删除重复预约: ID={b['id']} 座位={b['seat_id']} 用户={b['user_name']} {b['start_time']}~{b['end_time']}")

if to_delete:
    cur.executemany("DELETE FROM reservations WHERE id=?", [(i,) for i in to_delete])
    print(f"已删除 {len(to_delete)} 条重复预约")
else:
    print("没有重复预约需要删除")

conn.commit()
conn.close()
print("完成！")
