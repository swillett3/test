# Setup guide: from zero to a live simulation

This guide takes you from nothing to a working simulation site.
- **Time:** about 60–90 minutes of clicking, spread over one or two sittings.
- **Code:** none. The only "code" you touch is pasting one block of text into one file.
- **Deadline:** finish by about **10/16** so the dry run can happen before **10/19**.

You will end up with two links:

- **Student link:** `https://swillett3.github.io/test/`. Every student opens this.
- **Facilitator console:** `https://swillett3.github.io/test/admin.html`. You and Amy use this.

> Optional, and best done now before you share anything: rename the repo from `test` to something like `crisis-sim` (GitHub → the repo → **Settings** → **General** → **Repository name**). The links then become `…github.io/crisis-sim/`. Nothing else in this guide changes.

---

## Part 1 — Put the site online (GitHub, ~10 min)

1. **Turn on GitHub Pages.** In the repo, go to **Settings** → **Pages** (left menu). Under **Build and deployment** → **Source**, choose **GitHub Actions**. Nothing else to set.
2. **Merge the finished code.** Open the **Pull requests** tab, then the pull request titled **"Setup guide, GitHub Pages hosting, and reviewed fixes"**. Click **Merge pull request** and then **Confirm merge**.
3. **Check that it published.** Open the **Actions** tab. A run called **"Deploy site to GitHub Pages"** should turn green within about a minute.
   - If it failed, check that step 1 says **GitHub Actions**, then click the run and **Re-run all jobs**.
4. **Open the student link.** It should say *"This site hasn't been connected to its database yet."*
   - That's correct for now; Part 2 connects it.

---

## Part 2 — Create the Firebase project (~25 min)

Firebase is Google's service that stores the messages and pushes them to students' screens instantly.

> **Which Google account?** Try your **berkeley.edu** account first.
> - If Firebase says your organization doesn't allow creating projects, use a **personal Gmail** instead. Everything still works: you and Amy still sign in to the console with your berkeley.edu accounts.
> - Whichever account you use, keep using it for all of Part 2.

### 2a. Create the project
1. Go to **https://console.firebase.google.com** and sign in.
2. Click **Create a project** (or **Get started with a Firebase project**).
3. Name it something like `crisis-sim-fall26`. Accept the terms.
4. When it asks about **Google Analytics** or **Gemini/AI assistance**, turn them **off**. They aren't needed.
5. Click **Create project** and wait until it says it's ready, then **Continue**.

### 2b. Register the website and copy its settings
1. On the project's home page, click the **Web** icon (it looks like `</>`). It may be under **Add app**.
2. **App nickname:** `simulation site`. Leave **Firebase Hosting** unchecked.
3. Click **Register app**.
4. Firebase shows a block of code containing `const firebaseConfig = { apiKey: "…", authDomain: "…", … };`. Leave this page open; you need it in Part 3.
   - If you closed it, you can find it again: gear icon ⚙ (top left) → **Project settings** → **General** → scroll to **Your apps** → **Config**.
   - These values aren't secret. Every Firebase website ships them.

### 2c. Turn on sign-in, exactly two methods
1. In the left menu, open **Security** → **Authentication**. In some layouts it's under **Build** → **Authentication**; you can also type "Authentication" in the search bar at the top.
2. Click **Get started** if you see it.
3. Open the **Sign-in method** tab.
4. Click **Anonymous**, turn it **on**, then **Save**. This lets students in without accounts.
5. Click **Add new provider** → **Google**, turn it **on**, and pick your email as the **Project support email**. Click **Save**. This is how you and Amy sign in.
6. **Do not enable anything else.** Email/Password especially must stay **off**, because it could let someone pose as a facilitator. The self-check in Part 5 confirms it.
7. Add the website's address as an authorized domain. The quickest way there is this link: **https://console.firebase.google.com/project/_/authentication/settings** (pick your project if it asks). Otherwise use **Authentication** → the **Settings** tab at the top of the page, next to Users and Sign-in method.
   - On that page, the left side has a short sub-menu. Click **Authorized domains** there.
   - Click **Add domain** and enter `swillett3.github.io`, without `https://` or `/test`. Click **Add**.
   - `localhost` and two `…firebaseapp.com` / `…web.app` addresses are already listed. Leave them.
   - Without this, the facilitator Google sign-in window won't open.

### 2d. Create the database and lock it down
1. In the left menu, open **Databases & Storage** → **Firestore**. In some layouts it's **Build** → **Firestore Database**.
2. Click **Create database**.
   - If it asks for an **edition**, choose **Standard**.
   - Keep the database ID `(default)`.
3. **Location:** pick `us-west1 (Oregon)` or any US location. This can't be changed later, but any US option is fine.
4. **Security rules:** choose **Start in production mode**. Click **Create**.
5. When the database opens, go to its **Rules** tab.
6. Replace everything in the editor with the contents of [`site/firestore.rules`](site/firestore.rules) from the GitHub repo.
   - To copy it, open that file on GitHub and click the **Copy raw file** icon.
7. Click **Publish**.
   - The rules allow only `sam_willett@berkeley.edu` and `amy.chan@berkeley.edu` to run the console. To change who, see *Troubleshooting* at the end.

### 2e. Protect against a quota-draining prank (recommended, ~5 min)
On the free plan, a student who scripted thousands of fake responses could use up the day's free database allowance and freeze the sim mid-session. Upgrading to the pay-as-you-go **Blaze** plan removes that cliff.
- **What it costs:** a normal 4-hour session stays inside Blaze's free allowance, so it costs **$0**. A deliberate flood would cost a few dollars.
- **What you need:** a credit card.

1. In the bottom of the left menu, click **Spark** / **Upgrade** (or ⚙ → **Usage and billing** → **Details & settings** → **Modify plan**). Choose **Blaze**.
2. Add a billing account (card) when asked.
3. When it offers a **budget alert**, set it to **$10**. Budget alerts email you; they don't cap spending.
   - If you skip it here: open **https://console.cloud.google.com/billing** → your billing account → **Budgets & alerts** → **Create budget**.

If you can't add a card, skip this. Everything works on the free plan; it's just less prank-proof.

---

## Part 3 — Connect the site to Firebase (GitHub, ~5 min)

1. On GitHub, open the repo and go to `site/js/config.js`. Click the **pencil** icon (Edit this file).
2. Replace only the six lines between `export const FIREBASE_CONFIG = {` and `};` with the matching six values from the Firebase page in step 2b.
   - Keep the quotes and commas. It should end up looking like:
     ```js
     export const FIREBASE_CONFIG = {
       apiKey: "AIzaSy…",
       authDomain: "crisis-sim-fall26.firebaseapp.com",
       projectId: "crisis-sim-fall26",
       storageBucket: "crisis-sim-fall26.firebasestorage.app",
       messagingSenderId: "1234567890",
       appId: "1:1234567890:web:abc123",
     };
     ```
   - If Firebase also shows a `measurementId` line, you can leave it out.
3. Click **Commit changes…** and then **Commit changes** (straight to `main`).
4. Open the **Actions** tab. A new deploy runs; wait for green, about 1 minute.
5. Reload the student link. It should now say *"Your facilitators haven't set up the teams yet."*
   - That means it's connected.

---

## Part 4 — Load the simulation (console, ~15 min)

1. Open the console: `https://swillett3.github.io/test/admin.html`. Click **Sign in with Google** and use your **berkeley.edu** account.
2. **Setup tab → Teams:** enter the number of teams (for about 45 students in teams of 7, that's 6–7), rename them if you like, and click **Save teams**.
3. **Setup tab → Script:** choose the `starnight-script.json` file I sent you.
   - The import should say about **186 messages**.
   - Keep that file off GitHub. The repo is public.
4. **Timeline tab:** spot-check a few messages. Click a row to see what students will see, next to your facilitator notes.

### Make the media viewable
Messages link to the StarNight videos, audio and images in Google Drive. Those files are owned by Vincent Ding (last term's TA), so students can't open them yet.
- Ask Vincent or Amy to set each file to **"Anyone at UC Berkeley with the link → Viewer"**, using the file list I sent separately.
  - Use "UC Berkeley", not "Anyone with the link", because it's licensed case material.
- Students must be signed in to their berkeley.edu Google account in the same browser to open them.
- Test one from a student account in Part 6.

---

## Part 5 — Security self-check (2 min)

**Setup tab → Security self-check → Run self-check.** Every row should show ✓. It confirms, among other things, that:
- students can't see unreleased messages or other teams' responses
- students can't post as facilitators
- Email/Password sign-in is off

If a row fails, it says what to change. Usually that's a sign-in method left on or off in step 2c, or rules that weren't published in step 2d.

---

## Part 6 — Dry run with volunteers (by 10/19, ~45 min)

1. Recruit 3–6 people. Spencer offered to help.
2. In the console, click **Start now**, then turn **Auto-release ON**.
3. Volunteers open the student link on their own laptops and phones and pick different teams and roles.
4. Have them:
   - read messages
   - open a Drive attachment
   - send a response
5. You:
   - send a targeted interjection from **Compose / interject**
   - reply to a response
   - release #13b to one team
   - retract something
6. Have Amy open the console at the same time from her own laptop, so you both know it works with two facilitators.
7. Afterwards: **Setup → Reset simulation…** with **Also delete all student responses** checked. The script and teams stay.

### On the night (10/28)
- Open the console on a laptop that's **plugged in, with sleep turned off**. Auto-release runs from an open console tab. If every console tab is closed, releases pause until one is reopened, and the console then asks how to handle anything overdue.
- Keep a second console tab or Amy's laptop open as a backup.
- Use **Setup → Printable run-sheet** for a paper backup.
- Post the student link in bCourses before class. Students who join late see everything released so far.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Student page: "hasn't been connected to its database yet" | `config.js` still has the `PASTE_…` values, or the deploy hasn't finished. Redo Part 3 and check the Actions tab. |
| Google sign-in window closes or says *unauthorized domain* | Add `swillett3.github.io` under Authentication → Settings → Authorized domains (step 2c.7). |
| Google sign-in blocked: *"Access blocked … by your administrator"* | Berkeley's Google settings may block the sign-in for berkeley.edu accounts. Add a personal Gmail as a facilitator: put the address in **both** `site/js/config.js` (`ADMIN_EMAILS`) and `site/firestore.rules` (the list inside `isAdmin()`), commit, and re-publish the rules in Firebase (step 2d). |
| Console says "Not on the facilitator list" | You signed in with an address that isn't on the list. Sign out and use the right account, or add it as above. |
| A media link won't open for a student | The Drive file isn't shared with UC Berkeley, or the student isn't signed in to their berkeley.edu Google account in that browser. |
| Console shows "Lost connection to the database" | Auto-release pauses by itself and resumes when the connection returns. Check the Wi-Fi. If anything became overdue, the console asks what to do. |
| Need to add another facilitator | Same as the "Access blocked" fix: add the email to both files, commit, and re-publish the rules. |

## Rehearsing without Firebase
Add `?backend=mock` to either link, for example `…/admin.html?backend=mock`, to use a test mode where everything stays in your own browser. It's useful for clicking around, but it isn't connected to anyone else.
