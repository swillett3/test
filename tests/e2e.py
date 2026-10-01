"""End-to-end test of the crisis simulation site, using the in-browser test backend.

One facilitator console + several student tabs share one browser context (same localStorage),
which is how the test backend syncs them. Run: python3 tests/e2e.py
"""
import json, os, re, subprocess, sys, time, socket
from contextlib import closing
from playwright.sync_api import sync_playwright, expect

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = os.path.join(ROOT, "site")
SCRIPT = os.environ.get("SCRIPT_PATH") or os.path.join(ROOT, "tests", "fixtures", "sample-script.json")
SHOTS = os.environ.get("SHOTS_DIR") or os.path.join(ROOT, ".shots")
os.makedirs(SHOTS, exist_ok=True)

def free_port():
    with closing(socket.socket()) as s:
        s.bind(("127.0.0.1", 0)); return s.getsockname()[1]

PORT = free_port()
BASE = f"http://127.0.0.1:{PORT}"
server = subprocess.Popen([sys.executable, "-m", "http.server", str(PORT), "--bind", "127.0.0.1"], cwd=SITE,
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(0.8)

SCRIPT_DATA = json.load(open(SCRIPT))
ITEMS = {i["id"]: i for i in SCRIPT_DATA["items"]}
NAME = {r["code"]: r["character"] for r in SCRIPT_DATA["case"]["roles"]}

errors = []
results = []

def check(name, cond, detail=""):
    results.append((name, bool(cond), detail))
    print(("PASS " if cond else "FAIL ") + name + (f" — {detail}" if detail and not cond else ""))

def watch_errors(page, label):
    page.on("pageerror", lambda e: errors.append(f"{label}: pageerror {e}"))
    page.on("console", lambda m: errors.append(f"{label}: console.{m.type} {m.text}") if m.type == "error" else None)

def click_dialog(page, value):
    page.locator(f".dialog button[data-value='{value}']").click()

def mock_state(page, path):
    return page.evaluate(f"JSON.parse(localStorage.getItem('csim-mock:{path}') || 'null')")

def visible_for(item, team, role):
    a = item["audience"]
    teams_ok = a["teams"] == "ALL" or str(team) in [str(t) for t in a["teams"]]
    if not teams_ok: return False
    if item["channel"] == "social": return True
    return a["roles"] == "ALL" or role in a["roles"]

try:
    with sync_playwright() as pw:
        exe = os.environ.get("CHROMIUM_PATH") or ("/opt/pw-browsers/chromium-1194/chrome-linux/chrome" if os.path.exists("/opt/pw-browsers/chromium-1194/chrome-linux/chrome") else None)
        browser = pw.chromium.launch(executable_path=exe) if exe else pw.chromium.launch()
        ctx = browser.new_context(viewport={"width": 1440, "height": 900})

        # ---------- facilitator signs in ----------
        admin = ctx.new_page(); watch_errors(admin, "admin")
        admin.goto(f"{BASE}/admin.html?backend=mock")
        admin.evaluate("localStorage.clear(); sessionStorage.clear()")
        admin.reload()
        admin.locator("#signin-btn").click()
        expect(admin.locator(".console")).to_be_visible(timeout=5000)
        check("console loads after sign-in", True)
        check("no stray 'null' text in the console header", "null" not in admin.locator(".cbar").inner_text() + admin.locator("#c-next").inner_text())
        expect(admin.locator("#c-next")).to_contain_text("No script loaded")

        # ---------- students arrive before teams exist ----------
        s1 = ctx.new_page(); watch_errors(s1, "s1")
        s1.goto(f"{BASE}/index.html?backend=mock")
        expect(s1.locator(".join__wait")).to_be_visible(timeout=5000)
        check("student sees 'waiting for teams' before setup", True)

        # ---------- setup: teams + import ----------
        admin.locator(".ctab[data-tab=setup]").click()
        admin.locator("#s-nteams").fill("3")
        admin.locator("#s-team-names input").nth(1).fill("Falcons")
        admin.locator("#s-save-teams").click()
        expect(s1.locator("[data-team]")).to_have_count(3, timeout=5000)
        check("student join screen updates live when teams are saved", True)

        admin.locator("#s-file").set_input_files(SCRIPT)
        expect(admin.locator(".dialog")).to_contain_text(f"{len(ITEMS)} messages found")
        click_dialog(admin, "true")
        expect(admin.locator("#s-file-msg")).to_contain_text("Imported", timeout=5000)
        script_stored = mock_state(admin, "private/script")
        check("script imported in full", len(script_stored["items"]) == len(ITEMS), f"{len(script_stored['items'])} vs {len(ITEMS)}")
        check("nothing released at import", not (mock_state(admin, "public/feed") or {}).get("items"))

        # ---------- students join ----------
        s1.locator("[data-team='1']").click()
        s1.locator("[data-role='CFO']").click()
        s1.locator("#join-name").fill("Ana")
        s1.locator("#join-go").click()
        expect(s1.locator(".who__name")).to_have_text(NAME["CFO"], timeout=5000)
        check("join flow puts the student in their role", "team=1" in s1.url and "role=CFO" in s1.url, s1.url)
        expect(s1.locator("#inbox-list")).to_contain_text("hasn't started")

        s2 = ctx.new_page(); watch_errors(s2, "s2")
        s2.goto(f"{BASE}/index.html?backend=mock&team=2&role=SVP")
        expect(s2.locator(".who__name")).to_have_text(NAME["SVP"], timeout=5000)
        expect(s2.locator(".who__title")).to_contain_text("Falcons")
        s3 = ctx.new_page(); watch_errors(s3, "s3")
        s3.goto(f"{BASE}/index.html?backend=mock&team=1&role=CCO")
        expect(s3.locator(".who__name")).to_have_text(NAME["CCO"], timeout=5000)
        check("students can join by link with team & role", True)

        # ---------- start 40 minutes ago, turn on auto-release, handle the overdue prompt ----------
        admin.locator(".ctab[data-tab=timeline]").click()
        admin.evaluate("""() => {
          const k='csim-mock:public/config'; const c=JSON.parse(localStorage.getItem(k));
          c.simStart = Date.now() - 40*60000; c.firstReleaseDelayMin = 15; localStorage.setItem(k, JSON.stringify(c));
          window.dispatchEvent(new StorageEvent('storage', {key: k}));
        }""")
        expect(admin.locator(".pill--live")).to_be_visible(timeout=5000)
        expect(admin.locator(".nextup__due")).to_be_visible(timeout=5000)
        check("console shows overdue items when start is in the past", True)
        admin.locator("#auto-toggle").click()
        expect(admin.locator(".dialog")).to_contain_text("overdue", timeout=5000)
        check("auto-release asks before dumping a backlog", True)
        check("no stray 'null' text once running", "null" not in admin.locator(".cbar").inner_text() + admin.locator("#c-next").inner_text())
        click_dialog(admin, "release")
        time.sleep(2.5)
        feed = (mock_state(admin, "public/feed") or {}).get("items", {})
        cfg = mock_state(admin, "public/config")
        now_ms = admin.evaluate("Date.now()")
        expected_ids = {i["id"] for i in SCRIPT_DATA["items"]
                        if i["offsetMin"] is not None and not i["manualOnly"]
                        and cfg["simStart"] + (15 + i["offsetMin"]) * 60000 <= now_ms}
        got_ids = {e["sourceId"] for e in feed.values()}
        check("auto-release published exactly the due items", got_ids == expected_ids,
              f"missing {sorted(expected_ids - got_ids)[:5]} extra {sorted(got_ids - expected_ids)[:5]}")
        check("future items are not in the public feed", "R24" not in got_ids and "R19" not in got_ids)
        raw_feed = json.dumps(feed)
        check("facilitator notes never reach the public feed", "facilitator note" not in raw_feed and "Packet heading" not in raw_feed and '"notes"' not in raw_feed)

        # ---------- each student sees exactly their messages ----------
        def expect_counts(page, team, role, label):
            want_inbox = sum(1 for e in feed.values() if e["channel"] != "social" and visible_for(e, team, role))
            want_social = sum(1 for e in feed.values() if e["channel"] == "social" and visible_for(e, team, role))
            page.wait_for_timeout(800)
            got_inbox = page.locator("#inbox-list .inbox-row").count()
            got_social = page.locator("#social-list .post").count()
            check(f"{label}: inbox shows {want_inbox} messages", got_inbox == want_inbox, f"got {got_inbox}")
            check(f"{label}: social shows {want_social} posts", got_social == want_social, f"got {got_social}")
            return want_inbox
        n1 = expect_counts(s1, "1", "CFO", "team 1 CFO")
        n2 = expect_counts(s2, "2", "SVP", "team 2 SVP")
        expect_counts(s3, "1", "CCO", "team 1 CCO")
        check("SVP sees the SVP-only voicemail (R02)", "REMINDER" in s2.locator("#inbox-list").inner_text())
        check("CFO does not see the SVP-only voicemail", "REMINDER" not in s1.locator("#inbox-list").inner_text())
        badge = s1.locator("#badge-inbox").inner_text() if s1.locator("#badge-inbox").is_visible() else ""
        check("unread count shown in tab title", s1.title().startswith(f"({n1})"), s1.title())

        # open a message, it becomes read
        s1.locator("#inbox-list .inbox-row").first.click()
        expect(s1.locator("#reader .reader__subject")).to_be_visible()
        check("opening a message marks it read", s1.title().startswith(f"({n1 - 1})") or (n1 == 1 and not s1.title().startswith("(")), s1.title())
        s1.screenshot(path=f"{SHOTS}/student-desktop.png")

        # ---------- live interjection to team 2 SVP only ----------
        admin.locator(".ctab[data-tab=compose]").click()
        form = admin.locator(".compose__form")
        form.locator("[data-f=from]").fill("Board Chair")
        form.locator("[data-f=subject]").fill("ZZ Live check-in")
        form.locator("[data-f=body]").fill("Benni, call me in 5 minutes. https://example.com/brief")
        form.locator("[data-aud=all-roles]").uncheck()
        form.locator("[data-role=SVP]").check()
        form.locator("[data-aud=all-teams]").uncheck()
        form.locator("[data-team='2']").check()
        expect(admin.locator("#cmp-preview")).to_contain_text("ZZ Live check-in")
        admin.screenshot(path=f"{SHOTS}/admin-compose.png", full_page=True)
        admin.locator("#cmp-send").click()
        expect(s2.locator("#inbox-list")).to_contain_text("ZZ Live check-in", timeout=5000)
        expect(s2.locator(".toast")).to_contain_text("ZZ Live check-in", timeout=5000)
        check("targeted interjection reaches team 2 SVP with a notification", True)
        s1.wait_for_timeout(800)
        check("targeted interjection does not reach team 1", "ZZ Live" not in s1.locator("#inbox-list").inner_text() and "ZZ Live" not in s3.locator("#inbox-list").inner_text())
        s2.locator("#inbox-list .inbox-row", has_text="ZZ Live check-in").click()
        link = s2.locator("#reader a[href='https://example.com/brief']")
        check("links in messages are clickable and open in a new tab", link.count() == 1 and link.get_attribute("target") == "_blank")

        # ---------- XSS: body with HTML is shown as text ----------
        admin.locator(".ctab[data-tab=compose]").click()
        form = admin.locator(".compose__form")
        form.locator("[data-f=from]").fill("Test <b>sender</b>")
        form.locator("[data-f=subject]").fill("ZZ <img src=x onerror=window.__pwned=1>")
        form.locator("[data-f=body]").fill("<script>window.__pwned=1</script> plain")
        admin.locator("#cmp-send").click()
        expect(s1.locator("#inbox-list")).to_contain_text("ZZ <img", timeout=5000)
        s1.locator("#inbox-list .inbox-row", has_text="ZZ <img").click()
        s1.wait_for_timeout(300)
        check("HTML in messages is shown as text, never run", s1.evaluate("!window.__pwned") and s1.locator("#reader img").count() == 0)

        # ---------- student response reaches the console ----------
        s3.locator("#respond-open").click()
        s3.locator("#r-kind").select_option("social-reply")
        s3.locator("#r-text").fill("We are deeply sorry. <b>Full stop.</b> Statement to follow.")
        s3.locator("#r-send").click()
        expect(s3.locator("#r-status")).to_contain_text("Sent at", timeout=5000)
        expect(s3.locator("#sent-list")).to_contain_text("deeply sorry")
        expect(admin.locator("#cbadge-responses")).to_have_text("1", timeout=5000)
        admin.locator(".ctab[data-tab=responses]").click()
        expect(admin.locator(".resp")).to_contain_text("deeply sorry")
        expect(admin.locator(".resp")).to_contain_text(NAME["CCO"])
        check("student response appears in the console with team and role", True)
        check("response HTML is shown as text in the console", admin.locator(".resp b").count() == 0)
        admin.screenshot(path=f"{SHOTS}/admin-responses.png", full_page=True)
        admin.locator(".resp button[data-action=handled]").click()
        expect(admin.locator("#cbadge-responses")).to_have_text("", timeout=5000)
        check("marking handled clears the badge", True)

        # empty response is refused client-side
        s3.locator("#r-text").fill("   ")
        s3.locator("#r-send").click()
        expect(s3.locator("#r-status")).to_contain_text("Write something")

        # ---------- reply from the console goes to that team+role ----------
        admin.locator("#rf-open").uncheck()
        admin.locator(".resp button[data-action=reply]").click()
        form = admin.locator(".compose__form")
        check("reply pre-targets the responding team and role",
              form.locator("[data-role=CCO]").is_checked() and form.locator("[data-team='1']").is_checked()
              and not form.locator("[data-aud=all-roles]").is_checked())
        form.locator("[data-f=subject]").fill("ZZ Re: your statement")
        form.locator("[data-f=body]").fill("Good. Now the board.")
        admin.locator("#cmp-send").click()
        expect(s3.locator("#inbox-list")).to_contain_text("ZZ Re: your statement", timeout=5000)
        s1.wait_for_timeout(500)
        check("reply reaches only that CCO", "ZZ Re:" not in s1.locator("#inbox-list").inner_text())

        # ---------- retract ----------
        admin.locator(".ctab[data-tab=timeline]").click()
        admin.locator(".chip[data-filter=extra]").click()
        row = admin.locator(".tl-row", has_text="ZZ Live check-in")
        row.locator("button[data-action=more]").click()
        admin.locator(".dialog button", has_text="Retract").click()
        click_dialog(admin, "true")
        expect(s2.locator("#inbox-list")).not_to_contain_text("ZZ Live check-in", timeout=5000)
        check("retracting removes the message from students' screens", True)

        # ---------- phone call release keeps the script private ----------
        admin.locator(".chip[data-filter=inbox]").click()
        r13 = admin.locator(".tl-row[data-id=R13]")
        if r13.locator("button[data-action=release]").count():
            r13.locator("button[data-action=release]").click()
            click_dialog(admin, "true")
        expect(s3.locator("#inbox-list")).to_contain_text("Communication Decision", timeout=5000)
        s3.locator("#inbox-list .inbox-row", has_text="Communication Decision").click()
        txt = s3.locator("#reader").text_content()
        check("CCO sees an incoming-call notice, not the actor script", "Incoming call" in txt and "Note to actors" not in txt and "Topic 1" not in txt)
        check("call script not in any public data", "Note to actors" not in json.dumps(mock_state(admin, "public/feed")))
        admin.locator(".tl-row[data-id=R13] .tl-row__main").click()
        expect(admin.locator(".tl-row[data-id=R13] .tl-detail")).to_contain_text("Note to actors")
        check("console shows the call script to facilitators", True)
        admin.screenshot(path=f"{SHOTS}/admin-timeline.png")

        # ---------- targeted release of the contingency #13b ----------
        r13b = admin.locator(".tl-row[data-id=R13b]")
        r13b.locator("button[data-action=more]").click()
        admin.locator(".dialog button", has_text="Release to specific teams").click()
        admin.locator(".dialog [data-team='2']").check()
        click_dialog(admin, "go")
        time.sleep(1)
        f = mock_state(admin, "public/feed")["items"]
        k = [x for x in f if x.startswith("R13b~")]
        check("targeted release of #13b goes only to team 2", len(k) == 1 and f[k[0]]["audience"]["teams"] == ["2"], str(k))
        s3.wait_for_timeout(500)
        check("team 1 CCO does not get the team-2 contingency", "Need to connect on Zoom" not in s3.locator("#inbox-list").inner_text())

        # ---------- auto-release keeps working in normal flow (no prompt for on-time items) ----------
        before = len(mock_state(admin, "public/feed")["items"])
        admin.evaluate("""() => {  // pull the schedule forward by 3 minutes: a few items become due, none overdue
          const k='csim-mock:public/config'; const c=JSON.parse(localStorage.getItem(k));
          c.simStart -= 3*60000; localStorage.setItem(k, JSON.stringify(c));
          window.dispatchEvent(new StorageEvent('storage', {key: k}));
        }""")
        time.sleep(3)
        after = len(mock_state(admin, "public/feed")["items"])
        check("auto-release publishes newly due items without prompting", after > before and admin.locator(".dialog").count() == 0, f"{before}->{after}")

        # ---------- shift-the-schedule path ----------
        admin.locator("#auto-toggle").click()  # off
        time.sleep(0.5)
        admin.evaluate("""() => { const k='csim-mock:public/config'; const c=JSON.parse(localStorage.getItem(k));
          c.simStart -= 30*60000; localStorage.setItem(k, JSON.stringify(c)); window.dispatchEvent(new StorageEvent('storage', {key: k})); }""")
        time.sleep(0.5)
        admin.locator("#auto-toggle").click()  # on → overdue prompt
        expect(admin.locator(".dialog")).to_contain_text("overdue", timeout=5000)
        n_before = len(mock_state(admin, "public/feed")["items"])
        click_dialog(admin, "shift")
        time.sleep(2.5)
        n_after = len(mock_state(admin, "public/feed")["items"])
        check("shifting the schedule releases only the next item, not the backlog", 1 <= n_after - n_before <= 3, f"{n_before}->{n_after}")
        check("no second overdue prompt after shifting", admin.locator(".dialog").count() == 0)
        admin.locator("#auto-toggle").click()  # off

        # ---------- reload keeps identity and read state ----------
        s1.reload()
        expect(s1.locator(".who__name")).to_have_text(NAME["CFO"], timeout=5000)
        check("reload keeps the student's role", True)

        # ---------- view-as-student preview matches the real student ----------
        admin.locator(".ctab[data-tab=preview]").click()
        admin.locator("#pv-team").select_option("1")
        admin.locator("#pv-role").select_option("CFO")
        admin.wait_for_timeout(300)
        check("console preview matches the student's inbox",
              admin.locator("#pv .inbox-row").count() == s1.locator("#inbox-list .inbox-row").count(),
              f"{admin.locator('#pv .inbox-row').count()} vs {s1.locator('#inbox-list .inbox-row').count()}")

        # ---------- mobile layout ----------
        mob = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
        m = mob.new_page(); watch_errors(m, "mobile")
        # mobile context has its own storage: copy the mock data across
        dump = admin.evaluate("JSON.stringify(Object.fromEntries(Object.entries(localStorage).filter(([k])=>k.startsWith('csim-mock:'))))")
        m.goto(f"{BASE}/index.html?backend=mock")
        m.evaluate(f"(d)=>{{const o=JSON.parse(d); for(const k in o) localStorage.setItem(k,o[k]);}}", dump)
        m.goto(f"{BASE}/index.html?backend=mock&team=1&role=CEO")
        expect(m.locator(".tabs")).to_be_visible(timeout=5000)
        m.locator("#inbox-list .inbox-row").first.click()
        expect(m.locator(".pane--reader")).to_be_visible()
        check("mobile: opening a message shows the reader", not m.locator(".pane--inbox").is_visible())
        m.screenshot(path=f"{SHOTS}/student-mobile-reader.png")
        m.locator(".reader__back").click()
        expect(m.locator(".pane--inbox")).to_be_visible()
        m.locator(".tab[data-tab=social]").click()
        expect(m.locator(".pane--social")).to_be_visible()
        m.screenshot(path=f"{SHOTS}/student-mobile-social.png")
        m.locator(".tab[data-tab=respond]").click()
        expect(m.locator("#r-text")).to_be_visible()
        check("mobile: inbox, social and respond tabs all work", True)
        overflow = m.evaluate("document.documentElement.scrollWidth > window.innerWidth + 1")
        check("mobile: no horizontal scrolling", not overflow)

        # ---------- non-facilitator Google account is refused ----------
        other = browser.new_context()
        o = other.new_page()
        o.goto(f"{BASE}/admin.html?backend=mock&mockEmail=student@berkeley.edu")
        o.locator("#signin-btn").click()
        expect(o.locator("text=Not on the facilitator list")).to_be_visible(timeout=5000)
        check("a non-facilitator account cannot open the console", True)

        # ---------- reset ----------
        admin.locator(".ctab[data-tab=setup]").click()
        admin.locator("#s-reset-resp").check()
        admin.locator("#s-reset").click()
        admin.locator("#reset-confirm").fill("RESET")
        click_dialog(admin, "true")
        expect(s1.locator("#inbox-list")).to_contain_text("hasn't started", timeout=5000)
        st = mock_state(admin, "private/script")["items"]
        check("reset clears students' screens, keeps the script, drops live messages",
              not mock_state(admin, "public/feed")["items"] and len(st) == len(ITEMS) and not any(v["source"] == "live" for v in st.values()))
        check("reset deletes responses when asked", not mock_state(admin, "responses"))

        admin.screenshot(path=f"{SHOTS}/admin-setup.png", full_page=True)
        browser.close()
finally:
    server.terminate()

real_errors = [e for e in errors if "favicon" not in e]
check("no JavaScript errors on any page", not real_errors, "; ".join(real_errors[:5]))
failed = [r for r in results if not r[1]]
print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
sys.exit(1 if failed else 0)
