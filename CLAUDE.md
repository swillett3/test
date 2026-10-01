# Crisis Simulation Platform — project notes for Claude

Live web platform for the 4-hour crisis simulation in **Responsible Management in Crisis** (UC Berkeley Haas, EWMBA 292T / MBA 292T, Fall 2026, instructor Amy Chan, reader Sam Willett).

- **Live event:** Wednesday 10/28/2026, 4:00 (or 4:15) – 8:00/8:15 PM PT. No make-up is possible, so reliability beats features.
- **Must be ready and rehearsed by about 10/19.** Case materials go to students on 10/21.
- **Scale:** about 40–50 students, in teams of 7.
- **Replaces:** last term's Slack-based setup.

## Hard rules
- **This repo is PUBLIC.** Never commit the real case script or anything from the licensed StarNight case packets: message text, facilitator notes, Drive links, or media. Committing them would spoil the sim for students and breaks the syllabus rule against posting class materials. The real script (`starnight-script.json`) lives on Sam's computer and is loaded through the console (Setup → Import). Tests use `tests/fixtures/sample-script.json`, which has the same structure and placeholder text. To test against the real file, set `SCRIPT_PATH=/path/to/starnight-script.json` locally and never commit it.
- **Students have no accounts.** That was Sam's choice. They sign in invisibly with Firebase Anonymous Auth.
- **Facilitators** sign in with Google: `sam_willett@berkeley.edu` and `amy.chan@berkeley.edu`. Keep `site/js/config.js` and `site/firestore.rules` in sync.
- **The course bans AI tools for students.** Nothing student-facing may use AI.

## Decisions already made with Sam
- **Media** (videos, audio, images) is linked to Google Drive, not hosted.
- **Benni McCann** (SVP, Mona) is a seventh student role, code `SVP`, and gets the six messages addressed to him.
- **All releases #1–#24 are scheduled** with the original spacing. The first release comes `firstReleaseDelayMin` (default 15) minutes after the sim starts. #24 was moved from 2 AM to 5 minutes after #23.
- **#13 is a live phone call.** Students see an "incoming call" notice (`studentBody`), and the actor script is facilitator-only. #13b is the manual-only contingency.
- **10 prepared interjections** (`source: "prepared"`, ids P01–P10) are unscheduled and released by hand.
- **Facilitators can interject live,** targeted to any set of roles × teams.

## Architecture (static site, no build step)
- **`site/index.html` + `js/student.js`:** the student feed. Students pick a team and role, then see an inbox, a social/news feed, and a "send a response" panel.
- **`site/admin.html` + `js/admin.js`:** the facilitator console. Its tabs are:
  - Timeline, with Release, targeted release, edit, skip and retract.
  - Compose/interject.
  - Responses inbox.
  - View as student.
  - Setup: teams, import/export, printable run-sheet, security self-check, and reset.
- **Auto-release runs in the facilitator's open console tab.** A 1-second loop releases items whose scheduled time has passed. If more than 3 items are over 2 minutes late, it prompts first: release all, shift the schedule, skip them, or turn auto-release off.
- **`js/model.js`:** pure logic, unit-tested. `studentProjection()` is the only thing written to the public feed and strips notes and other facilitator-only fields.
- **`js/backend-firebase.js`:** the real backend, Firebase JS SDK 10.12.2 from the gstatic CDN.
- **`js/backend-mock.js`:** a localStorage stand-in with the same interface that also enforces the rules. Open any page with `?backend=mock`.
- **Firestore layout:** see the header comment in `backend-firebase.js` and in `firestore.rules`.
  - `public/config`
  - `public/feed`: one document, released items stored as JSON strings
  - `private/script`
  - `private/control`
  - `responses/*`

## Tests
```
node --test tests/model.test.mjs          # unit
python3 tests/e2e.py                      # Playwright end-to-end on ?backend=mock: console + 3 students + mobile (51 checks)
npm install && npm run test:emulator       # Firestore + Auth emulators: rules tests (every allow/deny) + backend-firebase.js integration tests
```
All pass. The emulator tests import `backend-firebase.js` in Node with the npm `firebase@10.12.2` package (same version as the CDN) through `createBackend({sdk, config, emulator})`; the site calls it with no arguments. The browser e2e has NOT been run against the emulator: the session network blocks www.gstatic.com, where the site loads the SDK. Email/Password is always enabled in the Auth emulator, so the self-check's Email/Password row fails there by design.

## Open work, in priority order
1. **Apply the security review findings:**
   - Tighten `isAdmin()` in `firestore.rules` to:
     ```
     request.auth != null
       && request.auth.token.firebase.sign_in_provider == 'google.com'
       && request.auth.token.get('email_verified', false) == true
       && request.auth.token.get('email', '').lower() in [...]
     ```
   - In `studentProjection`, never fall back to `body` for `kind === "phone"` when `studentBody` is empty; use a generic "incoming call" line instead.
   - Improve `selfCheck()`:
     - Add probes: an update of an existing response sets `handled` (expect denied); a get of a single response (denied); a write to `private/script` (denied).
     - Add a check that Email/Password sign-in is disabled (`createUserWithEmailAndPassword` should fail with `auth/operation-not-allowed`).
     - Give each probe a 10-second timeout.
     - Delete the temporary anonymous user and surface cleanup failures.
2. **Test the real backend against the Firebase emulator:**
   - Install `firebase-tools` and `@firebase/rules-unit-testing` from npm. The emulator jar downloads from storage.googleapis.com.
   - Write rules tests covering every allow and deny in `firestore.rules`.
   - Run the e2e flow against the emulator, not the mock. The browser can't load the SDK from www.gstatic.com unless the environment allows it, so consider a test-only page or importing from the npm package.
   - Check the Firebase v10 API usage in `backend-firebase.js`: onSnapshot with options, the transaction + `set` merge, FieldPath and `deleteField`, multiple app instances in `selfCheck`.
3. **Independent code review** of `admin.js`, `student.js` and `backend-firebase.js`. Focus on:
   - races between two facilitator tabs with auto-release on
   - consistency between release, retract and edit
   - form state lost on re-render
   - reconnect behavior
4. **Write `SETUP.md` for Sam**, assuming he isn't a developer:
   - Create the Firebase project.
   - Upgrade to Blaze with a budget alert, so a student scripting a flood can't exhaust the free quota mid-session.
   - Enable only the Anonymous and Google sign-in methods. Keep Email/Password and all other providers disabled.
   - Publish the rules.
   - Paste the web config into `site/js/config.js`.
   - Hosting: GitHub Pages via an Actions workflow that publishes only `site/`, or Firebase Hosting. Add the hosting domain under Authentication → Settings → Authorized domains.
   - Share the StarNight Drive media files with the class.
   - Import the script.
   - Run the self-check.
   - Run a full dry run with volunteers.
5. **Hosting.** Pick and set it up. If GitHub Pages, add `.github/workflows/pages.yml` that deploys `site/` only.

## Known limits (accepted for now; tell Sam if asked)
- **Released messages are visible to all roles in dev tools.** All released messages for every role and team sit in one public document and are filtered in the browser, so a student using dev tools could read messages meant for other roles or teams. Unreleased messages are never exposed.
- **Auto-release needs a console tab open.** If every console tab closes, releases pause; reopening triggers the overdue prompt.
