"""Recordle: rate every song on the albums you listen to, 0.5 to 10.

Everyone signs up with a username and password. Albums are private by default;
switching a page to public makes /<username> show a read-only copy of that
person's dashboard.

Run with:  python app.py   then open http://127.0.0.1:5000
Hosting: see README.md (Render + a free Neon Postgres database).
"""

import math
import os
import re
import secrets
import time
from functools import wraps
from pathlib import Path

from flask import (Flask, abort, g, jsonify, redirect, render_template, request,
                   send_from_directory, session, url_for)
from werkzeug.middleware.proxy_fix import ProxyFix
from werkzeug.security import check_password_hash, generate_password_hash

import db as database

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("MUSICBOARD_DATA", BASE_DIR / "instance"))
DB_PATH = DATA_DIR / "musicboard.db"
COVER_DIR = DATA_DIR / "covers"

# Album covers are Apple's own artwork links, so nothing needs to be stored for them.
ARTWORK_URL_RE = re.compile(r"^https://[a-z0-9-]+\.mzstatic\.com/[^\s\"'<>]+$")
HOSTED = bool(os.environ.get("RENDER") or os.environ.get("MUSICBOARD_HOSTED"))

USERNAME_RE = re.compile(r"^[a-z0-9](?:[a-z0-9_.-]{1,28})[a-z0-9]$")
FILE_LIKE_RE = re.compile(r"\.(ico|txt|xml|json|webmanifest|html?|js|css|png|jpe?g|gif|svg|webp|php)$")
# Usernames that would clash with the app's own pages.
RESERVED_USERNAMES = {
    "about", "account", "admin", "api", "covers", "help", "login", "logout", "me",
    "musicboard", "recordle", "new", "settings", "signup", "static", "u", "user", "users",
    "friends", "notifications", "search",
}

DATA_DIR.mkdir(parents=True, exist_ok=True)
COVER_DIR.mkdir(parents=True, exist_ok=True)


def load_secret_key():
    """Signs login cookies. Set MUSICBOARD_SECRET when hosting; otherwise one is created on first run."""
    if os.environ.get("MUSICBOARD_SECRET"):
        return os.environ["MUSICBOARD_SECRET"]
    key_file = DATA_DIR / "secret_key"
    if not key_file.exists():
        key_file.write_text(secrets.token_hex(32))
    return key_file.read_text().strip()


app = Flask(__name__)
app.config.update(
    MAX_CONTENT_LENGTH=1024 * 1024,  # requests are small JSON now
    SECRET_KEY=load_secret_key(),
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SECURE=HOSTED,  # hosted sites use https, so only send the login cookie over https
    PERMANENT_SESSION_LIFETIME=60 * 60 * 24 * 30,  # stay logged in for 30 days
)
if HOSTED:
    # Render sits in front of the app; trust its headers so the app knows requests arrived over https.
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)


# ---------------------------------------------------------------- database

def get_db():
    if "db" not in g:
        g.db = database.connect(DB_PATH)
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    conn = g.pop("db", None)
    if conn is not None:
        database.close(conn)


# ---------------------------------------------------------------- accounts

def current_user():
    if "user" not in g:
        uid = session.get("uid")
        g.user = None
        if uid is not None:
            g.user = get_db().execute("SELECT * FROM users WHERE id = ?", (uid,)).fetchone()
            if g.user is None:
                session.clear()
    return g.user


def login_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if current_user() is None:
            if request.path.startswith("/api/"):
                return jsonify(error="Log in to make changes."), 401
            return redirect(url_for("login", next=request.path))
        return view(*args, **kwargs)
    return wrapped


def uid():
    return current_user()["id"]


def username_problem(name):
    """Return why a username can't be used, or None if it's fine."""
    if "/" in name or "\\" in name:
        return "Usernames can't have a slash (/) in them, since your username becomes your page's web address."
    if not USERNAME_RE.match(name):
        return "Usernames are 3 to 30 characters: lowercase letters, numbers, dots, dashes or underscores, starting and ending with a letter or number."
    if name in RESERVED_USERNAMES:
        return "That username is reserved. Pick another one."
    ending = FILE_LIKE_RE.search(name)
    if ending:
        # Browsers and search engines request addresses like /favicon.ico and /robots.txt on every site.
        return (f'Usernames can\'t end in "{ending.group(0)}", because that looks like a file name and could clash '
                "with files every website has. Try it without the ending.")
    return None


def safe_next(target):
    return target if target and target.startswith("/") and not target.startswith("//") else url_for("index")


@app.route("/signup", methods=["GET", "POST"])
def signup():
    if current_user():
        return redirect(url_for("index"))
    error = None
    username = (request.form.get("username") or "").strip().lower().lstrip("@")
    if request.method == "POST":
        password = request.form.get("password") or ""
        db = get_db()
        error = username_problem(username)
        if error:
            pass
        elif len(password) < 8:
            error = "Use a password of at least 8 characters."
        elif db.execute("SELECT 1 FROM users WHERE username = ?", (username,)).fetchone():
            error = "That username is taken. Try another one."
        else:
            first_user = db.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 0
            cur = db.execute(
                "INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)",
                (username, generate_password_hash(password), time.time()),
            )
            if first_user:  # albums saved before accounts existed belong to the first account
                db.execute("UPDATE artists SET user_id = ? WHERE user_id IS NULL", (cur.lastrowid,))
                db.execute("UPDATE albums SET user_id = ? WHERE user_id IS NULL", (cur.lastrowid,))
            db.commit()
            session.clear()
            session.permanent = True
            session["uid"] = cur.lastrowid
            return redirect(url_for("index"))
    return render_template("auth.html", mode="signup", error=error, username=username)


@app.route("/login", methods=["GET", "POST"])
def login():
    if current_user():
        return redirect(url_for("index"))
    error = None
    username = (request.form.get("username") or "").strip().lower().lstrip("@")
    next_url = request.values.get("next") or ""
    if request.method == "POST":
        user = get_db().execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
        if user is None or not check_password_hash(user["password_hash"], request.form.get("password") or ""):
            error = "That username and password don't match an account."
        else:
            session.clear()
            session.permanent = True
            session["uid"] = user["id"]
            return redirect(safe_next(next_url))
    return render_template("auth.html", mode="login", error=error, username=username, next=next_url)


@app.post("/logout")
def logout():
    session.clear()
    return redirect(url_for("login"))


@app.get("/api/me")
@login_required
def me():
    u = current_user()
    return jsonify(username=u["username"], is_public=bool(u["is_public"]))


@app.put("/api/me/visibility")
@login_required
def set_visibility():
    """Body: {"is_public": true} or {"is_public": false}."""
    data = request.get_json(silent=True) or {}
    db = get_db()
    db.execute("UPDATE users SET is_public = ? WHERE id = ?", (1 if data.get("is_public") else 0, uid()))
    db.commit()
    g.pop("user", None)
    return me()


# ---------------------------------------------------------------- helpers

def artist_key(name):
    return " ".join((name or "").lower().split())


def clean_rating(value):
    """Return a rating between 0.5 and 10 in half steps, or None for blank."""
    if value is None or value == "":
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        abort(400, "Rating must be a number from 0.5 to 10.")
    number = min(10.0, max(0.5, number))
    return math.floor(number * 2 + 0.5) / 2  # round halves up, same as the browser


def find_or_create_artist(db, user_id, name):
    name = " ".join((name or "").split()) or "Unknown artist"
    key = artist_key(name)
    row = db.execute("SELECT id FROM artists WHERE user_id = ? AND key = ?", (user_id, key)).fetchone()
    if row:
        return row["id"]
    pos = db.execute("SELECT COALESCE(MAX(position), -1) + 1 FROM artists WHERE user_id = ?", (user_id,)).fetchone()[0]
    cur = db.execute("INSERT INTO artists (user_id, name, key, position) VALUES (?, ?, ?, ?)", (user_id, name, key, pos))
    return cur.lastrowid


def remove_empty_artists(db, user_id):
    db.execute(
        "DELETE FROM artists WHERE user_id = ? AND id NOT IN (SELECT DISTINCT artist_id FROM albums)", (user_id,)
    )


def next_album_position(db, artist_id):
    return db.execute(
        "SELECT COALESCE(MAX(position), -1) + 1 FROM albums WHERE artist_id = ?", (artist_id,)
    ).fetchone()[0]


def cover_url(cover):
    """Albums store Apple's artwork link; albums added before hosting support may have a local file."""
    if not cover:
        return None
    return cover if cover.startswith("https://") else f"/covers/{cover}"


def delete_cover(filename):
    if filename and not filename.startswith("https://"):
        try:
            (COVER_DIR / filename).unlink()
        except FileNotFoundError:
            pass


def album_json(db, row):
    songs = db.execute(
        "SELECT id, name, rating, rated_at FROM songs WHERE album_id = ? ORDER BY position, id", (row["id"],)
    ).fetchall()
    return {
        "id": row["id"],
        "title": row["title"],
        "artist_id": row["artist_id"],
        "artist": row["artist"],
        "cover_url": cover_url(row["cover"]),
        "position": row["position"],
        "created_at": row["created_at"],
        "songs": [dict(s) for s in songs],
        "top_song_id": row["top_song_id"],
        "itunes_id": row["itunes_id"],
        "year": row["year"],
        "rated_at": row["rated_at"],
    }


def get_album_row(db, album_id):
    """The signed-in user's album, or 404 (also for someone else's album)."""
    row = db.execute(
        "SELECT albums.*, artists.name AS artist FROM albums JOIN artists ON artists.id = albums.artist_id "
        "WHERE albums.id = ? AND albums.user_id = ?",
        (album_id, uid()),
    ).fetchone()
    if row is None:
        abort(404, "Album not found.")
    return row


def owned_song(db, song_id):
    row = db.execute(
        "SELECT songs.id FROM songs JOIN albums ON albums.id = songs.album_id WHERE songs.id = ? AND albums.user_id = ?",
        (song_id, uid()),
    ).fetchone()
    if row is None:
        abort(404, "Song not found.")
    return row


def library_for(db, user_id):
    artists = [dict(r) for r in db.execute(
        "SELECT id, name, position FROM artists WHERE user_id = ? ORDER BY position, id", (user_id,))]
    rows = db.execute(
        "SELECT albums.*, artists.name AS artist FROM albums JOIN artists ON artists.id = albums.artist_id "
        "WHERE albums.user_id = ? ORDER BY albums.position, albums.created_at",
        (user_id,),
    ).fetchall()
    return {"artists": artists, "albums": [album_json(db, r) for r in rows]}


@app.errorhandler(400)
@app.errorhandler(404)
@app.errorhandler(409)
@app.errorhandler(413)
def json_error(err):
    message = getattr(err, "description", "Request failed.")
    if err.code == 413:
        message = "That request was too large."
    if request.path.startswith("/api/"):
        return jsonify(error=message), err.code
    if err.code == 404:
        return render_template("not_found.html"), 404
    return message, err.code


@app.errorhandler(database.DatabaseUnavailable)
def database_unavailable(err):
    database.log(f"Database unavailable: {err}")
    message = "Recordle can't reach its database right now. Try again in a minute."
    if request.path.startswith("/api/"):
        return jsonify(error=message), 503
    return render_template("not_found.html", heading="Can't reach the database", message=message), 503


@app.context_processor
def template_helpers():
    def asset(filename):
        """Static file URL that changes whenever the file changes, so browsers never use a stale copy."""
        try:
            version = int((BASE_DIR / "static" / filename).stat().st_mtime)
        except OSError:
            version = 0
        return f"/static/{filename}?v={version}"
    try:
        me = current_user()
    except database.DatabaseUnavailable:
        me = None  # still show the page (e.g. the "can't reach the database" message)
    return {"asset": asset, "me": me}


# ---------------------------------------------------------------- pages

@app.get("/")
@login_required
def index():
    return render_template("index.html", mode="owner", page_user=current_user())


@app.get("/covers/<path:filename>")
def cover(filename):
    return send_from_directory(COVER_DIR, filename)


def viewable_user(db, username):
    """The board owner if the viewer may see it: anyone for a public board, friends for a private one.
    Everyone else gets the same answer as for a username that doesn't exist."""
    user = db.execute("SELECT * FROM users WHERE username = ?", ((username or "").lower(),)).fetchone()
    if user is None:
        return None
    if user["is_public"]:
        return user
    me = current_user()
    if me is not None and (me["id"] == user["id"] or relation(db, me["id"], user["id"])[0] == "friend"):
        return user
    return None


def can_view_board(db, viewer_id, owner_id, owner_public):
    return bool(owner_public) or viewer_id == owner_id or relation(db, viewer_id, owner_id)[0] == "friend"


@app.get("/<username>")
def public_page(username):
    """Someone's board, read-only. Public boards are open to anyone; private ones only to friends."""
    db = get_db()
    user = viewable_user(db, username)
    if user is None:
        abort(404)
    me = current_user()
    is_friend = me is not None and me["id"] != user["id"] and relation(db, me["id"], user["id"])[0] == "friend"
    return render_template("index.html", mode="public", page_user=user, friends_only=not user["is_public"],
                           show_friend_counts=is_friend)


# ---------------------------------------------------------------- API

@app.get("/api/library")
@login_required
def library():
    return jsonify(library_for(get_db(), uid()))


@app.get("/api/u/<username>/library")
def public_library(username):
    db = get_db()
    user = viewable_user(db, username)
    if user is None:
        abort(404, "This page is private or doesn't exist.")
    return jsonify(library_for(db, user["id"]))


@app.delete("/api/albums/<int:album_id>")
@login_required
def delete_album(album_id):
    db = get_db()
    row = get_album_row(db, album_id)
    db.execute("DELETE FROM songs WHERE album_id = ?", (album_id,))
    db.execute("DELETE FROM comments WHERE album_id = ?", (album_id,))
    db.execute("DELETE FROM albums WHERE id = ?", (album_id,))
    remove_empty_artists(db, uid())
    db.commit()
    delete_cover(row["cover"])
    return "", 204


# ---------------------------------------------------------------- adding albums from iTunes

def big_artwork(url, size=600):
    """iTunes artwork URLs end in e.g. 100x100bb.jpg; ask for a larger square instead."""
    return re.sub(r"/\d+x\d+bb\.(jpg|png)$", f"/{size}x{size}bb.jpg", url or "") or None


def clean_text(value, limit=300):
    return " ".join(str(value or "").split())[:limit]


def clean_year(value):
    try:
        year = int(value)
    except (TypeError, ValueError):
        return None
    return year if 1900 <= year <= time.gmtime().tm_year + 1 else None


@app.post("/api/albums/<int:album_id>/year")
@login_required
def fill_in_year(album_id):
    """Body: {"year": 2016}. Fills in the release year for an album added before years were saved.
    It only sets a missing year, so album details stay as Apple gave them."""
    db = get_db()
    row = get_album_row(db, album_id)
    year = clean_year((request.get_json(silent=True) or {}).get("year"))
    if year is None:
        abort(400, "That isn't a release year.")
    if row["year"] is None:
        db.execute("UPDATE albums SET year = ? WHERE id = ?", (year, album_id))
        db.commit()
    return jsonify(year=row["year"] or year)


def release_order_position(db, artist_id, released):
    """Where a new album goes in its artist's row: before the first album released after it, so the
    row stays oldest-to-newest. Albums with no known date are skipped over. You can still drag
    albums anywhere afterwards; this only picks the starting spot."""
    end = next_album_position(db, artist_id)
    if not released:
        return end
    rows = db.execute(
        "SELECT id, position, released, year FROM albums WHERE artist_id = ? ORDER BY position, created_at", (artist_id,)
    ).fetchall()
    for row in rows:
        other = row["released"] or (str(row["year"]) if row["year"] else None)
        if not other:
            continue
        # compare full dates when both have one; otherwise just the years
        later = other > released if len(other) == len(released) == 10 else other[:4] > released[:4]
        if later:
            # make room: everything from this spot on moves one place to the right
            db.execute("UPDATE albums SET position = position + 1 WHERE artist_id = ? AND position >= ?",
                       (artist_id, row["position"]))
            return row["position"]
    return end


def already_on_shelf(db, itunes_id, title, artist):
    """The same Apple album, or (for albums added before IDs were saved) the same title by the same artist."""
    if db.execute("SELECT 1 FROM albums WHERE user_id = ? AND itunes_id = ?", (uid(), itunes_id)).fetchone():
        return True
    return db.execute(
        "SELECT 1 FROM albums JOIN artists ON artists.id = albums.artist_id "
        "WHERE albums.user_id = ? AND albums.itunes_id IS NULL AND LOWER(albums.title) = LOWER(?) AND artists.key = ?",
        (uid(), title, artist_key(artist)),
    ).fetchone() is not None


@app.post("/api/albums/import")
@login_required
def import_album():
    """Adds an album picked from iTunes search, with its full tracklist.

    The search runs in the visitor's browser (so Apple's rate limit is per visitor, not shared by
    the whole site), and the browser sends the album it looked up:
    {"id": <Apple's album ID>, "title": ..., "artist": ..., "year": 2016, "released": "2016-08-20",
     "artwork": "https://...mzstatic.com/...", "tracks": ["Song", ...]}
    """
    data = request.get_json(silent=True) or {}
    title, artist = clean_text(data.get("title")), clean_text(data.get("artist"))
    try:
        itunes_id = int(data.get("id"))
    except (TypeError, ValueError):
        abort(400, "Pick an album from the search results.")
    tracks = data.get("tracks")
    if not title or not artist or not isinstance(tracks, list) or len(tracks) > 300:
        abort(400, "Pick an album from the search results.")
    names = [clean_text(t) for t in tracks if isinstance(t, str)] or [""]
    year = clean_year(data.get("year"))
    released = str(data.get("released") or "")[:10]
    released = released if re.match(r"^\d{4}-\d{2}-\d{2}$", released) else None
    artwork = big_artwork(data.get("artwork"))
    if artwork and not ARTWORK_URL_RE.match(artwork):
        artwork = None  # only Apple's artwork links are used as covers
    db = get_db()
    if already_on_shelf(db, itunes_id, title, artist):
        abort(409, f"{title} is already on your shelf.")
    artist_id = find_or_create_artist(db, uid(), artist)
    position = release_order_position(db, artist_id, released or (str(year) if year else None))
    cur = db.execute(
        "INSERT INTO albums (user_id, title, artist_id, cover, position, created_at, itunes_id, year, released) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (uid(), title, artist_id, artwork, position, time.time(), itunes_id, year, released),
    )
    album_id = cur.lastrowid
    db.executemany(
        "INSERT INTO songs (album_id, name, rating, position) VALUES (?, ?, NULL, ?)",
        [(album_id, name, i) for i, name in enumerate(names)],
    )
    notify(db, friend_ids(db, uid()), uid(), "album_added", {"id": album_id, "title": title, "cover": artwork})
    db.commit()
    return jsonify(album_json(db, get_album_row(db, album_id))), 201


def song_key(name):
    return " ".join((name or "").lower().split())


@app.get("/api/albums/<int:album_id>/compare")
@login_required
def compare_album(album_id):
    """Friends who have this album with at least one song rated, with their scores lined up to your songs.

    A friend's album counts as the same one if it's the same Apple album, or (for albums added before
    Apple IDs were saved) has the same title and artist. Songs are matched by name.
    """
    db = get_db()
    mine = get_album_row(db, album_id)
    my_songs = db.execute("SELECT id, name FROM songs WHERE album_id = ? ORDER BY position, id", (album_id,)).fetchall()
    friends = friend_ids(db, uid())
    if not friends:
        return jsonify(friends=[])
    marks = ",".join("?" * len(friends))
    my_key = db.execute("SELECT key FROM artists WHERE id = ?", (mine["artist_id"],)).fetchone()["key"]
    candidates = db.execute(
        f"SELECT albums.id, albums.user_id, users.username FROM albums "
        f"JOIN artists ON artists.id = albums.artist_id JOIN users ON users.id = albums.user_id "
        f"WHERE albums.user_id IN ({marks}) AND ((albums.itunes_id IS NOT NULL AND albums.itunes_id = ?) "
        f"OR (LOWER(albums.title) = LOWER(?) AND artists.key = ?))",
        (*friends, mine["itunes_id"], mine["title"], my_key),
    ).fetchall()
    best = {}  # one album per friend: if they have two matching editions, the one they rated more
    for album in candidates:
        songs = db.execute("SELECT name, rating FROM songs WHERE album_id = ? ORDER BY position, id", (album["id"],)).fetchall()
        rated = [s for s in songs if s["rating"] is not None]
        previous = best.get(album["user_id"])
        if rated and (previous is None or len(rated) > len(previous[1])):
            best[album["user_id"]] = (album, rated, songs)
    out = []
    for album, rated, songs in best.values():
        by_name = {song_key(s["name"]): s["rating"] for s in songs if s["name"]}
        scores = {str(s["id"]): by_name[song_key(s["name"])] for s in my_songs
                  if by_name.get(song_key(s["name"])) is not None}
        out.append({"username": album["username"], "rated": len(rated), "total": len(songs),
                    "average": sum(s["rating"] for s in rated) / len(rated), "scores": scores})
    out.sort(key=lambda f: (-f["rated"], f["username"]))
    return jsonify(friends=out)


@app.put("/api/albums/<int:album_id>/top")
@login_required
def set_top_track(album_id):
    """Body: {"song_id": id}. Picks the top track among songs tied for the album's highest score."""
    db = get_db()
    get_album_row(db, album_id)
    try:
        song_id = int((request.get_json(silent=True) or {}).get("song_id"))
    except (TypeError, ValueError):
        abort(400, "Pick one of the songs.")
    best = db.execute("SELECT MAX(rating) FROM songs WHERE album_id = ?", (album_id,)).fetchone()[0]
    song = db.execute("SELECT rating FROM songs WHERE id = ? AND album_id = ?", (song_id, album_id)).fetchone()
    if song is None or best is None or song["rating"] != best:
        abort(400, "Only songs with the album's highest score can be the top track.")
    db.execute("UPDATE albums SET top_song_id = ? WHERE id = ?", (song_id, album_id))
    db.commit()
    return jsonify(top_song_id=song_id)


@app.patch("/api/songs/<int:song_id>")
@login_required
def update_song(song_id):
    db = get_db()
    owned_song(db, song_id)
    data = request.get_json(silent=True) or {}  # only the score can change; song names come from iTunes
    if "rating" in data:
        rating = clean_rating(data["rating"])
        song = db.execute("SELECT album_id, rating FROM songs WHERE id = ?", (song_id,)).fetchone()
        if song["rating"] != rating:
            db.execute("UPDATE songs SET rating = ?, rated_at = ? WHERE id = ?", (rating, time.time(), song_id))
            # remember when this album was last rated: the newest-rated album wins ties in Top albums
            db.execute("UPDATE albums SET rated_at = ? WHERE id = ?", (time.time(), song["album_id"]))
            notify_album_edited(db, uid(), db.execute("SELECT id, title, cover FROM albums WHERE id = ?", (song["album_id"],)).fetchone())
    db.commit()
    return jsonify(dict(db.execute("SELECT id, name, rating FROM songs WHERE id = ?", (song_id,)).fetchone()))


# ---------------------------------------------------------------- friends

def friend_ids(db, user_id):
    rows = db.execute(
        "SELECT requester_id, addressee_id FROM friendships WHERE status = 'accepted' AND (requester_id = ? OR addressee_id = ?)",
        (user_id, user_id),
    ).fetchall()
    return [r["addressee_id"] if r["requester_id"] == user_id else r["requester_id"] for r in rows]


def friendship_between(db, a, b):
    return db.execute(
        "SELECT * FROM friendships WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)",
        (a, b, b, a),
    ).fetchone()


def relation(db, me, other):
    """How `other` relates to `me`: friend, request_sent, request_received or none."""
    f = friendship_between(db, me, other)
    if f is None:
        return "none", None
    if f["status"] == "accepted":
        return "friend", f["id"]
    return ("request_sent" if f["requester_id"] == me else "request_received"), f["id"]


def notify(db, user_ids, actor_id, kind, album=None):
    now = time.time()
    db.executemany(
        "INSERT INTO notifications (user_id, actor_id, kind, album_id, album_title, album_cover, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [(u, actor_id, kind, album["id"] if album else None, album["title"] if album else None,
          album["cover"] if album else None, now) for u in user_ids],
    )


EDIT_GROUPING_SECONDS = 6 * 60 * 60


def notify_album_edited(db, actor_id, album_row):
    """Tell friends an album's scores changed, without one notification per song: if a friend already has
    an unread "added" or "edited" notification for this album from the last few hours, bump its time instead."""
    now = time.time()
    for friend in friend_ids(db, actor_id):
        recent = db.execute(
            "SELECT id, kind FROM notifications WHERE user_id = ? AND actor_id = ? AND album_id = ? AND read_at IS NULL "
            "AND kind IN ('album_added', 'album_edited') AND created_at > ? ORDER BY created_at DESC",
            (friend, actor_id, album_row["id"], now - EDIT_GROUPING_SECONDS),
        ).fetchone()
        if recent is None:
            notify(db, [friend], actor_id, "album_edited", album_row)
        elif recent["kind"] == "album_edited":
            db.execute("UPDATE notifications SET created_at = ? WHERE id = ?", (now, recent["id"]))
        # a recent unread "added" already covers it: they'll see the album with its scores


def user_by_name(db, username):
    row = db.execute("SELECT id, username, is_public FROM users WHERE username = ?", ((username or "").strip().lower().lstrip("@"),)).fetchone()
    if row is None:
        abort(404, "Nobody has that username.")
    return row


@app.get("/api/users/search")
@login_required
def search_users():
    q = (request.args.get("q") or "").strip().lower().lstrip("@")
    if len(q) < 2:
        return jsonify(results=[])
    db = get_db()
    pattern = "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
    rows = db.execute(
        "SELECT id, username, is_public FROM users WHERE username LIKE ? ESCAPE '\\' AND id != ? "
        "ORDER BY CASE WHEN username LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END, username LIMIT 10",
        (pattern, uid(), pattern[1:]),
    ).fetchall()
    results = []
    for r in rows:
        rel, _ = relation(db, uid(), r["id"])
        results.append({"username": r["username"], "is_public": bool(r["is_public"]), "relation": rel,
                        "can_view": bool(r["is_public"]) or rel == "friend"})
    return jsonify(results=results)


@app.get("/api/friends")
@login_required
def list_friends():
    db = get_db()
    rows = db.execute(
        "SELECT f.id, f.status, f.requester_id, f.created_at, u.username, u.is_public FROM friendships f "
        "JOIN users u ON u.id = CASE WHEN f.requester_id = ? THEN f.addressee_id ELSE f.requester_id END "
        "WHERE f.requester_id = ? OR f.addressee_id = ? ORDER BY u.username",
        (uid(), uid(), uid()),
    ).fetchall()
    out = {"friends": [], "received": [], "sent": []}
    for r in rows:
        item = {"id": r["id"], "username": r["username"], "is_public": bool(r["is_public"]), "since": r["created_at"],
                "can_view": bool(r["is_public"]) or r["status"] == "accepted"}
        if r["status"] == "accepted":
            out["friends"].append(item)
        else:
            out["sent" if r["requester_id"] == uid() else "received"].append(item)
    return jsonify(out)


@app.get("/api/u/<username>/friends")
@login_required
def board_friends(username):
    """A friend's friends, with which ones you share. Only that person's friends can see this list."""
    db = get_db()
    owner = user_by_name(db, username)
    if relation(db, uid(), owner["id"])[0] != "friend":
        abort(404, "Nobody has that username.")
    mine = set(friend_ids(db, uid()))
    theirs = friend_ids(db, owner["id"])
    if not theirs:
        return jsonify(total=0, mutual=0, friends=[])
    marks = ",".join("?" * len(theirs))
    rows = db.execute(f"SELECT id, username, is_public FROM users WHERE id IN ({marks}) ORDER BY username", tuple(theirs)).fetchall()
    friends = [{
        "username": r["username"],
        "you": r["id"] == uid(),
        "mutual": r["id"] in mine,
        "can_view": r["id"] == uid() or bool(r["is_public"]) or r["id"] in mine,
    } for r in rows]
    return jsonify(total=len(friends), mutual=sum(f["mutual"] for f in friends), friends=friends)


@app.post("/api/friends/request")
@login_required
def send_friend_request():
    """Body: {"username": "..."}. If they already asked you, this accepts their request instead."""
    db = get_db()
    other = user_by_name(db, (request.get_json(silent=True) or {}).get("username"))
    if other["id"] == uid():
        abort(400, "That's you.")
    rel, fid = relation(db, uid(), other["id"])
    if rel == "friend":
        return jsonify(relation="friend")
    if rel == "request_sent":
        return jsonify(relation="request_sent")
    if rel == "request_received":
        db.execute("UPDATE friendships SET status = 'accepted' WHERE id = ?", (fid,))
        notify(db, [other["id"]], uid(), "friend_accepted")
        db.commit()
        return jsonify(relation="friend")
    db.execute("INSERT INTO friendships (requester_id, addressee_id, status, created_at) VALUES (?, ?, 'pending', ?)",
               (uid(), other["id"], time.time()))
    notify(db, [other["id"]], uid(), "friend_request")
    db.commit()
    return jsonify(relation="request_sent"), 201


def forget_request_notification(db, to_user, from_user):
    db.execute("DELETE FROM notifications WHERE kind = 'friend_request' AND user_id = ? AND actor_id = ?", (to_user, from_user))


def received_request(db, request_id):
    row = db.execute("SELECT * FROM friendships WHERE id = ? AND addressee_id = ? AND status = 'pending'",
                     (request_id, uid())).fetchone()
    if row is None:
        abort(404, "That friend request isn't there anymore.")
    return row


@app.post("/api/friends/<int:request_id>/accept")
@login_required
def accept_friend_request(request_id):
    db = get_db()
    row = received_request(db, request_id)
    db.execute("UPDATE friendships SET status = 'accepted' WHERE id = ?", (request_id,))
    notify(db, [row["requester_id"]], uid(), "friend_accepted")
    db.commit()
    return jsonify(relation="friend")


@app.post("/api/friends/<int:request_id>/decline")
@login_required
def decline_friend_request(request_id):
    db = get_db()
    row = received_request(db, request_id)
    db.execute("DELETE FROM friendships WHERE id = ?", (request_id,))
    forget_request_notification(db, to_user=uid(), from_user=row["requester_id"])
    db.commit()
    return jsonify(relation="none")


@app.delete("/api/friends/<username>")
@login_required
def remove_friend(username):
    """Unfriend someone, or cancel a request you sent them."""
    db = get_db()
    other = user_by_name(db, username)
    f = friendship_between(db, uid(), other["id"])
    if f is not None:
        db.execute("DELETE FROM friendships WHERE id = ?", (f["id"],))
        if f["status"] == "pending":  # a cancelled request: take it out of their notifications too
            forget_request_notification(db, to_user=f["addressee_id"], from_user=f["requester_id"])
        db.commit()
    return jsonify(relation="none")


# ---------------------------------------------------------------- notifications

@app.get("/api/notifications")
@login_required
def list_notifications():
    db = get_db()
    # keep the newest 200 per person
    db.execute(
        "DELETE FROM notifications WHERE user_id = ? AND id NOT IN "
        "(SELECT id FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 200)", (uid(), uid()))
    db.commit()
    rows = db.execute(
        "SELECT n.*, u.username AS actor, u.is_public AS actor_public, "
        "o.id AS owner_id, o.username AS owner, o.is_public AS owner_public FROM notifications n "
        "JOIN users u ON u.id = n.actor_id "
        "LEFT JOIN albums a ON a.id = n.album_id LEFT JOIN users o ON o.id = a.user_id "
        "WHERE n.user_id = ? ORDER BY n.created_at DESC LIMIT 50",
        (uid(),),
    ).fetchall()

    def link(r):
        """Where clicking goes: the album itself when it still exists and you can see it, else the person's board."""
        if r["kind"] == "friend_request":
            return None
        if r["owner_id"] is not None:
            if r["owner_id"] == uid():
                return f"/#album-{r['album_id']}"
            if can_view_board(db, uid(), r["owner_id"], r["owner_public"]):
                return f"/{r['owner']}#album-{r['album_id']}"
        if can_view_board(db, uid(), r["actor_id"], r["actor_public"]):
            return f"/{r['actor']}"
        return None

    items = [{
        "id": r["id"], "kind": r["kind"], "actor": r["actor"], "link": link(r),
        "on_your_album": r["owner_id"] == uid(), "album_owner": r["owner"],
        "album_title": r["album_title"], "album_cover": cover_url(r["album_cover"]),
        "created_at": r["created_at"], "read": r["read_at"] is not None,
    } for r in rows]
    return jsonify(notifications=items, now=time.time())


@app.get("/api/notifications/unread")
@login_required
def unread_count():
    db = get_db()
    count = db.execute("SELECT COUNT(*) FROM notifications WHERE user_id = ? AND read_at IS NULL", (uid(),)).fetchone()[0]
    requests_waiting = db.execute(
        "SELECT COUNT(*) FROM friendships WHERE addressee_id = ? AND status = 'pending'", (uid(),)).fetchone()[0]
    return jsonify(unread=count, requests=requests_waiting)


@app.post("/api/notifications/read")
@login_required
def mark_notifications_read():
    db = get_db()
    db.execute("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL", (time.time(), uid()))
    db.commit()
    return jsonify(unread=0)


# ---------------------------------------------------------------- comments

COMMENT_LIMIT = 500


def album_with_owner(db, album_id):
    row = db.execute(
        "SELECT albums.id, albums.title, albums.cover, albums.user_id, users.username AS owner, users.is_public "
        "FROM albums JOIN users ON users.id = albums.user_id WHERE albums.id = ?", (album_id,)).fetchone()
    if row is None:
        abort(404, "Album not found.")
    return row


def comment_access(db, album):
    """(can read, can post). Anyone who can see the board can read; only its owner and their friends can post."""
    me = current_user()
    mine = me is not None and me["id"] == album["user_id"]
    friend = me is not None and not mine and relation(db, me["id"], album["user_id"])[0] == "friend"
    return bool(album["is_public"]) or mine or friend, mine or friend


@app.get("/api/albums/<int:album_id>/comments")
def list_comments(album_id):
    db = get_db()
    album = album_with_owner(db, album_id)
    can_read, can_post = comment_access(db, album)
    if not can_read:
        abort(404, "Album not found.")
    me = current_user()
    rows = db.execute(
        "SELECT c.id, c.body, c.created_at, c.user_id, u.username FROM comments c JOIN users u ON u.id = c.user_id "
        "WHERE c.album_id = ? ORDER BY c.created_at", (album_id,)).fetchall()
    return jsonify(
        owner=album["owner"], can_post=can_post, now=time.time(),
        comments=[{"id": r["id"], "author": r["username"], "body": r["body"], "created_at": r["created_at"],
                   "is_owner": r["user_id"] == album["user_id"],
                   "can_delete": me is not None and me["id"] in (r["user_id"], album["user_id"])} for r in rows])


@app.post("/api/albums/<int:album_id>/comments")
@login_required
def add_comment(album_id):
    db = get_db()
    album = album_with_owner(db, album_id)
    _, can_post = comment_access(db, album)
    if not can_post:
        abort(404, "Only friends can comment on this album.")
    body = ((request.get_json(silent=True) or {}).get("body") or "").strip()
    if not body:
        abort(400, "Write something first.")
    if len(body) > COMMENT_LIMIT:
        abort(400, f"Comments can be up to {COMMENT_LIMIT} characters.")
    now = time.time()
    cur = db.execute("INSERT INTO comments (album_id, user_id, body, created_at) VALUES (?, ?, ?, ?)",
                     (album_id, uid(), body, now))
    # tell the album's owner and everyone else who has commented on it (not the person writing)
    earlier = {r["user_id"] for r in db.execute("SELECT DISTINCT user_id FROM comments WHERE album_id = ?", (album_id,)).fetchall()}
    recipients = ({album["user_id"]} | earlier) - {uid()}
    notify(db, sorted(recipients), uid(), "comment", {"id": album_id, "title": album["title"], "cover": album["cover"]})
    db.commit()
    return jsonify(id=cur.lastrowid, author=current_user()["username"], body=body, created_at=now,
                   is_owner=uid() == album["user_id"], can_delete=True), 201


@app.delete("/api/comments/<int:comment_id>")
@login_required
def delete_comment(comment_id):
    """The person who wrote it, or the album's owner, can delete a comment."""
    db = get_db()
    row = db.execute("SELECT c.id, c.user_id, a.user_id AS owner_id FROM comments c JOIN albums a ON a.id = c.album_id "
                     "WHERE c.id = ?", (comment_id,)).fetchone()
    if row is None or uid() not in (row["user_id"], row["owner_id"]):
        abort(404, "Comment not found.")
    db.execute("DELETE FROM comments WHERE id = ?", (comment_id,))
    db.commit()
    return "", 204


@app.put("/api/order")
@login_required
def save_order():
    """Body: {"artists": [artist ids in order]} and/or {"albums": [album ids in order]}."""
    db = get_db()
    data = request.get_json(silent=True) or {}
    for i, artist_id in enumerate(data.get("artists") or []):
        db.execute("UPDATE artists SET position = ? WHERE id = ? AND user_id = ?", (i, int(artist_id), uid()))
    for i, album_id in enumerate(data.get("albums") or []):
        db.execute("UPDATE albums SET position = ? WHERE id = ? AND user_id = ?", (i, int(album_id), uid()))
    db.commit()
    return "", 204


database.init(DB_PATH)

if __name__ == "__main__":
    app.run(debug=os.environ.get("MUSICBOARD_DEBUG", "1") == "1")
