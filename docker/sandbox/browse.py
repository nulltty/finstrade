import sys
from playwright.sync_api import sync_playwright

url = sys.argv[1]
mode = sys.argv[2] if len(sys.argv) > 2 else "text"
max_chars = 3000

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page()
    page.goto(url, timeout=20000, wait_until="domcontentloaded")
    if mode == "screenshot":
        page.screenshot(path="/sandbox/screenshot.png", full_page=True)
        print("OK")
    else:
        text = page.inner_text("body")
        print(text[:max_chars])
    browser.close()
