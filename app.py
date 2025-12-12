import os
import json
import sqlite3
import logging
from datetime import datetime
from flask import Flask, render_template, request, jsonify
from flask_cors import CORS

app = Flask(__name__, static_url_path='/static')
CORS(app)

logging.basicConfig(
    level=logging.INFO,
    format='%(levelname)s:%(name)s:%(message)s'
)
logger = logging.getLogger(__name__)

DATABASE_PATH = os.environ.get("DATABASE_PATH", "events.db")


def init_db():
    """Initialize the SQLite database with events table."""
    conn = sqlite3.connect(DATABASE_PATH)
    cursor = conn.cursor()
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            payload TEXT NOT NULL
        )
    ''')
    conn.commit()
    conn.close()
    logger.info(f"Database initialized at {DATABASE_PATH}")


@app.route("/_stcore/health")
def health():
    return "", 200


@app.route("/")
def home():
    return render_template("index.html")


@app.route("/api/events", methods=["POST"])
def receive_event():
    """
    Receive JSON event data and store it in the database.
    Accepts any JSON payload and stores it as-is.
    """
    try:
        # Get JSON payload from request
        payload = request.get_json(force=True)

        if payload is None:
            return jsonify({"error": "Invalid JSON payload"}), 400

        # Store in database
        timestamp = datetime.utcnow().isoformat()
        conn = sqlite3.connect(DATABASE_PATH)
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO events (timestamp, payload) VALUES (?, ?)",
            (timestamp, json.dumps(payload))
        )
        conn.commit()
        event_id = cursor.lastrowid
        conn.close()

        logger.info(f"Event {event_id} stored successfully")

        return jsonify({
            "status": "success",
            "id": event_id,
            "timestamp": timestamp
        }), 201

    except Exception as e:
        logger.error(f"Error storing event: {e}")
        return jsonify({"error": str(e)}), 500


@app.route("/api/events", methods=["GET"])
def get_events():
    """
    Retrieve events from the database.
    Query parameters:
    - limit: number of events to return (default: 100)
    - offset: offset for pagination (default: 0)
    """
    try:
        limit = int(request.args.get("limit", 100))
        offset = int(request.args.get("offset", 0))

        conn = sqlite3.connect(DATABASE_PATH)
        cursor = conn.cursor()
        cursor.execute(
            "SELECT id, timestamp, payload FROM events ORDER BY id DESC LIMIT ? OFFSET ?",
            (limit, offset)
        )
        rows = cursor.fetchall()

        # Get total count
        cursor.execute("SELECT COUNT(*) FROM events")
        total_count = cursor.fetchone()[0]

        conn.close()

        # Format events
        events = []
        for row in rows:
            events.append({
                "id": row[0],
                "timestamp": row[1],
                "payload": json.loads(row[2])
            })

        return jsonify({
            "events": events,
            "total": total_count,
            "limit": limit,
            "offset": offset
        }), 200

    except Exception as e:
        logger.error(f"Error retrieving events: {e}")
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    # Initialize database on startup
    init_db()

    port = int(os.environ.get("PORT", 8888))
    logger.info(f"Starting Flask app on port {port}")
    app.run(host="0.0.0.0", port=port, debug=False)
