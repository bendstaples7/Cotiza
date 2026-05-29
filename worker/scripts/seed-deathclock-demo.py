import sqlite3
db_path = '.wrangler/state/v3/d1/miniflare-D1DatabaseObject/948839c3e7f80a5fb5986eb251d4f968929b96850e32efd3994a2fc878af7216.sqlite'
conn = sqlite3.connect(db_path)
cur = conn.cursor()
uid = '374307fe-6de5-4a4e-b77e-0ed981584f96'

# Demo user
cur.execute("INSERT OR IGNORE INTO users (id, email, name, created_at, last_active_at) VALUES (?, ?, ?, datetime('now'), datetime('now'))", (uid, 'ben@chicago-reno.com', 'ben'))

# Demo requests at varying ages (using actual schema columns)
requests = [
    ('demo-green', uid, 'Alice Johnson', '555-0101', 'alice@example.com', '123 Oak St, Chicago', 'Paint living room walls and ceiling', '-2 hours'),
    ('demo-yellow', uid, 'Bob Martinez', '555-0102', 'bob@example.com', '456 Elm St, Evanston', 'Basement waterproofing and drywall repair', '-36 hours'),
    ('demo-orange', uid, 'Carol Chen', '555-0103', 'carol@example.com', '789 Pine St, Naperville', 'Complete bathroom renovation', '-60 hours'),
    ('demo-red', uid, 'Dave Williams', '555-0104', 'dave@example.com', '321 Maple Dr, Oak Park', 'Kitchen remodel - new cabinets countertops backsplash', '-96 hours'),
    ('demo-stale', uid, 'Eve Thompson', '555-0105', 'eve@example.com', '654 Cedar Ln, Schaumburg', 'Deck staining and sealing for large backyard deck', '-95 days'),
    ('demo-completed', uid, 'Frank Garcia', '555-0106', 'frank@example.com', '987 Birch Rd, Skokie', 'Drywall repair for multiple rooms after water damage', '-120 hours'),
]

for rid, uid, name, phone, email, addr, desc, age in requests:
    cur.execute(
        "INSERT OR IGNORE INTO manual_requests (id, user_id, customer_name, customer_phone, customer_email, customer_address, service_description, media_item_ids_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, '[]', datetime('now', ?))",
        (rid, uid, name, phone, email, addr, desc, age)
    )

# Check quote_drafts schema
cur.execute('PRAGMA table_info(quote_drafts)')
cols = cur.fetchall()
print('quote_drafts columns:')
for c in cols:
    print(f'  {c[1]:30s} {c[2]}')

# Session cookies to bypass overlay
cur.execute("INSERT OR REPLACE INTO jobber_web_session (id, cookies, expires_at) VALUES ('default', 'demo_session_cookie', datetime('now', '+1 day'))")

conn.commit()
cur.execute("SELECT COUNT(*) FROM manual_requests WHERE user_id = ?", (uid,))
count = cur.fetchone()[0]
conn.close()
print(f'Done. {count} demo manual requests inserted.')