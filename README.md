# Recordle

Rate every song on the albums you listen to, from 0.5 to 10.

- Press **Add Album** and search for it. Pick it from the results and it's added with its cover and
  full tracklist, ready to score. Search uses Apple's free iTunes catalog, so it needs an internet connection.
- Open an album and type a score next to each song. **+ Add song** adds anything the tracklist is missing.
  Enter jumps from the name to the score, and Enter again starts the next song.
- Every score has a fixed color on a red (1) to green (10) scale.
- The dashboard groups albums by artist automatically, one row per artist with 6 albums in view;
  slide sideways with the ‹ › arrows (or swipe) when an artist has more. Press **Arrange** to drag
  albums within an artist, or drag whole artists up and down (arrow buttons work too).

## Friends and notifications

- Click **Friends** (next to Notifications, under your name) to search for people by username and send a friend request.
  They can accept or decline it; you can cancel a request or remove a friend at any time.
- **Notifications** (under your name) shows unread notifications: friend requests, accepted requests, and
  when a friend **adds an album** or **rates songs** on one, with the album cover and how long ago.
  Scoring a whole album sends one notification, not one per song.
- Friends can open each other's boards (read-only) even when they're private. Everyone else only sees
  boards that are public.
- The page checks for new notifications every 2 minutes while it's open and visible.

## Comments

Every album has a Comments section. The board's owner and their friends can comment; anyone who can see
the board can read them. You can delete your own comments, and owners can delete any comment on their
albums. New comments notify the album's owner and everyone else who commented on it.

## Accounts and public pages

- Everyone signs up with a **username and password**. Each person only sees their own albums.
- Boards are **private by default**. Click **Private** in the header and choose **Make public**,
  and anyone can see your board read-only at `/<your username>`, for example `http://127.0.0.1:5000/vineeth`.
- Click **Public** to copy your link or make the board private again.
- Albums saved before accounts existed are given to the first account that signs up.

Built with Python (Flask). On your computer your data is saved in `instance/musicboard.db` (SQLite).
That folder is ignored by git, so your ratings stay on your computer. When hosted, the app uses a
Postgres database instead (see below). Album covers are Apple's own artwork links.

## Run it

You need Python 3.9 or newer.

```bash
python -m venv .venv
```

Activate it. On macOS or Linux:

```bash
source .venv/bin/activate
```

On Windows (PowerShell):

```bash
.venv\Scripts\Activate.ps1
```

Then:

```bash
pip install -r requirements.txt
python app.py
```

Open http://127.0.0.1:5000 in your browser.

In VS Code you can also press **F5** and pick **Run Recordle**.

## Putting it online (free: Render + Neon)

Render runs the app and Neon keeps the data. Both have free plans. Render's free servers erase their
files on every restart, which is why accounts, albums and scores live in Neon's database instead.

**1. Make the database (Neon)**

1. Sign up at [neon.tech](https://neon.tech) and create a project. Pick the region closest to you
   (and pick the same area for Render in step 2, for example both in US East).
2. On the project dashboard, click **Connect** and copy the connection string. It looks like
   `postgresql://user:password@ep-something-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require`.
   Keep it private: anyone with it can read and change your data.

**2. Put the app on Render**

1. Sign up at [render.com](https://render.com) with your GitHub account.
2. Click **New** > **Blueprint**, pick the `recordle` repository, and click **Connect**.
   Render reads `render.yaml` from the repo, so everything is set up for you.
3. When it asks for `DATABASE_URL`, paste the Neon connection string. Click **Apply**.
4. Wait for the first deploy to finish (a few minutes). Your site is at the address Render shows,
   like `https://recordle.onrender.com` (Render adds letters if the name is taken).
5. Open it and sign up. The site starts empty; albums on your computer stay on your computer.

**After that**

- Every `git push` to `main` updates the site automatically.
- Free Render sites go to sleep after about 15 minutes with no visitors. The next visit takes up to a
  minute to load while it wakes up; after that it's normal speed. Nothing is lost while it sleeps.
- Album search runs in each visitor's browser, so Apple's limit (about 20 searches a minute) is per
  person, not shared by the whole site.

Settings Render uses (already in `render.yaml`): `DATABASE_URL` (your Neon database),
`MUSICBOARD_SECRET` (signs login cookies; Render generates it) and `MUSICBOARD_DEBUG=0`.
(The app was called Musicboard at first; these setting names and `instance/musicboard.db` kept that name
so existing logins and data keep working.)

## Files

| File | What it does |
| --- | --- |
| `app.py` | Flask server: accounts, public pages and the JSON API |
| `db.py` | Database: SQLite on your computer, Postgres when `DATABASE_URL` is set |
| `render.yaml` | Tells Render how to build and run the site |
| `templates/index.html` | Your board, and other people's public pages |
| `templates/auth.html` | Log in and sign up |
| `templates/not_found.html` | Shown for private or unknown usernames |
| `templates/_title.html`, `_head.html` | Shared title (with the vinyl) and page head |
| `static/app.js` | Dashboard, album search (calls Apple from the browser), album view, rating and drag-to-reorder |
| `static/style.css` | Styles (light and dark mode) |
