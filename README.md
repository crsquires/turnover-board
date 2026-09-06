# Turnover Board

A shared cleaning schedule for your Airbnb properties. Fetches checkout dates
straight from Airbnb automatically (no pasting), and lets cleaners check off
finished jobs, rate guest tidiness (1-5), and leave notes for the host.

## Deploying (Render — free tier works)

1. Go to https://render.com and sign up (free, no credit card needed for this).
2. Put this folder in its own GitHub repo (or use Render's "Upload" option if you don't want to use GitHub — either works).
3. In Render, click **New +** → **Web Service**, and point it at the repo/folder.
4. Settings:
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Instance type:** Free
5. Under the service's **Disks** tab, add a persistent disk:
   - **Mount path:** `/opt/render/project/src/data`
   - **Size:** 1 GB (the smallest option — this app stores almost nothing)
   - This step matters: without it, your properties and cleaning logs would reset every time the app restarts.
6. Click **Deploy**. Render gives you a URL like `https://your-app-name.onrender.com` — that's the link you share with your cleaners.

## First-time setup (before anyone can log in)

There's a single link — `https://yourapp.onrender.com/` — that first asks **"Are you a cleaner or the host?"** and shows the right login from there. There's also a direct shortcut, `https://yourapp.onrender.com/host`, that skips straight to the host login for bookmarking.

Both the cleaner access code and the host password must be set **from Render's dashboard**, not through the app itself — there's no in-app way to claim the host password, on purpose, so a stranger who stumbles onto the page can't set it before you do.

1. In the Render dashboard, open your service → **Environment** tab.
2. Add two environment variables:
   - `ACCESS_CODE` — whatever you want cleaners to type in (e.g. `blue42`)
   - `ADMIN_CODE` — your own separate host password
3. Save — Render redeploys automatically, and the app applies both on startup.
4. Once it's back up, go to `/host`, log in with your `ADMIN_CODE`, and add each property: give it a name, and paste its Airbnb **export iCal link**
   (Airbnb host dashboard → Calendar → that listing → Availability → Sync calendars → **Export calendar**).
5. Share the plain `/` link and the `ACCESS_CODE` with your cleaners. Keep the host password to yourself (and any other host who needs it).

Both codes can also be changed later from inside the host panel (Manage properties → access code / host password) without touching Render — the environment variables are just how you set them the first time, or force-reset them if needed.

The calendar refreshes from Airbnb automatically (checked every ~10 minutes when someone opens the page) — no more manual updates or texting each change.

## If a code ever gets messed up

If another host accidentally changes the access code or password and you get locked out, you can force-reset either one from Render itself, without needing to already be logged in — same `ACCESS_CODE` / `ADMIN_CODE` environment variables as above. Update the value and redeploy; the app applies it on startup, overriding whatever was there before.

## Quick access for your phone

Since this behaves like an app once added to your home screen (via the manifest and icons already set up), tell your cleaners:

- **iPhone:** open the link in Safari, tap the Share icon, then "Add to Home Screen."
- **Android:** open the link in Chrome, tap the ⋮ menu, then "Add to Home screen" or "Install app."

Both logins have a "Stay logged in" checkbox — checked by default, it keeps you signed in for a year and survives app redeploys too (previously a redeploy would silently log everyone out). Uncheck it on a shared or public device to log out automatically when the browser closes.

## A couple of notes

- Render's free tier "spins down" after 15 minutes of no traffic and takes ~30-50 seconds to wake back up on the next visit. If that's annoying, Render's cheapest paid tier ($7/mo) keeps it always-on — or Railway.app is a similar alternative.
- The access code is basic protection, not bank-grade security — good enough to keep casual passersby out, not to protect truly sensitive data.
- Data lives in a single JSON file on the disk you attached. It's not built for huge scale, but it's completely fine for a handful of properties and cleaners.
