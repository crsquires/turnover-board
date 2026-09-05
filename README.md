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

## First-time setup (after it's deployed)

1. Open your new URL. Since no access code is set yet, it opens straight to the "Manage properties" area.
2. Tap **Manage properties**, set an **access code**, and save it.
3. Add each property: give it a name, and paste its Airbnb **export iCal link**
   (Airbnb host dashboard → Calendar → that listing → Availability → Sync calendars → **Export calendar**).
4. Share the URL and the access code with your cleaners.

The calendar refreshes from Airbnb automatically (checked every ~10 minutes when someone opens the page) — no more manual updates or texting each change.

## A couple of notes

- Render's free tier "spins down" after 15 minutes of no traffic and takes ~30-50 seconds to wake back up on the next visit. If that's annoying, Render's cheapest paid tier ($7/mo) keeps it always-on — or Railway.app is a similar alternative.
- The access code is basic protection, not bank-grade security — good enough to keep casual passersby out, not to protect truly sensitive data.
- Data lives in a single JSON file on the disk you attached. It's not built for huge scale, but it's completely fine for a handful of properties and cleaners.
