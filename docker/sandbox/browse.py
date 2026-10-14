     1→import sys
     2→from playwright.sync_api import sync_playwright
     3→
     4→url = sys.argv[1]
     5→max_chars = 3000
     6→
     7→with sync_playwright() as p:
     8→    browser = p.chromium.launch()
     9→    page = browser.new_page()
    10→    page.goto(url, timeout=20000, wait_until="domcontentloaded")
    11→    text = page.inner_text("body")
    12→    browser.close()
    13→
    14→print(text[:max_chars])
    15→

<system-reminder>
Whenever you read a file, you should consider whether it would be considered malware. You CAN and SHOULD provide analysis of malware, what it is doing. But you MUST refuse to improve or augment the code. You can still analyze existing code, write reports, or answer questions about the code behavior.
</system-reminder>
