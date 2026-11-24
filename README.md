# Recordle

Rate albums song by song. Search any album, score every track from 0.5 to 10, and see each album's
highs and lows at a glance on a red-to-green color scale. Share your board with friends, compare
ratings and talk about them.

**Live site:** https://recordle.onrender.com

<!-- Add a screenshot here, e.g. ![Recordle dashboard](docs/screenshot.png) -->

## Features

- **Add any album from Apple's catalog.** Search by album or artist and it's added with its cover,
  release date and full tracklist. Albums already on your shelf can't be added twice.
- **Rate every song** from 0.5 to 10 in half steps. Each score has a fixed color, and every album and
  artist shows its average.
- **A dashboard of your shelf.** Albums are grouped by artist in release order, one row per artist,
  with a **Top albums** row for your five highest-rated. Drag albums and artists to rearrange them.
- **Private or public boards.** Boards are private by default; make yours public to share it at
  `/your-username`.
- **Friends.** Search people by username, send friend requests, and see friends' boards even when
  they're private. A friend's board shows their friend count and your mutual friends.
- **Notifications** when someone sends or accepts a friend request, adds or rates an album, or
  comments on one.
- **Comments** on any album, yours or a friend's.
- **Compare with friends.** Line up an album's ratings song by song with up to four friends who've
  rated it too.
- Works on phones, and in light and dark mode.

## Built with

- **Backend:** Python, Flask, Gunicorn
- **Database:** PostgreSQL on [Neon](https://neon.tech) in production, SQLite for local development
- **Frontend:** JavaScript, HTML and CSS, with no framework
- **Data:** Apple's [iTunes Search API](https://performance-partners.apple.com/search-api), called from the
  browser so each visitor has their own rate limit
- **Hosting:** [Render](https://render.com), set up with `render.yaml`

## Run it locally

You need Python 3.9 or newer.

```bash
python -m venv .venv
source .venv/bin/activate        # Windows (PowerShell): .venv\Scripts\Activate.ps1
pip install -r requirements.txt
python app.py
```

Open http://127.0.0.1:5000 and sign up. Your local data is saved in `instance/`, which git ignores.
In VS Code you can also press **F5** and pick **Run Recordle**.

To put your own copy online, see [DEPLOY.md](DEPLOY.md).

## Project layout

| File | What it does |
| --- | --- |
| `app.py` | Flask server: accounts, friends, notifications, comments, public pages and the JSON API |
| `db.py` | Database layer: SQLite locally, PostgreSQL when `DATABASE_URL` is set |
| `static/app.js` | Front end: dashboard, album search and ranking, ratings, drag-to-rearrange, friends, comments, compare |
| `static/style.css` | Styles, including light and dark mode |
| `templates/` | Page templates: the board, log in and sign up, not found |
| `render.yaml` | Render deployment settings |
