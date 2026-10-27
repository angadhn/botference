"""Small SQLite persistence boundary shared by the two Node frontends.

Only record operations cross stdin; no SQL, file contents, or model execution.
Transactions serialize concurrent Council/Discuss writers without lost updates.
"""
import datetime
import json
import os
import pathlib
import sqlite3
import sys

KINDS = {"projects", "sources", "outputs", "links", "uses"}


def run(file, request):
    actions = request.get("actions", [])
    if not file.exists() and not actions:
        return {k: [] for k in KINDS}
    file.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(file, timeout=5) as db:
        os.chmod(file, 0o600)
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("CREATE TABLE IF NOT EXISTS records(kind TEXT, id TEXT, data TEXT, PRIMARY KEY(kind,id))")
        db.execute("CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY, at TEXT, kind TEXT, id TEXT, action TEXT)")
        if actions:
            db.execute("BEGIN IMMEDIATE")
            now = datetime.datetime.now(datetime.timezone.utc).isoformat()
            for action in actions:
                kind, key = action.get("kind"), action.get("id")
                if kind not in KINDS or not isinstance(key, str) or not key or len(key) > 400:
                    raise ValueError("Invalid network record")
                row = db.execute("SELECT data FROM records WHERE kind=? AND id=?", (kind, key)).fetchone()
                if action.get('delete'):
                    db.execute('DELETE FROM records WHERE kind=? AND id=?', (kind, key))
                    db.execute('INSERT INTO events(at,kind,id,action) VALUES(?,?,?,?)', (now, kind, key, 'removed'))
                    continue
                old = json.loads(row[0]) if row else {}
                data = {**old, **action.get("data", {}), "id": key}
                if kind == 'sources' and old.get('page_updated_at') and data.get('page_updated_at', '') < old['page_updated_at']:
                    data = dict(old)
                if kind == 'uses' and old and (old.get('revision') != data.get('revision') or old.get('active') != data.get('active')):
                    previous = {k: old.get(k) for k in ('revision', 'line', 'excerpt', 'active', 'human_directed', 'updated_at')}
                    data['history'] = [*old.get('history', []), previous][-20:]
                for field, values in action.get("union", {}).items():
                    data[field] = list(dict.fromkeys([*old.get(field, []), *values]))
                for field, values in action.get("remove", {}).items():
                    data[field] = [v for v in old.get(field, []) if v not in values]
                # New guesses cannot undo a dismissal or manufacture approval.
                if kind == "links" and action.get("proposal") and old.get("state") in ("linked", "used", "dismissed"):
                    data = old
                if kind == "links" and action.get("respect_dismissal") and old.get("state") == "dismissed":
                    data = old
                if data == old:
                    continue
                data["updated_at"] = now
                data.setdefault("created_at", now)
                db.execute("INSERT INTO records VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data",
                           (kind, key, json.dumps(data, ensure_ascii=False)))
                db.execute("INSERT INTO events(at,kind,id,action) VALUES(?,?,?,?)",
                           (now, kind, key, action.get("event", "update")))
            db.execute("DELETE FROM events WHERE seq < (SELECT COALESCE(MAX(seq),0)-10000 FROM events)")
            db.commit()
        result = {k: [] for k in KINDS}
        for kind, raw in db.execute("SELECT kind,data FROM records ORDER BY kind,id LIMIT 20000"):
            result[kind].append(json.loads(raw))
        return result


if __name__ == "__main__":
    try:
        payload = sys.stdin.read(4 * 1024 * 1024 + 1)
        if len(payload) > 4 * 1024 * 1024:
            raise ValueError("Network update too large")
        print(json.dumps(run(pathlib.Path(sys.argv[1]), json.loads(payload or "{}")), ensure_ascii=False))
    except Exception as error:
        print(json.dumps({"error": str(error)}))
        sys.exit(1)
