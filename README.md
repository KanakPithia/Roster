# Roster (Google Drive edition)

No server, no database to host, no monthly cost. The shared task board is
just a JSON file that lives in Google Drive; the app is static files you can
host for free on GitHub Pages. Everyone signs in with their own Google
account.

## How it works

- The **admin** creates a board — this creates one file called
  `roster-data.json` in *their* Google Drive.
- The admin **invites teammates by email** — this shares that file with
  them in Drive (as an editor) and gives you a link to send them.
- Everyone's app reads and writes directly to that same file using their
  own Google sign-in. There's no in-between server at all.

## One-time setup (you've already done most of this)

You've already created the Google Cloud project, enabled the Drive API, set
up the OAuth consent screen, and created the OAuth Client ID. Two things
worth double-checking:

1. **Test users list matters more than it looks.** While your app is in
   "Testing" mode (the default, and the easiest path — no Google review
   needed), *only* the Google emails you've explicitly added under
   **OAuth consent screen → Test users** are allowed to sign in at all.
   Sharing the Drive file with someone isn't enough by itself — if their
   email isn't also on that Test users list, they'll hit an "Access
   blocked" screen from Google when they try to sign in. **Whenever you
   invite a new teammate in the app, also add their email to the Test users
   list in Google Cloud Console.**
2. **The "unverified app" warning is expected.** Because this app asks for
   full Drive access (needed to read/write the shared file), Google shows
   an "Google hasn't verified this app" screen during sign-in for
   everyone, including you. This is normal for an internal tool — click
   **Advanced → Go to Roster (unsafe)** to continue. It's not actually
   unsafe; that wording is Google's generic caution for any unreviewed app.

## Step 1 — Host the app on GitHub Pages (free)

1. In your existing GitHub repo (or a new one), upload everything from the
   `web-gdrive` folder to the **root** of the repo (drag-and-drop upload,
   same as before).
2. Repo → **Settings** → **Pages** (left sidebar).
3. Under **Source**, choose **Deploy from a branch**, branch `main`,
   folder `/ (root)`. Save.
4. GitHub gives you a URL like `https://kanakpithia.github.io/your-repo-name/`.
   Wait a minute or two for it to go live.

## Step 2 — Confirm your Google Cloud origin matches

Go back to **Google Cloud Console → Credentials → your OAuth Client** and
make sure **Authorized JavaScript origins** includes exactly
`https://kanakpithia.github.io` (just the origin — no path, no trailing
slash). If your Pages URL ends up on a different origin than what you
registered, sign-in will fail with a "redirect_uri_mismatch"-style error;
just add the correct origin here and save.

## Step 3 — Create the board (you, as admin)

1. Open your GitHub Pages URL.
2. **Sign in with Google** (click through the "unverified app" warning as
   described above).
3. Choose **Create a new board**. You're now the admin.

## Step 4 — Invite your team

1. Go to the **Team** tab → **Invite teammate**.
2. Enter their Google email, click **Send invite** — this shares the Drive
   file with them and shows you an invite link.
3. **Also add their email** to Google Cloud Console's Test users list
   (Step-0 reminder above) — easy to forget, and sign-in silently fails
   without it.
4. Send them the invite link (Slack, email, whatever). Opening it and
   signing in drops them straight into the board as a regular member.

## Notifications

Same trade-off as the very first version of this app: notifications work
while someone has the tab open (foreground or background), using the
browser's Notification API. There's no push-when-fully-closed here, since
that would need a server component — which is exactly what this
architecture avoids. If push-when-closed becomes a must-have later, that's
a sign to bring back a small backend just for that piece.

## Backups

Every save happens in Google Drive, which automatically keeps version
history — right-click the `roster-data.json` file in Drive → **Manage
versions** to see or restore past states. The app's **Export** button
(top-right, download icon) also lets anyone download a snapshot anytime.

## A small honest caveat

Saving works by reading the file, changing it, and writing it back — there's
no true file-locking here (Drive's simple upload API doesn't offer clean
conditional writes for this use case). If two people save within the same
second, the second write could overwrite the first. For a small team's task
list this is a low-probability, low-stakes edge case, and Drive's version
history is there if you ever need to recover something.
