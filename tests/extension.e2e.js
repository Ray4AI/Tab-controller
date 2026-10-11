/**
 * End-to-end suite for the v2.0 content script.
 *
 * Focus areas:
 *   1. Only the *primary* media element gets an overlay and gets controlled.
 *   2. Hover-preview / ad style media can never reset the tab volume
 *      (regression test for the Bilibili bug).
 *   3. The badge can be dragged outside the video and the position sticks.
 *   4. Activation scope (whitelist) gates the whole extension.
 *
 * Run with `npm test`. Requires a Chromium download (puppeteer).
 */
const puppeteer = require('puppeteer');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PAGES = {
    '/': 'multi-video-fixture.html',
    '/page2': 'navigation-fixture.html'
};

const PORT = 18000 + Math.floor(Math.random() * 2000);
const ORIGIN = `http://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const server = http.createServer((req, res) => {
    const file = PAGES[req.url.split('?')[0]] || 'multi-video-fixture.html';
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(fs.readFileSync(path.join(__dirname, file)));
});

// Chrome derives the id of an unpacked extension from its absolute path.
function unpackedExtensionId(absPath) {
    const hash = crypto.createHash('sha256').update(absPath, 'utf8').digest('hex').slice(0, 32);
    return hash.split('').map(c => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

let failures = 0;
function check(condition, label) {
    if (condition) {
        console.log(`✅ PASS: ${label}`);
    } else {
        failures++;
        console.error(`❌ FAIL: ${label}`);
    }
}

server.listen(PORT, async () => {
    const extensionPath = path.join(__dirname, '..');
    console.log(`Test server: ${ORIGIN}`);

    const browser = await puppeteer.launch({
        headless: true,
        args: [
            `--disable-extensions-except=${extensionPath}`,
            `--load-extension=${extensionPath}`,
            '--window-size=1200,900',
            '--autoplay-policy=no-user-gesture-required',
            '--no-sandbox'
        ],
        defaultViewport: { width: 1200, height: 900 },
        protocolTimeout: 30000
    });

    try {
        const extensionId = await (async () => {
            try {
                const target = await browser.waitForTarget(
                    t => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'),
                    { timeout: 10000 }
                );
                return new URL(target.url()).host;
            } catch (e) {
                return unpackedExtensionId(extensionPath);
            }
        })();
        console.log(`Extension id: ${extensionId}`);

        // Extension page used to talk to chrome.* APIs and drive chrome.storage.
        const admin = await browser.newPage();
        const adminErrors = [];
        admin.on('pageerror', (e) => adminErrors.push(String(e)));
        admin.on('console', (m) => { if (m.type() === 'error') adminErrors.push(m.text()); });
        await admin.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
        await sleep(300);

        async function setStorage(values) {
            await admin.evaluate((v) => chrome.storage.local.set(v), values);
            await sleep(250);
        }

        async function sendToTabs(urlSubstring, message) {
            return admin.evaluate(async (sub, msg) => {
                const tabs = await chrome.tabs.query({});
                const target = tabs.find(t => (t.url || '').includes(sub));
                if (!target) return { error: 'tab not found' };
                try {
                    return await chrome.tabs.sendMessage(target.id, msg);
                } catch (e) {
                    return { error: String(e) };
                }
            }, urlSubstring, message);
        }

        // Activation scope must allow the fixture origin before the page loads.
        await setStorage({ siteMode: 'all', whitelist: ['127.0.0.1'], showOverlay: true });

        const page = await browser.newPage();
        await page.goto(ORIGIN + '/');
        await page.waitForSelector('#video1');
        await sleep(1500);

        // ── helpers running in the page ──────────────────────────────────
        async function badgeInfo(p = page) {
            return p.evaluate(() => {
                const hosts = Array.from(document.querySelectorAll('.__mc-overlay-host'));
                const info = hosts.map(h => {
                    const shadow = h.shadowRoot;
                    const badge = shadow && shadow.querySelector('.mc-badge');
                    const rect = badge ? badge.getBoundingClientRect() : null;
                    return {
                        hostRect: h.getBoundingClientRect().toJSON(),
                        display: getComputedStyle(h).display,
                        volume: shadow && shadow.querySelector('.mc-vol-val') ? shadow.querySelector('.mc-vol-val').textContent : null,
                        speed: shadow && shadow.querySelector('.mc-speed-val') ? shadow.querySelector('.mc-speed-val').textContent : null,
                        badgeRect: rect ? rect.toJSON() : null
                    };
                });
                return { count: hosts.length, hosts: info };
            });
        }

        const pageFlags = (p = page) => p.evaluate(() => ({
            active: document.documentElement.getAttribute('data-mc-active'),
            audio: document.documentElement.getAttribute('data-mc-audio'),
            volume: document.querySelector('video') ? document.querySelector('video').volume : null,
            rate: document.querySelector('video') ? document.querySelector('video').playbackRate : null
        }));

        const videoMetrics = (p = page) => p.evaluate(() => {
            const out = {};
            document.querySelectorAll('video').forEach(v => {
                out[v.id] = {
                    rate: v.playbackRate,
                    volume: v.volume,
                    muted: v.muted,
                    rect: v.getBoundingClientRect().toJSON()
                };
            });
            const shadowVideo = document.querySelector('#shadowHost').shadowRoot.querySelector('#shadowVideo');
            if (shadowVideo) {
                out.shadowVideo = { rate: shadowVideo.playbackRate, volume: shadowVideo.volume };
            }
            return out;
        });

        // ── TEST 1: only the primary video is decorated ──────────────────
        console.log('\n--- TEST 1: single overlay, bound to the primary video ---');
        let info = await badgeInfo();
        check(info.count === 1, `exactly one overlay host exists (got ${info.count})`);

        const metrics = await videoMetrics();
        const mainRect = metrics.video1.rect;
        const hostRect = info.hosts[0] ? info.hosts[0].hostRect : null;
        check(!!hostRect && Math.abs(hostRect.left - mainRect.left) < 4 && Math.abs(hostRect.width - mainRect.width) < 4,
            'overlay tracks the primary (largest) video');
        check(info.hosts[0] && info.hosts[0].display !== 'none', 'overlay is visible');

        // ── TEST 2: preview media cannot hijack the tab volume ───────────
        console.log('\n--- TEST 2: hover-preview immunity (Bilibili regression) ---');
        await sendToTabs('127.0.0.1', { action: 'setVolume', value: 3.57 });
        await sleep(400);
        info = await badgeInfo();
        check(info.hosts[0] && info.hosts[0].volume === '357%', `volume applied to primary (${info.hosts[0] && info.hosts[0].volume})`);

        // Simulate Bilibili: the recommendation preview starts loading/playing.
        await page.evaluate(() => window.__fixture.playPreview());
        await sleep(300);
        await page.evaluate(() => window.__fixture.reloadPreview());
        await sleep(1200);

        info = await badgeInfo();
        check(info.hosts[0] && info.hosts[0].volume === '357%',
            `volume survives a preview loadstart (${info.hosts[0] && info.hosts[0].volume})`);

        const afterPreview = await videoMetrics();
        check(Math.abs(afterPreview.preview.rate - 1) < 0.001,
            `preview playbackRate untouched (${afterPreview.preview.rate})`);
        check(Math.abs(afterPreview.preview.volume - 1) < 0.001 || afterPreview.preview.muted,
            'preview element volume untouched / still muted');

        // ── TEST 3: speed only reaches the primary ───────────────────────
        console.log('\n--- TEST 3: speed applies to the primary only ---');
        await sendToTabs('127.0.0.1', { action: 'setSpeed', value: 2.0 });
        await sleep(600);
        const speedMetrics = await videoMetrics();
        check(Math.abs(speedMetrics.video1.rate - 2.0) < 0.01, `primary playbackRate is 2.0 (${speedMetrics.video1.rate})`);
        check(Math.abs(speedMetrics.preview.rate - 1) < 0.001, `preview playbackRate still 1.0 (${speedMetrics.preview.rate})`);
        check(Math.abs(speedMetrics.video2.rate - 1) < 0.001, `secondary video playbackRate still 1.0 (${speedMetrics.video2.rate})`);

        // ── TEST 4: the badge can live outside the player ────────────────
        console.log('\n--- TEST 4: badge can be dragged outside the player ---');
        const geom = await page.evaluate(() => {
            const badge = document.querySelector('.__mc-overlay-host').shadowRoot.querySelector('.mc-badge');
            const video = document.querySelector('#video1');
            return {
                badge: badge.getBoundingClientRect().toJSON(),
                video: video.getBoundingClientRect().toJSON()
            };
        });
        const startX = geom.badge.left + geom.badge.width / 2;
        const startY = geom.badge.top + geom.badge.height / 2;
        const targetX = Math.round(Math.min(geom.video.left + 40, 1100));
        const targetY = Math.round(Math.min(geom.video.bottom + 80, 860));

        await page.mouse.move(startX, startY);
        await page.mouse.down();
        await page.mouse.move(targetX, targetY, { steps: 12 });
        await page.mouse.up();
        await sleep(300);

        const moved = await badgeInfo();
        const movedRect = moved.hosts[0].badgeRect;
        const videoRect = (await videoMetrics()).video1.rect;
        check(movedRect.top >= videoRect.bottom - 2 || movedRect.left >= videoRect.right - 2,
            `badge moved outside the player (badge top ${Math.round(movedRect.top)} vs video bottom ${Math.round(videoRect.bottom)})`);
        check(movedRect.left >= 0 && movedRect.top >= 0 &&
            movedRect.right <= 1200 && movedRect.bottom <= 900,
            'badge stayed inside the viewport');

        await page.reload();
        await page.waitForSelector('#video1');
        await sleep(1500);
        const persisted = await badgeInfo();
        check(persisted.hosts[0] && Math.abs(persisted.hosts[0].badgeRect.left - movedRect.left) < 12 &&
            Math.abs(persisted.hosts[0].badgeRect.top - movedRect.top) < 12,
            'badge position is remembered for the site');

        // ── TEST 5: whitelist gating ─────────────────────────────────────
        console.log('\n--- TEST 5: whitelist gating (an unapproved page stays untouched) ---');
        await setStorage({ siteMode: 'whitelist', whitelist: ['example.com'] });
        await sleep(500);

        // Fresh page, never activated before → nothing may have happened at all.
        const gated = await browser.newPage();
        await gated.goto(ORIGIN + '/page2');
        await gated.waitForSelector('video');
        await sleep(2000);

        let gatedInfo = await badgeInfo(gated);
        check(gatedInfo.count === 0, `no overlay on a non-whitelisted site (got ${gatedInfo.count})`);

        // The guarantee behind the question: no AudioContext, no MediaElementSource,
        // no playback-rate/volume writes, no listeners, no observers.
        let flags = await pageFlags(gated);
        check(flags.active === null, `no data-mc-active marker (${flags.active})`);
        check(flags.audio === null, `Web Audio was never hooked (${flags.audio})`);
        check(Math.abs(flags.volume - 1) < 0.001 && Math.abs(flags.rate - 1) < 0.001,
            `media element values untouched (volume ${flags.volume}, rate ${flags.rate})`);

        const blocked = await sendToTabs('/page2', { action: 'setVolume', value: 4.0 });
        check(blocked && blocked.inactive === true, 'content script reports the site as inactive');
        await sleep(400);
        flags = await pageFlags(gated);
        check(flags.audio === null && Math.abs(flags.volume - 1) < 0.001,
            'still untouched after being told to boost');

        // Approve it: the same live page must pick the setting up without a reload.
        await setStorage({ whitelist: ['example.com', '127.0.0.1'] });
        await sleep(1500);
        gatedInfo = await badgeInfo(gated);
        check(gatedInfo.count === 1, `overlay appears on the live page once whitelisted (got ${gatedInfo.count})`);

        const allowed = await sendToTabs('/page2', { action: 'setVolume', value: 2.5 });
        check(allowed && allowed.success === true, 'content script accepts settings again');
        await sleep(500);
        gatedInfo = await badgeInfo(gated);
        check(gatedInfo.hosts[0].volume === '250%', `volume applied after whitelisting (${gatedInfo.hosts[0].volume})`);

        flags = await pageFlags(gated);
        check(flags.active !== null, `data-mc-active marker appears once approved (${flags.active})`);
        check(flags.audio === '1', 'Web Audio is hooked only after a boost on an approved site');

        // ── TEST 6: hiding the badge ─────────────────────────────────────
        console.log('\n--- TEST 6: badges can be hidden entirely ---');
        await setStorage({ showOverlay: false });
        await sleep(700);
        info = await badgeInfo();
        check(info.count === 0, 'overlay removed when the badge is disabled');
        const hidden = await sendToTabs('127.0.0.1', { action: 'setSpeed', value: 1.5 });
        check(hidden && hidden.success === true, 'controls keep working without the badge');
        await setStorage({ showOverlay: true });
        await sleep(700);
        info = await badgeInfo();
        check(info.count === 1, 'overlay returns when re-enabled');

        // ── TEST 7: presets still work ───────────────────────────────────
        console.log('\n--- TEST 7: tab preset persistence ---');
        await sendToTabs('127.0.0.1', { action: 'setVolume', value: 3.0 });
        await sleep(400);
        await page.evaluate(() => {
            const badge = document.querySelector('.__mc-overlay-host').shadowRoot.querySelector('.mc-badge');
            badge.querySelector('.mc-zone-speed').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
            badge.querySelector('.mc-sbtn-t').click();
        });
        await sleep(900);
        await sendToTabs('127.0.0.1', { action: 'setVolume', value: 3.3 });
        await sleep(600);

        await page.goto(ORIGIN + '/page2');
        await page.waitForSelector('video');
        await sleep(2500);
        const page2Info = await badgeInfo();
        check(page2Info.hosts[0] && page2Info.hosts[0].volume === '330%',
            `tab preset survived navigation (${page2Info.hosts[0] && page2Info.hosts[0].volume})`);

        // ── TEST 8: popup dashboard ──────────────────────────────────────
        console.log('\n--- TEST 8: popup dashboard (activation scope UI) ---');
        await admin.reload();
        await sleep(600);
        const popupState = await admin.evaluate(() => ({
            status: document.getElementById('siteStatusBadge').textContent,
            chips: Array.from(document.querySelectorAll('#hostChips .chip span')).map(s => s.textContent),
            mode: document.querySelector('.seg-btn.active') && document.querySelector('.seg-btn.active').dataset.mode,
            whitelistVisible: getComputedStyle(document.getElementById('whitelistArea')).display !== 'none',
            badgeBtn: document.getElementById('btnToggleOverlay').textContent
        }));
        check(popupState.mode === 'whitelist', `popup reflects the active scope (${popupState.mode})`);
        check(popupState.chips.includes('127.0.0.1') && popupState.chips.includes('example.com'),
            `popup lists whitelisted hosts (${popupState.chips.join(', ')})`);
        check(popupState.whitelistVisible, 'whitelist manager is visible in whitelist mode');

        await admin.evaluate(() => {
            document.getElementById('newHostInput').value = 'vimeo.com';
            document.getElementById('btnAddHost').click();
        });
        await sleep(400);
        let chips = await admin.$$eval('#hostChips .chip span', els => els.map(e => e.textContent));
        check(chips.includes('vimeo.com'), 'adding a domain through the popup works');

        await admin.evaluate(() => {
            const chip = Array.from(document.querySelectorAll('#hostChips .chip'))
                .find(c => c.textContent.includes('vimeo.com'));
            chip.querySelector('button').click();
        });
        await sleep(400);
        chips = await admin.$$eval('#hostChips .chip span', els => els.map(e => e.textContent));
        check(!chips.includes('vimeo.com'), 'removing a domain through the popup works');

        await admin.evaluate(() => document.getElementById('segAll').click());
        await sleep(300);
        const modeAfter = await admin.evaluate(() => new Promise(r => chrome.storage.local.get(['siteMode'], res => r(res.siteMode))));
        check(modeAfter === 'all', `switching to "all sites" persists (${modeAfter})`);
        await admin.evaluate(() => document.getElementById('segWhitelist').click());
        await sleep(300);

        check(adminErrors.length === 0, `no popup errors (${adminErrors.slice(0, 2).join(' | ') || 'clean'})`);

        // ── TEST 9: auto-remember per site ───────────────────────────────
        console.log('\n--- TEST 9: auto-remember a site without pressing any lock ---');
        await admin.evaluate(() => new Promise((resolve) => {
            chrome.storage.local.get(null, (all) => {
                const stale = Object.keys(all).filter(k => k.startsWith('saved_') || k.startsWith('tab_'));
                chrome.storage.local.remove(stale.concat(['autoRemember']), () => resolve());
            });
        }));
        await sleep(300);

        // No preset of any kind exists now: without auto-remember a new tab would
        // reset to 100 %, which is the annoyance this feature removes.
        await page.goto(ORIGIN + '/');
        await page.waitForSelector('#video1');
        await sleep(1800);
        await sendToTabs('127.0.0.1', { action: 'setVolume', value: 4.2 });
        await sendToTabs('127.0.0.1', { action: 'setSpeed', value: 1.25 });
        await sleep(700);

        const remembered = await admin.evaluate(() => new Promise(r => chrome.storage.local.get(null, r)));
        const domainKey = Object.keys(remembered).find(k => k.startsWith('saved_domain_'));
        check(!!domainKey && remembered[domainKey].volume === 420 && remembered[domainKey].speed === 125,
            `adjusting the sliders auto-saved the site (${domainKey}: ${JSON.stringify(remembered[domainKey])})`);

        // A brand new tab of the same site must adopt the remembered values.
        const freshTab = await browser.newPage();
        await freshTab.goto(ORIGIN + '/page2');
        await freshTab.waitForSelector('video');
        await sleep(2500);
        const freshInfo = await badgeInfo(freshTab);
        check(freshInfo.hosts[0] && freshInfo.hosts[0].volume === '420%' && freshInfo.hosts[0].speed === '1.25x',
            `new tab reopened with the remembered settings (${freshInfo.hosts[0] && freshInfo.hosts[0].volume} / ${freshInfo.hosts[0] && freshInfo.hosts[0].speed})`);

        // Switching auto-remember off must restore the temporary behaviour.
        await admin.evaluate(() => new Promise(r => chrome.storage.local.set({ autoRemember: 'off' }, r)));
        await admin.evaluate(() => new Promise((resolve) => {
            chrome.storage.local.get(null, (all) => {
                chrome.storage.local.remove(Object.keys(all).filter(k => k.startsWith('saved_')), () => resolve());
            });
        }));
        await sleep(400);
        await sendToTabs('127.0.0.1', { action: 'setVolume', value: 3.1 });
        await sleep(700);
        const offState = await admin.evaluate(() => new Promise(r => chrome.storage.local.get(null, r)));
        check(!Object.keys(offState).some(k => k.startsWith('saved_')),
            'auto-remember Off keeps settings temporary again');

        console.log(`\n${failures === 0 ? '🏆 ALL TESTS PASSED' : `❌ ${failures} TEST(S) FAILED`}`);
    } catch (err) {
        failures++;
        console.error('\n❌ SUITE ERROR:', err && err.stack ? err.stack : err);
    } finally {
        await browser.close();
        server.close();
        process.exit(failures ? 1 : 0);
    }
});
