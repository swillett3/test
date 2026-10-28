# Crisis Simulation Platform

A small live web platform for running a timed crisis simulation in class.

- **Students** open their team's link (or the general link, where they also pick a team), pick their role, and watch messages and social posts arrive in real time. The feed is read-only: students can't message the facilitators through it.
- **Facilitators** use a console to:
  - release scripted messages on schedule
  - interject new messages to any team or role

It is a static site (`site/`) on Firebase Firestore. Students need no account.

- **Try it locally with no setup:** `cd site && python3 -m http.server 8000`, then open `http://localhost:8000/admin.html?backend=mock` and `http://localhost:8000/index.html?backend=mock` in the same browser.
- **Tests:** `node --test tests/model.test.mjs` and `python3 tests/e2e.py`. After `npm install`, `npm run test:emulator` runs the security-rules and Firebase-backend tests on the local Firebase emulator (needs Java).

Case content isn't in this repository. Load your script file through the console's Setup tab.
