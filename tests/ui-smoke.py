#!/usr/bin/env python3
"""Offline browser checks for the INEPAD UI (no production accounts or writes)."""
import copy
import json
import os
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BANKS = [
    {"id": "bank-itau", "name": "Itaú Consulting"},
    {"id": "bank-sicred", "name": "Sicred"},
    {"id": "bank-btg", "name": "BB → Planner → BTG"},
    {"id": "bank-xp", "name": "XP"},
    {"id": "bank-verum", "name": "Verum"},
]
PARTNERS = [
    {"id": "partner-eduardo", "name": "Eduardo", "email": "eduardo@example.test", "share": 60, "minimum": 7000, "discount": 350},
    {"id": "partner-ana", "name": "Ana", "email": "ana@example.test", "share": 40, "minimum": 5000, "discount": 200},
]


def historical(quarter, balances, previous, actual):
    return {
        "id": quarter.replace(" ", "-"), "quarter": quarter,
        "current_cash": round(sum(balances), 2), "previous_distribution": previous,
        "distribution_pct": 90,
        "rows": {"source": "Planilha", "balances": dict(zip([b["name"] for b in BANKS], balances)), "actual_distribution": actual},
    }


FIXTURE = {
    "user": {"id": "admin", "name": "Eduardo", "email": "eduardo@example.test", "role": "admin"},
    "banks": BANKS, "partners": PARTNERS,
    "closings": [
        historical("2024 4º Trimestre", [400000, 600000, 120000, 180000, 100000], 1200000, 200000),
        historical("2025 1º Trimestre", [450000, 500000, 120000, 200000, 100000], 1400000, 210000),
        historical("2025 2º Trimestre", [420000, 550000, 120000, 230000, 100000], 1370000, 220000),
        historical("2025 3º Trimestre", [440000, 570000, 120000, 260000, 100000], 1420000, 240000),
        historical("2025 4º Trimestre", [500000, 500000, 120000, 220000, 100000], 1490000, 260000),
        historical("2026 1º Trimestre", [529643.82, 276005.22, 127761, 398179.8, 100000], 1343291.61, 313468.407),
        historical("2026 2º Trimestre", [725482.43, 299356, 127769, 297161, 100000], 1431589.84, 388482.2973),
        historical("2026 3º Trimestre", [763377.35, 295466.22, 130158.02, 304288.46, 100000], 1549768.43, 388803.52557),
        historical("2026 4º Trimestre", [0, 0, 0, 0, 0], 1593290.05, 0),
    ],
}

AUTH_STUB = r"""window.supabase = { createClient() {
  const listeners = [];
  const session = () => sessionStorage.getItem('fake-auth') ? {
    access_token: 'offline-test-token', refresh_token: 'offline-refresh-token',
    user: {id:'admin', email:'eduardo@example.test'}
  } : null;
  return {auth: {
    async getSession() {return {data:{session:session()},error:null};},
    async refreshSession() {return {data:{session:session()},error:null};},
    onAuthStateChange(callback) {
      listeners.push(callback);
      if (location.hash.includes('type=recovery')) setTimeout(()=>callback('PASSWORD_RECOVERY', session()),10);
      return {data:{subscription:{unsubscribe(){}}}};
    },
    async signInWithPassword({email,password}) {
      if(password==='wrong-password') return {data:{session:null},error:{message:'Invalid login credentials'}};
      sessionStorage.setItem('fake-auth','1'); return {data:{session:session()},error:null};
    },
    async signOut(){sessionStorage.removeItem('fake-auth');return {error:null};},
    async resetPasswordForEmail(email,opts){window.__recovery={email,opts};return {data:{},error:null};},
    async updateUser(value){window.__updatedPassword=value;return {data:{user:session()?.user},error:null};},
    async exchangeCodeForSession(){return {data:{session:session()},error:null};},
    async setSession(){sessionStorage.setItem('fake-auth','1');return {data:{session:session()},error:null};}
  }};
}};
"""


class StaticHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        if self.path.split("?")[0] == "/":
            self.path = "/public/index.html"
        super().do_GET()

    def log_message(self, *args):
        pass


class MockAPI:
    def __init__(self, role="admin", must_change_password=False):
        self.state = copy.deepcopy(FIXTURE)
        self.state["user"]["role"] = role
        self.writes = []
        self.reads = []
        self.must_change_password = must_change_password

    def route(self, route):
        request = route.request
        path = request.url.split("/api/")[-1].split("?")[0]
        if request.method == "GET":
            self.reads.append(path)
        if path == "config":
            return route.fulfill(json={"url": "https://offline.example.test", "anonKey": "offline-public-key"})
        if path == "bootstrap":
            if self.must_change_password:
                return route.fulfill(status=403, json={"error": "Altere sua senha inicial para continuar."})
            return route.fulfill(json=self.state)
        if path == "session":
            return route.fulfill(json={"user": {**self.state["user"], "mustChangePassword": self.must_change_password}})
        body = request.post_data_json if request.post_data else None
        self.writes.append((request.method, path, body))
        if path == "password-change":
            self.must_change_password = False
            return route.fulfill(json={"ok": True, "user": {**self.state["user"], "mustChangePassword": False}})
        if path == "banks" and request.method == "POST":
            item = {"id": "bank-new", "name": body["name"]}
            self.state["banks"].append(item)
            return route.fulfill(json=item)
        if path.startswith("banks/") and request.method == "DELETE":
            self.state["banks"] = [b for b in self.state["banks"] if b["id"] != path.split("/")[-1]]
            return route.fulfill(json={"ok": True})
        if path.startswith("partners/") and request.method == "PUT":
            item = next(p for p in self.state["partners"] if p["id"] == path.split("/")[-1])
            item.update(body)
            return route.fulfill(json=item)
        if path == "closings" and request.method == "POST":
            bank_map = {b["id"]: b["name"] for b in self.state["banks"]}
            item = {"id": "new-closing", "quarter": f'{body["year"]} {body["quarter"]}º Trimestre',
                    "current_cash": sum(b["value"] for b in body["balances"]),
                    "previous_distribution": body["previousDistribution"], "distribution_pct": body["distributionPct"],
                    "rows": {"schemaVersion": 2, "previous_cash": body["previousCash"],
                             "previous_distribution": body["previousDistribution"],
                             "balances": {bank_map[b["bankId"]]: b["value"] for b in body["balances"]},
                             "actual_distribution": body["actualDistribution"]}}
            self.state["closings"].append(item)
            return route.fulfill(json=item)
        if path.startswith("closings/") and request.method == "PATCH":
            item = next(c for c in self.state["closings"] if c["id"] == path.split("/")[-1])
            item["rows"]["actual_distribution"] = body["actualDistribution"]
            return route.fulfill(json=item)
        return route.fulfill(status=404, json={"error": "Missing offline route: " + path})


def install_mocks(context, mock, signed_in=True):
    if signed_in:
        context.add_init_script("sessionStorage.setItem('fake-auth','1')")
    context.route("**/api/**", mock.route)
    context.route("**/vendor/**", lambda route: route.fulfill(body=AUTH_STUB, content_type="text/javascript"))
    context.route("**cdn.jsdelivr.net/**", lambda route: route.fulfill(body=AUTH_STUB, content_type="text/javascript"))
    context.route("**/favicon.ico", lambda route: route.fulfill(status=204))


def no_overflow(page):
    if not page.evaluate("document.documentElement.scrollWidth <= innerWidth"):
        page.screenshot(path="/tmp/inepad-overflow-failure.png", full_page=True)
        print(page.evaluate("""({viewport:innerWidth,scrollWidth:document.documentElement.scrollWidth,elements:[...document.querySelectorAll('body *')].filter(e=>e.getBoundingClientRect().right>innerWidth+1 && e.getBoundingClientRect().width>0).map(e=>({tag:e.tagName,id:e.id,class:e.className,width:e.getBoundingClientRect().width,right:e.getBoundingClientRect().right})).slice(0,15)})"""))
        raise AssertionError("Body overflows the viewport")


def run():
    server = ThreadingHTTPServer(("127.0.0.1", 0), StaticHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_port}"
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get("CHROMIUM_PATH", "/usr/bin/chromium"), args=["--no-sandbox", "--disable-dev-shm-usage"])
        context = browser.new_context(viewport={"width": 1440, "height": 1000}, reduced_motion="reduce")
        mock = MockAPI()
        install_mocks(context, mock)
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)
        page.goto(base)
        expect(page.locator("#appShell")).to_be_visible()
        expect(page.locator("#settingsPage")).not_to_be_visible()
        expect(page.locator("#latestCash")).to_contain_text("1.593.290,05")
        expect(page.locator("#cashChart .chart-column")).to_have_count(8)
        no_overflow(page)
        page.screenshot(path="/tmp/inepad-dashboard-desktop.png", full_page=True)
        print("PASS: dashboard / latest meaningful period / desktop layout")
        page.locator("#historySearch").fill("sem resultado")
        expect(page.locator("#historyEmpty")).to_be_visible()
        page.locator("#historySearch").fill("")
        expect(page.locator("#historyEmpty")).not_to_be_visible()
        page.locator("#historyBody .history-toggle").first.focus()
        page.keyboard.press("Enter")
        expect(page.locator("#historyBody .history-toggle").first).to_have_attribute("aria-expanded", "true")
        expect(page.locator("#historyBody .detail-row").first).to_be_visible()
        page.keyboard.press("Enter")
        expect(page.locator("#historyBody .history-toggle").first).to_have_attribute("aria-expanded", "false")
        page.locator("#historyBody .history-toggle").nth(1).click()
        historical_detail = page.locator("#historyBody .detail-row:visible").first
        historical_distribution = historical_detail.locator(".distribution-detail")
        expect(historical_distribution).to_be_visible()
        expect(historical_distribution).to_contain_text("Distribuição efetiva usada no rateio")
        expect(historical_distribution).to_contain_text("388.803,53")
        expect(historical_distribution.locator("tbody tr").filter(has_text="Eduardo")).to_contain_text("233.282,12")
        expect(historical_distribution.locator("tbody tr").filter(has_text="Eduardo")).to_contain_text("1.050,00")
        expect(historical_distribution.locator("tbody tr").filter(has_text="Ana")).to_contain_text("155.521,41")
        page.screenshot(path="/tmp/inepad-history-expanded.png", full_page=True)
        print("PASS: filtering and keyboard-accessible historical bank breakdown")
        print("PASS: historical partner distribution uses actual payout and quarterly discounts")

        page.locator("#newClosingButton").click()
        expect(page.locator("#closingEditor")).to_be_visible()
        page.locator("#closingYear").select_option("2027")
        page.locator("#closingQuarter").select_option("1")
        values = page.locator("#bankFields input")
        for i in range(values.count()):
            values.nth(i).fill("0")
        expect(page.locator("#closingPreview")).to_contain_text("0,00")
        values.first.fill("1800000")
        page.locator("#previousCash").fill("1593290.05")
        page.locator("#previousDistribution").fill("388803.53")
        expect(page.locator("#closingPreview")).to_contain_text("595.513,48")
        page.locator("#actualDistribution").fill("500000")
        page.locator("#saveClosing").click()
        expect(page.locator("#closingEditor")).not_to_be_visible()
        closing_write = next(data for method, path, data in mock.writes if method == "POST" and path == "closings")
        assert sum(v["value"] for v in closing_write["balances"]) == 1800000
        assert closing_write["previousDistribution"] == 388803.53
        assert closing_write["actualDistribution"] == 500000
        print("PASS: zero account balances, automatic preview, snapshots and save flow")

        page.locator("#historyBody .history-toggle").first.click()
        saved_distribution = page.locator("#historyBody .detail-row:visible .distribution-detail").first
        expect(saved_distribution.locator("tbody tr").filter(has_text="Eduardo")).to_contain_text("300.000,00")
        expect(saved_distribution.locator("tbody tr").filter(has_text="Ana")).to_contain_text("200.000,00")
        payment_form = page.locator("#historyBody .history-payment:visible").first
        payment_form.locator("input").fill("510000")
        payment_form.locator('button[type="submit"]').click()
        expect(page.locator("#latestDistribution")).to_contain_text("510.000,00")
        assert next(c for c in mock.state["closings"] if c["id"] == "new-closing")["rows"]["balances"]["Itaú Consulting"] == 1800000
        page.locator("#historyBody .history-toggle").first.click()
        updated_distribution = page.locator("#historyBody .detail-row:visible .distribution-detail").first
        expect(updated_distribution.locator("tbody tr").filter(has_text="Eduardo")).to_contain_text("306.000,00")
        expect(updated_distribution.locator("tbody tr").filter(has_text="Ana")).to_contain_text("204.000,00")
        print("PASS: payment update preserves the original closing balances")
        print("PASS: new closing and changed payment recompute rateio from actual rather than estimated distribution")

        with page.expect_download() as download_info:
            page.locator("#historyExport").click()
        download = download_info.value
        assert download.suggested_filename.endswith(".csv")
        downloaded = Path("/tmp/inepad-history-test.csv")
        download.save_as(downloaded)
        assert "Itaú Consulting" in downloaded.read_text(encoding="utf-8-sig")
        page.evaluate("() => {window.__printCalls=0; window.print=()=>{window.__printCalls++};}")
        page.locator("#printReportButton").click()
        assert page.evaluate("window.__printCalls") == 1
        print("PASS: CSV export includes bank detail and print action opens report")

        page.locator('[data-page="settings"]').click()
        expect(page.locator("#settingsPage")).to_be_visible()
        page.evaluate("window.__xss = 0")
        malicious_name = 'Conta <img src=x onerror="window.__xss=1">'
        page.locator("#bankName").fill(malicious_name)
        page.locator("#bankForm button[type=submit]").click()
        expect(page.locator("#banksList")).to_contain_text(malicious_name)
        assert page.evaluate("window.__xss") == 0
        assert page.locator("#banksList img").count() == 0
        print("PASS: account names rendered as text (stored HTML escaping)")

        # Settings actions are intentionally selected through accessible labels.
        delete_button = page.locator("#banksList .bank-item").filter(has_text=malicious_name).get_by_role("button")
        delete_button.click()
        expect(page.locator("#confirmDialog")).to_be_visible()
        page.locator("#confirmCancel").click()
        assert not any(method == "DELETE" for method, _, _ in mock.writes)
        delete_button.click()
        page.locator("#confirmAccept").click()
        expect(page.locator("#banksList")).not_to_contain_text(malicious_name)
        assert any(method == "DELETE" for method, _, _ in mock.writes)
        page.locator('[data-setting="partners"]').click()
        page.locator("#partnersList button").first.click()
        expect(page.locator("#partnerName")).to_have_value("Eduardo")
        if page.locator("#partnerEmail").count():
            page.locator("#partnerEmail").fill("eduardo@example.test")
        page.locator("#partnerMinimum").fill("7500")
        page.locator("#partnerForm button[type=submit]").click()
        expect(page.locator("#partnersList")).to_contain_text("7.500,00")
        print("PASS: bank deletion cancel/confirm and partner parameter editing")

        page.locator('[data-page="overview"]').click()
        page.set_viewport_size({"width": 390, "height": 844})
        expect(page.locator("#cashChart .chart-column")).to_have_count(4)
        page.wait_for_function("!document.getElementById('toast').classList.contains('is-visible')", timeout=6000)
        no_overflow(page)
        page.screenshot(path="/tmp/inepad-dashboard-mobile.png", full_page=True)
        page.locator("#newClosingButton").click()
        for index, amount in enumerate([800000, 300000, 135000, 320000, 100000]):
            page.locator("#bankFields input").nth(index).fill(str(amount))
        no_overflow(page)
        page.screenshot(path="/tmp/inepad-closing-mobile.png", full_page=True)
        print("PASS: mobile dashboard and closing editor fit 390px viewport")
        assert not errors, errors
        context.close()

        readonly = browser.new_context(viewport={"width": 1440, "height": 1000}, reduced_motion="reduce")
        install_mocks(readonly, MockAPI(role="partner"))
        reader_page = readonly.new_page()
        reader_page.on("pageerror", lambda error: errors.append(str(error)))
        reader_page.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)
        reader_page.goto(base)
        expect(reader_page.locator("#appShell")).to_be_visible()
        expect(reader_page.locator("#newClosingButton")).not_to_be_visible()
        expect(reader_page.locator('[data-page="settings"]')).not_to_be_visible()
        assert reader_page.locator("#historyBody .history-toggle").count() > 0
        readonly.close()
        print("PASS: common users can inspect reports and cannot open administration")

        # The minimum is an extra funded by the company, never a reduction of
        # the other partner's share. This pool deliberately differs from the
        # estimated cash-generated distribution in the quarter's source data.
        minimum_context = browser.new_context(viewport={"width": 1440, "height": 1000}, reduced_motion="reduce")
        minimum_mock = MockAPI()
        minimum_mock.state["partners"] = [
            {"id": "partner-eduardo", "name": "Eduardo", "email": "eduardo@example.test", "share": 10, "minimum": 20000, "discount": 100},
            {"id": "partner-ana", "name": "Ana", "email": "ana@example.test", "share": 90, "minimum": 0, "discount": 0},
        ]
        minimum_quarter = next(c for c in minimum_mock.state["closings"] if c["quarter"] == "2026 3º Trimestre")
        minimum_quarter["rows"]["actual_distribution"] = 10000
        minimum_quarter["rows"]["partner_rows"] = [{"id": "partner-eduardo", "name": "Stale estimated rateio", "share": 100, "bruto": 999999, "complement": 0, "desconto": 0, "total": 999999}]
        install_mocks(minimum_context, minimum_mock)
        minimum_page = minimum_context.new_page()
        minimum_page.on("pageerror", lambda error: errors.append(str(error)))
        minimum_page.on("console", lambda entry: errors.append(entry.text) if entry.type == "error" else None)
        minimum_page.goto(base)
        expect(minimum_page.locator("#appShell")).to_be_visible()
        minimum_page.locator("#historyBody .history-toggle").nth(1).click()
        minimum_distribution = minimum_page.locator("#historyBody .detail-row:visible .distribution-detail").first
        expect(minimum_distribution).to_contain_text("Distribuição efetiva usada no rateio")
        expect(minimum_distribution).to_contain_text("10.000,00")
        expect(minimum_distribution).to_contain_text("Complemento extra do INEPAD")
        expect(minimum_distribution).to_contain_text("59.000,00")
        expect(minimum_distribution).to_contain_text("Total líquido aos sócios")
        expect(minimum_distribution).to_contain_text("68.700,00")
        eduardo_row = minimum_distribution.locator("tbody tr").filter(has_text="Eduardo")
        ana_row = minimum_distribution.locator("tbody tr").filter(has_text="Ana")
        expect(eduardo_row).to_contain_text("1.000,00")
        expect(eduardo_row).to_contain_text("59.000,00")
        expect(eduardo_row).to_contain_text("300,00")
        expect(eduardo_row).to_contain_text("59.700,00")
        expect(ana_row).to_contain_text("9.000,00")
        expect(minimum_distribution).not_to_contain_text("Stale estimated rateio")
        minimum_page.screenshot(path="/tmp/inepad-minimum-extra-distribution.png", full_page=True)
        minimum_page.set_viewport_size({"width": 390, "height": 844})
        no_overflow(minimum_page)
        minimum_context.close()
        print("PASS: minimum top-up is company extra, quarterly discount applies, and other partner's share stays intact")

        login = browser.new_context(viewport={"width": 1440, "height": 1000}, reduced_motion="reduce")
        install_mocks(login, MockAPI(), signed_in=False)
        login_page = login.new_page()
        login_page.on("pageerror", lambda error: errors.append(str(error)))
        login_page.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)
        login_page.goto(base)
        expect(login_page.locator("#authScreen")).to_be_visible()
        login_page.screenshot(path="/tmp/inepad-login-desktop.png", full_page=True)
        login_page.locator("#showRecovery").click()
        expect(login_page.locator("#passwordField")).not_to_be_visible()
        login_page.locator("#email").fill("eduardo@example.test")
        login_page.locator("#authSubmit").click()
        expect(login_page.locator("#authMessage")).to_be_visible()
        assert login_page.evaluate("window.__recovery.email") == "eduardo@example.test"
        login_page.locator("#showLogin").click()
        login_page.locator("#password").fill("wrong-password")
        login_page.locator("#authSubmit").click()
        expect(login_page.locator("#authMessage")).to_be_visible()
        expect(login_page.locator("#appShell")).not_to_be_visible()
        login_page.locator("#password").fill("offline-strong-password")
        login_page.locator("#authSubmit").click()
        expect(login_page.locator("#appShell")).to_be_visible()
        login_page.locator("#logoutButton").click()
        expect(login_page.locator("#authScreen")).to_be_visible()
        login_page.set_viewport_size({"width": 390, "height": 844})
        no_overflow(login_page)
        login_page.screenshot(path="/tmp/inepad-login-mobile.png", full_page=True)
        login.close()
        print("PASS: login/recovery/logout and mobile auth layout")

        reset = browser.new_context(viewport={"width": 1440, "height": 1000}, reduced_motion="reduce")
        reset_mock = MockAPI()
        install_mocks(reset, reset_mock, signed_in=True)
        reset_page = reset.new_page()
        reset_page.on("pageerror", lambda error: errors.append(str(error)))
        reset_page.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)
        reset_page.goto(base + "/#type=recovery&access_token=offline-test-token&refresh_token=offline-refresh-token")
        expect(reset_page.locator("#passwordConfirmField")).to_be_visible()
        reset_page.locator("#password").fill("new-offline-strong-password")
        reset_page.locator("#passwordConfirm").fill("new-offline-strong-password")
        reset_page.locator("#authSubmit").click()
        expect(reset_page.locator("#appShell")).to_be_visible()
        assert any(method == "POST" and path == "password-change" and body["password"] == "new-offline-strong-password" for method, path, body in reset_mock.writes)
        reset.close()
        print("PASS: recovery link opens actual new-password confirmation flow")

        first_access = browser.new_context(viewport={"width": 1440, "height": 1000}, reduced_motion="reduce")
        first_access_mock = MockAPI(role="partner", must_change_password=True)
        install_mocks(first_access, first_access_mock, signed_in=True)
        first_access_page = first_access.new_page()
        first_access_page.on("pageerror", lambda error: errors.append(str(error)))
        first_access_page.on("console", lambda entry: errors.append(entry.text) if entry.type == "error" else None)
        first_access_page.goto(base)
        expect(first_access_page.locator("#passwordConfirmField")).to_be_visible()
        expect(first_access_page.locator("#authScreen")).to_be_visible()
        expect(first_access_page.locator("#appShell")).not_to_be_visible()
        assert "bootstrap" not in first_access_mock.reads
        first_access_page.locator("#password").fill("inepad123")
        first_access_page.locator("#passwordConfirm").fill("inepad123")
        first_access_page.locator("#authSubmit").click()
        expect(first_access_page.locator("#authMessage")).to_be_visible()
        assert not any(path == "password-change" for _, path, _ in first_access_mock.writes)
        assert "bootstrap" not in first_access_mock.reads
        first_access_page.locator("#password").fill("new-private-first-access-password")
        first_access_page.locator("#passwordConfirm").fill("new-private-first-access-password")
        first_access_page.locator("#authSubmit").click()
        expect(first_access_page.locator("#appShell")).to_be_visible()
        expect(first_access_page.locator("#newClosingButton")).not_to_be_visible()
        expect(first_access_page.locator('[data-page="settings"]')).not_to_be_visible()
        assert any(method == "POST" and path == "password-change" and body["password"] == "new-private-first-access-password" for method, path, body in first_access_mock.writes)
        assert "bootstrap" in first_access_mock.reads
        first_access.close()
        print("PASS: first access blocks reports until default password is replaced with a private password")
        assert not errors, errors
        print("PASS: no JavaScript page errors or browser console errors")
        browser.close()
    server.shutdown()


if __name__ == "__main__":
    run()
