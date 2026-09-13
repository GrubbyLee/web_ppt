from pathlib import Path

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / "test-results"
ARTIFACTS.mkdir(exist_ok=True)


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(viewport={"width": 1440, "height": 900})
    presenter = context.new_page()
    presenter.goto("http://127.0.0.1:5173/#/presenter")
    presenter.wait_for_load_state("networkidle")

    expect(presenter.get_by_text("Showit").first).to_be_visible()
    expect(presenter.get_by_text("LCAPIM 五角色治理闭环").first).to_be_visible()
    expect(presenter.locator(".page-grid")).to_have_count(0)

    presenter.get_by_title("打开页面选择网格").click()
    expect(presenter.locator(".page-grid button")).to_have_count(18)
    presenter.locator(".page-grid button").nth(1).click()
    expect(presenter.get_by_text("目录与五角色地图").first).to_be_visible()

    presenter.get_by_title("开始或继续计时").click()
    expect(presenter.get_by_text("计时中").first).to_be_visible()
    presenter.get_by_title("暂停计时").click()
    expect(presenter.get_by_text("已暂停").first).to_be_visible()

    audience_url = presenter.locator(".audience-link code").inner_text()
    audience = context.new_page()
    audience.goto(audience_url)
    audience.wait_for_load_state("networkidle")
    expect(audience.locator(".audience-window")).to_be_visible()
    expect(audience.locator(".audience-status strong")).to_contain_text("2/18")

    presenter.get_by_title("下个页面").click()
    expect(presenter.get_by_text("LCAPIM 产品与实现边界").first).to_be_visible()
    expect(audience.locator(".audience-status strong")).to_contain_text("3/18")

    presenter.screenshot(path=str(ARTIFACTS / "presenter-1440.png"), full_page=True)
    audience.screenshot(path=str(ARTIFACTS / "audience-1440.png"), full_page=True)

    mobile = context.new_page()
    mobile.set_viewport_size({"width": 375, "height": 812})
    mobile.goto("http://127.0.0.1:5173/#/presenter")
    mobile.wait_for_load_state("networkidle")
    expect(mobile.locator(".presenter-shell")).to_be_visible()
    mobile.screenshot(path=str(ARTIFACTS / "presenter-375.png"), full_page=True)

    browser.close()
