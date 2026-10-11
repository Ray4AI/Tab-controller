# Media Controller (Volume Booster & Video Speed Controller)

A browser extension that gives you control over the audio and video already playing in your
browser: boost volume up to **500 %**, change playback speed from **0.10x to 16x**, all per tab —
and now **only on the sites you allow**.

This repository is a fork of
[Zafkiel-dal/Tab-controller](https://github.com/Zafkiel-dal/Tab-controller) with the v2.0
behaviour fixes and the whitelist feature described below. It is built for
**self-hosted (unlisted) Firefox distribution**: you submit the `.xpi` to
addons.mozilla.org for signing, then hand the signed file to your users.

---

## What's new in v2.0

| | Before | Now (v2.0) |
| :--- | :--- | :--- |
| **Bilibili hover previews** | Hovering a recommendation started an inline preview player; that extra `<video>` hijacked the shared audio graph and the tab volume snapped back to 100 %. | Only the **primary video** (the biggest visible one) is ever controlled. Previews, trailers, ads, background videos and secondary players are completely untouched. |
| **Ads / preview clips** | Boosted and sped up like any other video. | Never touched. They have no overlay and no audio routing. |
| **Web Audio** | Every `<video>`/`<audio>` on the page was permanently routed through a gain node. | Web Audio is hooked **lazily**, only for the primary element, and only when a boost above 100 % is actually requested. At 100 % the extension is completely passive. |
| **The floating badge** | Clamped inside the player rectangle — it always covered part of the video. | Can be **dragged anywhere on the screen**, including outside the player. The position is remembered per site; double-click the badge (or use the popup) to snap it back. |
| **Where it runs** | Every website, all the time. | **Whitelist scope**: only the sites you list. Manage it from the popup (add/remove sites, or switch to "All sites"). |
| **Badge visibility** | Always on. | Can be switched off entirely from the popup while keeping the keyboard/popup controls. |

---

## Installing the self-hosted build

1. Build (or download) `dist/media-controller-2.0.xpi`.
2. Submit that file at <https://addons.mozilla.org/developers/addon/submit/distribution> and
   choose **"On your own"** (self-distribution). Mozilla signs it and gives you a signed `.xpi`.
3. Publish the signed file (GitHub Releases works well) and set that URL in
   [`updates.json`](updates.json) → `update_link`.
4. Users install it by opening the `.xpi` in Firefox. Because `manifest.json` declares
   `browser_specific_settings.gecko.update_url`, Firefox checks `updates.json` and
   auto-updates from it.

The add-on id is `tab-controller@ray4ai.github.io`; keep it stable so updates keep working.

---

## Detailed User Manual

### 1. Activation scope (whitelist)

The extension now runs **only on whitelisted sites** by default. Open the toolbar popup:

* **Whitelist only** — the extension starts on the listed domains only (default list:
  Bilibili, YouTube, Netflix, Twitch, Vimeo, Dailymotion, Niconico, iQiyi, Tencent Video,
  Youku, Zhihu, Coursera, Udemy, SoundCloud, Spotify).
* **All sites** — old behaviour, the extension runs everywhere.
* **Allow / Remove** — add or remove the site you are currently on.
* The text box below adds any domain manually (`example.com` also covers `www.example.com`
  and every sub-domain).
* Changing the scope takes effect immediately, in already-open tabs.

When a site is not allowed the content script does nothing at all: no badge, no audio routing,
no playback-rate changes.

### 2. The video overlay (quick controls)

A small badge is attached to the **primary video** — the largest visible video of the page.
Hover previews, ads and background clips never get one.

* **Speed (e.g. `1.00x`)** — hover the chip for `−`, `1×`, `+`, or scroll the wheel.
* **Volume (e.g. `100%`)** — hover for a slider, or scroll the wheel. Goes up to 500 %.
* **Reset** — speed back to 1.0x **and** volume back to 100 %.
* **Save (bookmark)** — `T` lock to tab, `D` lock to domain, `G` lock globally, `✕` clear.
* **Eye** — badge opacity, remembered for every site.
* **Drag handle (⣿)** — drag it anywhere: on the player, in the empty space beside it, or on
  another part of the page. **Double-click** the badge to snap it back onto the player.
  The position is saved per site.

### 3. The full dashboard (popup)

Volume + speed sliders, activation scope, badge visibility, theme switch and the preset
manager.

### 4. Preset memory

Speeds/volumes are temporary unless saved:

1. **[T] Tab** — this tab only (.e.g a tab you keep open for a long video).
2. **[D] Domain** — every page of that site.
3. **[G] Global** — every site.
4. **[✕] / "Reset to Default"** — clears the highest-priority layer, falling back to the next
   one (Tab → Domain → Global → default).

Without any preset ("default mode") the extension resets the primary video to 1.0x / 100 %
when a **new clip** starts loading in the *same* player element. Preview clips and other
secondary media never trigger that reset.

### 5. YouTube synchronisation

If you change the speed with YouTube's own gear icon or shortcuts, the extension adopts the new
value instead of fighting it (primary video only).

---

## Development

```bash
npm install            # puppeteer for the e2e suite
npm test               # end-to-end tests (downloads Chromium)
npm run build:manifests  # dist/chrome + dist/firefox manifests
npm run build:xpi        # dist/media-controller-<version>.xpi (Firefox, self-hosted)
```

### Layout

```
manifest.json              MV3 manifest (Chrome service worker + Firefox scripts)
src/content/content.js     content script: primary-media detection, audio graph, overlay
src/background/background.js  preset storage, defaults, message routing
src/popup/                 dashboard UI (controls + activation scope)
scripts/build-manifests.js browser-specific manifest generation
scripts/build-xpi.sh       zip → signed-ready .xpi
tests/                     puppeteer e2e suite + fixtures
updates.json               Firefox self-hosted update manifest
```

### How the primary video is chosen

`score = area` (only for videos at least 120×90 that are actually on screen), `× 0.05` when the
video is muted, `× 0.9` when it is paused. Audio-only players get a fixed mid score. The
previous primary keeps the badge unless a challenger is more than 1.6× bigger, which stops the
badge from flickering between two equally sized players.

---

## License

ISC — see [LICENSE](LICENSE). Original work © the upstream authors.
