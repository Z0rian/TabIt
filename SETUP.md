# TabIt — GitHub Pages Setup Guide

## What you're getting
| Feature | How it works |
|---|---|
| **Hosting** | GitHub Pages (free, always-on) |
| **Personal sync** | Private GitHub Gist (only you see it) |
| **Cross-device** | Push on one device, Pull on another using same token |
| **Global library** | `songs/` folder in your repo — searchable by anyone using the app |
| **Contribute** | One tap uploads a song to the global library |

---

## Step 1 — Create the GitHub repo

1. Go to **github.com** and sign in.
2. Click **+** → **New repository**.
3. Name it **`tabit`** (lowercase).
4. Set it to **Public** (required for GitHub Pages on free accounts).
5. ✅ Check **"Add a README file"** (makes the repo non-empty).
6. Click **Create repository**.

---

## Step 2 — Upload the app files

You need to put these files at the **root** of the repo:

```
tabit/
├── index.html          ← the entire app
├── manifest.json       ← PWA config
├── sw.js               ← service worker (offline support)
├── icons/
│   ├── icon-192.png
│   └── icon-512.png
└── songs/
    └── index.json      ← starts as []  — global library index
```

**Easiest method — GitHub web upload:**

1. Open your new repo on GitHub.
2. Click **Add file → Upload files**.
3. Drag in `index.html`, `manifest.json`, `sw.js`.
4. Click **Commit changes**.
5. Go back, click **Add file → Create new file**.
6. Name it `songs/index.json`, paste in `[]`, commit.
7. Click **Add file → Upload files** again, upload the `icons/` folder
   (drag both PNGs, GitHub will create the folder automatically).

**Or use Git (faster if you have it):**
```bash
git clone https://github.com/YOUR-USERNAME/tabit.git
# copy all files from the tabit-gh/ folder into this repo folder
cd tabit
git add .
git commit -m "Initial TabIt deploy"
git push
```

---

## Step 3 — Enable GitHub Pages

1. In your repo, click **Settings** → **Pages** (left sidebar).
2. Under **Source**, choose **Deploy from a branch**.
3. Branch: **main**, folder: **/ (root)**.
4. Click **Save**.
5. Wait ~60 seconds, then your app is live at:
   **`https://YOUR-USERNAME.github.io/tabit/`**

---

## Step 4 — Generate a Personal Access Token (PAT)

This is what powers sync and the global library. You need it once per device.

1. Go to **github.com/settings/tokens** (classic tokens).
2. Click **Generate new token (classic)**.
3. Give it a name like `TabIt`.
4. Set expiration: **No expiration** (or 1 year if you prefer).
5. Check these scopes:
   - ✅ **`repo`** (full repo access — needed to write songs/ folder)
   - ✅ **`gist`** (needed for personal sync)
6. Click **Generate token**.
7. **Copy it immediately** — GitHub won't show it again.

---

## Step 5 — Connect the app to GitHub

1. Open your live app at `https://YOUR-USERNAME.github.io/tabit/`.
2. Tap **⚙ Settings** tab.
3. Fill in:
   - **GitHub Token**: paste your PAT from Step 4
   - **GitHub Username**: your GitHub username (e.g. `johndoe`)
   - **Repo Name**: `tabit`
4. Settings save automatically to your browser.

---

## Step 6 — First sync

**To back up your library:**
- Settings → **⬆ Push Up**
- A private gist is created. Only you can access it.

**To restore on another device:**
1. Open the app on the new device.
2. Go to Settings, enter your token + username + repo.
3. Paste your **Gist ID** (shown after first push, also in your GitHub Gists page).
4. Tap **⬇ Pull Down**.

---

## How the Global Library works

- **Read:** Anyone who opens the app and enters the repo owner + repo name can search songs.
- **Contribute:** Open any song → tap **🌐 Contribute** in the controls bar.
  - This writes a JSON file to `songs/` in your repo and updates `songs/index.json`.
  - Requires your PAT with `repo` scope.
  - Album covers are **not** uploaded (too large for Git).
- **Browse:** Tap **+ New** → **🌐 Search Global Library** to find contributed songs.

> **Note:** Since it's your public repo, you control the global library. You can delete
> songs from it directly on GitHub if needed (just delete the file and remove its entry
> from `songs/index.json`).

---

## Keeping the app updated

When you get a new version of `index.html`:
1. Upload the new file to your repo (drag-and-drop over the existing one on GitHub).
2. Your live site updates within a minute.

Your **songs are never in `index.html`** — they live in localStorage and your private Gist,
so updating the app never affects your library.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| App shows 404 | GitHub Pages takes up to 10 min on first deploy — wait and refresh |
| "Could not load global library" | Check that `songs/index.json` exists in repo and is valid JSON (`[]`) |
| Push says 401 Unauthorized | Token expired or wrong scope — regenerate with `repo` + `gist` scopes |
| Contribute fails | Make sure repo name and owner are exactly right in Settings |
| Service worker serving old version | Hard-refresh: hold Shift + tap reload, or clear site data in browser |
