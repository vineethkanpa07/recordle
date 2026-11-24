# Deploying Recordle (free: Render + Neon)

Render runs the app and Neon keeps the data. Both have free plans. Render's free servers erase their
files on every restart, so accounts, albums and ratings live in Neon's Postgres database instead. The
app refuses to start on Render without a `DATABASE_URL`, so data can't end up on that temporary disk.

## 1. Create the database (Neon)

1. Sign up at [neon.tech](https://neon.tech) and create a project. Pick a region near you, and use the
   same area for Render (for example both in US East / Virginia).
2. Click **Connect**, keep **Connection pooling** on, and copy the connection string. It looks like
   `postgresql://user:password@ep-something-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require`.
   Keep it private: anyone with it can read and change your data.

## 2. Deploy the app (Render)

1. Sign up at [render.com](https://render.com) with your GitHub account, and give Render access to this
   repository.
2. Click **New** > **Blueprint**, pick the repository, and click **Connect**. Render reads `render.yaml`.
3. When it asks for `DATABASE_URL`, paste the Neon connection string, then click **Apply**.
   If a deploy fails with `DATABASE_URL isn't set`, add it under the service's **Environment** tab and
   deploy again.
4. When the deploy is live, open the address Render shows and sign up.

## After that

- Every push to `main` redeploys the site.
- Free Render sites sleep after about 15 minutes with no visitors. The next visit takes up to a minute
  while it wakes up; nothing is lost.
- The `onrender.com` address is set when the service is created and can't be changed later. Use a custom
  domain (**Settings > Custom Domains**) if you want a different address.

## Settings

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | The Neon (Postgres) connection string. Required on Render. |
| `MUSICBOARD_SECRET` | Signs login cookies. Render generates one; changing it logs everyone out. |
| `MUSICBOARD_DEBUG` | `0` in production. |

The app was first called Musicboard; these setting names, and the local file `instance/musicboard.db`,
kept that name so existing logins and data keep working.
