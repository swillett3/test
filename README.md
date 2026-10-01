# Crisis Simulation Platform

A small live web platform for running a timed crisis simulation in class.

- **Students** open one link, pick their team and role, and watch messages and social posts arrive in real time. They can send responses back to the facilitators.
- **Facilitators** use a console to:
  - release scripted messages on schedule
  - interject new messages to any team or role
  - read responses as they come in

It is a static site (`site/`) on Firebase Firestore. Students need no account.

- **Try it locally with no setup:** `cd site && python3 -m http.server 8000`, then open `http://localhost:8000/admin.html?backend=mock` and `http://localhost:8000/index.html?backend=mock` in the same browser.
- **Tests:** `node --test tests/model.test.mjs` and `python3 tests/e2e.py`.

Case content isn't in this repository. Load your script file through the console's Setup tab.
