# Wimbledon 2026 Family Pool

## Setup (one-time, takes ~10 minutes)

### Step 1: Set up Supabase database
1. Go to your Supabase project → **SQL Editor** (left sidebar)
2. Click **New Query**
3. Paste the entire contents of `supabase-setup.sql`
4. Click **Run**
5. You should see "Success" — no errors

### Step 2: Push to GitHub Pages
1. Create a new GitHub repo called `wimbledon-pool` (make it Public)
2. Upload all files from this folder (index.html, admin/index.html)
3. Go to repo **Settings → Pages**
4. Set Source to **Deploy from branch → main → / (root)**
5. Click Save — GitHub will give you a URL like: `https://yourusername.github.io/wimbledon-pool`

### Step 3: Test it
- Open the URL — you should see the leaderboard
- Click "Make Picks" and submit a test bracket
- Go to `/admin` and log in with password: `wimbledon2026`
- Check the submissions table shows your test entry
- Delete it if needed (currently requires direct Supabase table edit — can add delete later)

### Step 4: Share with family
Send everyone the link. They open it, click "Make Picks", fill in their bracket, submit. Done.

---

## Admin Panel
Go to: `https://yourusername.github.io/wimbledon-pool/admin`
Password: `wimbledon2026`

**Change the password** by editing `admin/index.html` line with `const ADMIN_PASSWORD = 'wimbledon2026'`

### How to enter results:
1. Go to admin panel
2. Select gender (Men's / Women's)
3. Select round
4. Select winner from dropdown
5. Toggle "Straight Sets" if they won without dropping a set
6. Click Save Result

The leaderboard on the main site updates instantly.

### Locking picks:
- Toggle "Lock Picks" ON before the first match starts Monday June 29
- This stops new submissions and makes picks visible to everyone on the leaderboard

---

## Scoring
| Round | Correct Pick | Straight Sets Bonus |
|-------|-------------|-------------------|
| R1 | 1 pt | +0.5 pt |
| R2 | 2 pts | +1 pt |
| R3 (R16) | 4 pts | +1 pt |
| QF | 8 pts | +2 pts |
| SF | 16 pts | +4 pts |
| Final | 32 pts | +8 pts |
| Champion pick (each) | +25 pts | — |

---

## Files
- `index.html` — main app (leaderboard, pick submission, draw, scoring guide)
- `admin/index.html` — commissioner panel
- `supabase-setup.sql` — run once in Supabase SQL editor
