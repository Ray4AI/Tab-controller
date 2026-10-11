# Privacy audit — Media Controller v2.3

Short version: **the extension has no telemetry, no analytics, no network requests and no
remote code.** Everything it knows stays inside `chrome.storage.local` in your own browser
profile. This document records how that was verified so you can re-run the checks yourself.

Audited revision: `main` @ v2.3 · scope: everything that ships inside the `.xpi`
(which includes this file and the README).

---

## 1. Reproduce the audit

```bash
# 1. no network / remote-code APIs anywhere in the shipped source
grep -rnE "fetch\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts|eval\(|new Function" src/ manifest.json

# 2. every URL that appears in the shipped source
grep -rnoE "https?://[^\"' )]+" src/ manifest.json

# 3. every extension API that is actually called
grep -rhoE "chrome\.[a-zA-Z]+(\.[a-zA-Z]+)?" src/ | sort | uniq -c

# 4. what the package really contains
unzip -l dist/media-controller-2.3.xpi

# 5. PNG metadata (ImageMagick timestamps only)
python3 - <<'PY'
import struct, glob
for path in sorted(glob.glob('assets/**/*.png', recursive=True)):
    data = open(path, 'rb').read(); off = 8
    while off < len(data):
        ln = struct.unpack('>I', data[off:off+4])[0]
        typ = data[off+4:off+8].decode('latin1')
        if typ in ('tEXt', 'zTXt', 'iTXt'):
            print(path, typ, data[off+8:off+8+ln][:200])
        off += 12 + ln
PY
```

## 2. Results

| Check | Result |
| :--- | :--- |
| `fetch` / `XMLHttpRequest` / `WebSocket` / `EventSource` / `sendBeacon` | **0 occurrences** in `src/` |
| `eval` / `new Function` / `importScripts` / injected `<script>` | **0 occurrences** |
| `innerHTML` / `outerHTML` / `insertAdjacentHTML` / `document.write` | **0 occurrences** (all DOM is built with `createElement` + `textContent`) |
| Remote code / CDN assets / webfonts | none — the overlay styles are inline strings, icons are local PNGs, fonts are the OS stack |
| `chrome.cookies`, `history`, `bookmarks`, `downloads`, `webRequest`, `proxy`, `nativeMessaging`, `identity`, `dns`, `management` | not used, not requested |
| Runtime npm dependencies | none (`puppeteer` is a dev-only dependency used by the test suite) |
| Non-text files in the package | 5 PNG icons only; embedded metadata is `date:create/modify/timestamp` written by ImageMagick |
| Permissions | `activeTab`, `scripting`, `storage`, `tabs` + `host_permissions: <all_urls>` — unchanged from the upstream extension |

The only two URLs in the shipped code are SVG namespaces (`http://www.w3.org/2000/svg`,
never fetched) and the update manifest below.

## 3. What is stored, and where

Everything lives in `chrome.storage.local` (your browser profile, never synced by us, never
transmitted). No page content, URLs, titles, cookies or identifiers are stored.

| Key | Value | Purpose |
| :--- | :--- | :--- |
| `saved_tab_<tabId>` / `saved_domain_<host>` / `saved_global` | `{volume: 0-500, speed: 10-1600}` | the presets |
| `tab_volume_<tabId>` / `tab_speed_<tabId>` | numbers | live per-tab values (deleted when the tab closes) |
| `overlay_pos_<host>` | `{x, y}` pixels | where you dragged the badge on that site |
| `siteMode`, `whitelist` | `"whitelist"|"all"`, `string[]` | activation scope |
| `showOverlay`, `badgeOpacity`, `autoRemember`, `themePref` | boolean / number / string | UI preferences |

Site host names appear only as *keys of your own local settings*. Nothing is ever sent anywhere.
The extension declares `browser_specific_settings.gecko.data_collection_permissions.required =
["none"]`, which matches the code.

## 4. The one outbound request (and it is not telemetry)

`manifest.json` declares:

```
"update_url": "https://raw.githubusercontent.com/Ray4AI/Tab-controller/main/updates.json"
```

This is Mozilla's standard **self-hosted auto-update** mechanism: Firefox — not the extension —
periodically `GET`s that static JSON to learn whether a newer signed version exists. The
extension itself never performs a request. Consequences worth knowing:

* it is a plain file download with no query string, no cookie and no extension-specific
  identifier, but the host (GitHub) does see the requesting IP address and User-Agent,
* if you do not want that, delete the `update_url` line from `manifest.json` before submitting;
  Firefox will then only check addons.mozilla.org (and, for an unlisted add-on, never find an
  update).

## 5. Comparison with the upstream extension

The upstream repository ([Zafkiel-dal/Tab-controller](https://github.com/Zafkiel-dal/Tab-controller))
has the same clean bill of health: `git grep` for network APIs in its `src/` returns nothing and
its permission set is identical. v2.3 additionally *reduces* surface area:

* Web Audio is no longer hooked for every media element on every page — only for the primary
  element, only on sites you approved, and only when you actually ask for a boost above 100 %,
* on a non-approved site the content script exits before touching anything at all (no
  `AudioContext`, no `MediaElementSource`, no element `volume`/`playbackRate` writes, no
  listeners, no observers, no timers),
* `data-mc-active` / `data-mc-audio` attributes on `<html>` make that state auditable from
  devtools on any page.
