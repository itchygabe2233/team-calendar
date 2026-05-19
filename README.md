# TeamCal

A minimalist team calendar with live chat, role-based permissions, team colour-coding, and a peer-reviewed answer-key system for assignments.

---

## Quick start

**Requirements:** Node.js 16 or newer.

```bash
git clone <your-repo-url>
cd team-calendar
npm install
npm start
```

Open **http://localhost:3000** in your browser.

The **first account you register becomes the Owner** — register as `benxu12` (or your chosen username) before anyone else does.

---

## Running in dev mode (auto-restart)

```bash
npm run dev
```

---

## Local testing (multiple accounts from the same machine)

By default the server allows only one account per IP address. For local testing where everyone is on `127.0.0.1`, disable the check:

```bash
DISABLE_IP_CHECK=true npm start
```

Remove that flag when deploying publicly.

---

## Making the site publicly accessible

By default the server listens on all interfaces (`0.0.0.0`), so anyone who can reach your machine's IP address on the configured port can use the app. The easiest options:

| Method | How |
|---|---|
| **Railway** (recommended, free tier) | Push to GitHub → connect repo on [railway.app](https://railway.app) → set `PORT` env var → deploy. Railway gives you a public URL. |
| **Render** | Same flow on [render.com](https://render.com). Choose "Web Service", Node, `npm start`. |
| **VPS / cloud VM** | `npm start` on the server, open the port in your firewall, share `http://<your-ip>:3000`. |
| **ngrok (quick share)** | `npm start` locally, then `npx ngrok http 3000` for a temporary public URL. |

For any persistent deployment, set a stable `JWT_SECRET` environment variable so sessions survive restarts.

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `JWT_SECRET` | random string | Set a fixed secret in production so logins survive restarts |
| `DISABLE_IP_CHECK` | `false` | Set `true` only for local dev / multi-account testing |

Create a `.env` file or export them in your shell before `npm start`.

---

## Roles

| Role | Permissions |
|---|---|
| **Owner** | Everything — manage teams, all users, approve/reject entries, all CRUD |
| **Mod** | Approve/reject answer-key entries, edit any assignment, manage members & contributors |
| **Contributor** | Create & edit own assignments, submit answer-key entries |
| **Member** | View calendar, submit answer-key entries for review |

The **first registered user** is automatically assigned the Owner role.

---

## Teams

Three default teams are seeded on first run:

- **Team Imagine** — red  
- **Team Horizon** — blue  
- **Team Apex** — green  

Rename or recolour them in **Admin → Teams** (Owner only). You can also add or delete teams.

---

## Answer Keys

Every assignment has an attached answer key. Anyone can submit an answer for review. Owners and Mods approve or reject submissions. Approved answers are visible to everyone; pending/rejected entries are only visible to the submitter (and to Mods/Owners for review).

---

## Step-by-step: uploading to GitHub

### 1 — Create a new repository on GitHub

1. Go to [github.com](https://github.com) and sign in.
2. Click the **+** button (top-right) → **New repository**.
3. Give it a name (e.g. `team-calendar`).
4. Leave it **Private** if you want only your team to see the code, or **Public** if that's fine.
5. **Do not** check "Add a README" or "Add .gitignore" — the project already has both.
6. Click **Create repository**.

### 2 — Open a terminal in the project folder

```bash
cd path/to/team-calendar
```

### 3 — Initialise git and push

Copy the commands GitHub shows you after creating the repo, or run:

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/team-calendar.git
git push -u origin main
```

Replace `YOUR_USERNAME` and `team-calendar` with your actual GitHub username and repo name.

### 4 — Clone it on another machine

```bash
git clone https://github.com/YOUR_USERNAME/team-calendar.git
cd team-calendar
npm install
npm start
```

> **Important:** `data.db` (the database) is listed in `.gitignore` and will **not** be pushed to GitHub. Each machine that clones the repo starts with a fresh, empty database. The first person to register on that install becomes the Owner.

### 5 — Keeping it updated

After making changes:

```bash
git add .
git commit -m "Describe your change"
git push
```

To pull the latest version on another machine:

```bash
git pull
```

---

## Project structure

```
team-calendar/
├── server.js          ← Express API + all routes
├── db.js              ← SQLite schema & seed data
├── package.json
├── .gitignore
├── README.md
└── public/
    ├── index.html
    ├── style.css
    └── app.js
```
