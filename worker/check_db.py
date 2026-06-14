import sqlite3
import os
db_path = '.wrangler/state/v3/d1/miniflare-D1DatabaseObject/948839c3e7f80a5fb5986eb251d4f968929b96850e32efd3994a2fc878af7216.sqlite'
if os.path.exists(db_path):
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    cursor.execute("SELECT name FROM sqlite_master WHERE type='table';")
    tables = cursor.fetchall()
    print('Tables:', [t[0] for t in tables])
    if ('manual_requests',) in tables:
        cursor.execute("SELECT COUNT(*) FROM manual_requests;")
        count = cursor.fetchone()[0]
        print(f'Number of manual requests: {count}')
        if count > 0:
            cursor.execute("SELECT id, customer_name, service_description, created_at FROM manual_requests LIMIT 5;")
            rows = cursor.fetchall()
            for row in rows:
                print(row)
    else:
        print('manual_requests table not found')
    conn.close()
else:
    print(f'Database not found at {db_path}')
