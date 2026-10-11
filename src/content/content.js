/* Media Controller — content script
 * ---------------------------------------------------------------------------
 * v2.0 architecture
 *   • Only ONE media element ("the primary") is ever controlled: the largest
 *     visible video of the frame. Hover previews, thumbnail trailers, ads,
 *     background videos and other secondary media are left completely alone.
 *     (Before v2.0 every media element on the page was routed through the same
 *     gain node, so a Bilibili hover-preview instantly hijacked the volume.)
 *   • Preset re-fetching is driven by the primary element only, so a preview
 *     starting to load can no longer reset the tab volume back to 100 %.
 *   • Web Audio is hooked lazily and only when a boost (> 100 %) is requested.
 *     At 100 % the extension stays completely passive.
 *   • The overlay badge is anchored to the primary video but can be dragged
 *     anywhere on the screen, including outside the player. Its position is
 *     remembered per site.
 *   • Whitelist scoping: the extension only activates on approved sites.
 * ---------------------------------------------------------------------------
 */
(function () {
    'use strict';

    if (window.__mediaControllerInjected) return;
    window.__mediaControllerInjected = true;

    const MC_VERSION = '2.3';
    const SPEED_SCALE = 100;
    const MAX_BOOST = 5.0;
    const MIN_VIDEO_W = 120;
    const MIN_VIDEO_H = 90;
    // Minimum weighted score an element must reach to be considered "the video
    // the user is actually watching". Keeps muted hover-previews (small and
    // muted → heavily discounted) from ever taking over.
    const MIN_PRIMARY_SCORE = 8000;

    // Sites that get the extension when the whitelist scope is enabled.
    const DEFAULT_WHITELIST = [
        'bilibili.com',
        'youtube.com',
        'youtu.be',
        'netflix.com',
        'twitch.tv',
        'vimeo.com',
        'dailymotion.com',
        'nicovideo.jp',
        'iqiyi.com',
        'v.qq.com',
        'youku.com',
        'zhihu.com',
        'coursera.org',
        'udemy.com',
        'soundcloud.com',
        'spotify.com'
    ];

    const settings = {
        loaded: false,
        siteMode: 'whitelist',   // 'whitelist' | 'all'
        whitelist: DEFAULT_WHITELIST.slice(),
        showOverlay: true,
        overlayStyle: 'pill',    // 'pill'  = floating badge, 'strip' = rail fused to the player edge
        autoHide: true,          // fade/slide away while the pointer is idle
        wheelVolumeStep: 5,      // volume percentage points per wheel notch
        wheelSpeedStep: 5        // speed percentage points (5 → 0.05x) per wheel notch
    };

    const WHEEL_STEPS = [1, 5, 10, 25, 50];
    const STRIP_PEEK = 8;        // px of the rail that stays visible when auto-hidden
    const STRIP_REVEAL_ZONE = 80; // px from the player edge that reveals the rail
    const IDLE_HIDE_MS = 3000;

    const state = {
        enabled: false,
        audioContext: null,
        gainNode: null,
        mediaInfoMap: new WeakMap(),  // media element -> bookkeeping record
        currentVolume: 1.0,
        currentSpeed: 1.0,
        activeMode: 'none',
        primary: null,
        overlay: null,
        badgeOffset: null,            // { x, y } relative to the host box, null = default
        initialised: false
    };

    // ── Small helpers ───────────────────────────────────────────────────

    const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

    function log() {
        // Kept intentionally quiet in production; flip to console.debug when
        // debugging a site by uncommenting the next line.
        // console.debug('[MediaController]', ...arguments);
    }

    function safeSetVolume(media, value) {
        try {
            media.volume = clamp(value, 0, 1);
        } catch (e) { /* element detached */ }
    }

    function safeSetRate(media, value) {
        try {
            media.playbackRate = value;
        } catch (e) { /* element detached */ }
    }

    // Writes that we can later undo. `applied*` remembers our own value so that
    // a demoted element can be restored without clobbering a volume/rate the
    // site itself changed in the meantime.
    function ourSetVolume(media, value) {
        const info = infoFor(media);
        try {
            media.volume = clamp(value, 0, 1);
        } catch (e) {
            return;
        }
        info.appliedVolume = media.volume;
    }

    function ourSetRate(media, value) {
        const info = infoFor(media);
        try {
            media.playbackRate = value;
        } catch (e) {
            return;
        }
        info.appliedRate = media.playbackRate;
        info.rateApplied = true;
    }

    // ── Whitelist handling ──────────────────────────────────────────────

    function normalizeHost(value) {
        return String(value || '')
            .trim()
            .toLowerCase()
            .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
            .replace(/^[^/@]*@/, '')
            .replace(/^www\./, '')
            .split('/')[0]
            .split('?')[0]
            .replace(/:\d+$/, '');
    }

    function hostMatches(host, entry) {
        const e = normalizeHost(entry);
        if (!e) return false;
        return host === e || host.endsWith('.' + e);
    }

    // Page-visible state markers (attributes on <html>). They make "is the
    // extension doing anything here?" answerable from devtools, and let the test
    // suite prove that an unapproved page is never touched:
    //   data-mc-active="2.1" → the extension is running on this page
    //   data-mc-audio="1"    → Web Audio was hooked (only for a boost > 100 %,
    //                          only ever for the primary element)
    function markPageState() {
        const el = document.documentElement;
        if (!el) return;
        if (state.enabled) el.setAttribute('data-mc-active', MC_VERSION);
        else el.removeAttribute('data-mc-active');
        if (state.audioContext) el.setAttribute('data-mc-audio', '1');
    }

    function isSiteAllowed() {
        if (!settings.loaded) return false;
        if (settings.siteMode !== 'whitelist') return true;
        const host = normalizeHost(location.hostname);
        if (!host) return false; // about:, data:, sandboxed frames … stay off
        return settings.whitelist.some(entry => hostMatches(host, entry));
    }

    function loadSettings() {
        return new Promise(resolve => {
            const keys = [
                'siteMode', 'whitelist', 'showOverlay', 'overlayStyle', 'autoHide',
                'wheelVolumeStep', 'wheelSpeedStep',
                `overlay_pos_${normalizeHost(location.hostname)}`
            ];
            const done = () => {
                settings.loaded = true;
                resolve();
            };
            try {
                chrome.storage.local.get(keys, result => {
                    if (result && result.siteMode) settings.siteMode = result.siteMode;
                    if (result && Array.isArray(result.whitelist)) settings.whitelist = result.whitelist;
                    if (result && typeof result.showOverlay === 'boolean') settings.showOverlay = result.showOverlay;
                    if (result && result.overlayStyle === 'strip') settings.overlayStyle = 'strip';
                    if (result && typeof result.autoHide === 'boolean') settings.autoHide = result.autoHide;
                    if (result && WHEEL_STEPS.includes(Number(result.wheelVolumeStep))) {
                        settings.wheelVolumeStep = Number(result.wheelVolumeStep);
                    }
                    if (result && WHEEL_STEPS.includes(Number(result.wheelSpeedStep))) {
                        settings.wheelSpeedStep = Number(result.wheelSpeedStep);
                    }
                    const saved = result && result[`overlay_pos_${normalizeHost(location.hostname)}`];
                    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
                        state.badgeOffset = { x: saved.x, y: saved.y };
                    }
                    done();
                });
            } catch (e) {
                done();
            }
        });
    }

    function saveBadgeOffset() {
        if (!state.badgeOffset) return;
        const key = `overlay_pos_${normalizeHost(location.hostname)}`;
        try {
            chrome.storage.local.set({ [key]: state.badgeOffset });
        } catch (e) { /* ignore */ }
    }

    // ── Audio graph ─────────────────────────────────────────────────────
    //
    // Nothing in here runs on a page the user has not approved. The only path to
    // `new AudioContext()` / `createMediaElementSource()` is
    //   activate() → refreshPrimary() → promote() → applyVolume() → routeViaGain()
    // and every step of that chain is gated behind `state.enabled`, which is only
    // true while `isSiteAllowed()` says so.

    let interactionListenersAttached = false;

    function initAudio() {
        if (state.audioContext) return true;
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return false;
        try {
            state.audioContext = new AudioCtx();
            state.gainNode = state.audioContext.createGain();
            state.gainNode.gain.value = state.currentVolume;
            state.gainNode.connect(state.audioContext.destination);
        } catch (e) {
            state.audioContext = null;
            state.gainNode = null;
            return false;
        }
        if (!interactionListenersAttached) {
            interactionListenersAttached = true;
            ['click', 'keydown', 'touchstart', 'pointerdown'].forEach(evt => {
                document.addEventListener(evt, resumeAudioContext, { passive: true, capture: true });
            });
        }
        markPageState();
        return true;
    }

    function resumeAudioContext() {
        if (state.audioContext && state.audioContext.state === 'suspended') {
            state.audioContext.resume().catch(() => { });
        }
    }

    function setGain(value, smooth) {
        if (!state.gainNode || !state.audioContext) return;
        if (smooth === false) {
            state.gainNode.gain.value = value;
            return;
        }
        try {
            state.gainNode.gain.setTargetAtTime(value, state.audioContext.currentTime, 0.05);
        } catch (e) {
            state.gainNode.gain.value = value;
        }
    }

    function infoFor(media) {
        let info = state.mediaInfoMap.get(media);
        if (!info) {
            info = {
                source: null,
                routed: 'none',      // 'none' | 'gain' | 'direct' | 'blocked'
                baseVolume: media.volume,
                baseRate: media.playbackRate,
                appliedVolume: null,
                appliedRate: null,
                rateApplied: false
            };
            state.mediaInfoMap.set(media, info);
        }
        return info;
    }

    // Route the element's audio through the boost gain node.
    function routeViaGain(media) {
        if (!initAudio()) return false;
        const info = infoFor(media);
        if (!info.source && info.routed !== 'blocked') {
            try {
                info.source = state.audioContext.createMediaElementSource(media);
            } catch (e) {
                // Cross-origin without CORS, or the element is already captured
                // by another AudioContext. Never touch its audio graph again.
                info.routed = 'blocked';
                return false;
            }
        }
        if (!info.source) return false;
        try { info.source.disconnect(); } catch (e) { }
        try { info.source.connect(state.gainNode); } catch (e) { return false; }
        info.routed = 'gain';
        return true;
    }

    // Send the element's audio straight to the speakers, skipping our gain.
    function routeDirect(media) {
        const info = state.mediaInfoMap.get(media);
        if (!info || !info.source || !state.audioContext) return;
        try { info.source.disconnect(); } catch (e) { }
        try { info.source.connect(state.audioContext.destination); } catch (e) { }
        info.routed = 'direct';
    }

    // ── Overlay widget styles ───────────────────────────────────────────

    function buildOverlayStyles() {
        return `
            :host {
                all: initial;
                position: fixed;
                top: 0;
                left: 0;
                font-family: 'Inter', system-ui, -apple-system, sans-serif;
                pointer-events: none;
                z-index: 2147483647;
            }

            .mc-badge {
                position: absolute;
                top: 8px;
                left: 50%;
                transform: translateX(-50%);
                display: flex;
                align-items: center;
                gap: 2px;
                /* NOTE: no backdrop-filter anywhere in this widget. Chromium
                   composites a filtered element (and in some versions its
                   descendants) in a separate layer which made the slider
                   popovers render washed out / invisible. Solid translucent
                   colours look the same over a video and always paint. */
                background: rgba(15, 15, 20, 0.86);
                border: 1px solid rgba(255, 255, 255, 0.12);
                border-radius: 100px;
                padding: 2px 4px;
                user-select: none;
                box-shadow: 0 8px 32px rgba(0, 0, 0, 0.45);
                opacity: var(--mc-idle-opacity, 0.45);
                transition: opacity 0.3s ease, background 0.3s ease,
                            transform 0.22s cubic-bezier(0.4, 0, 0.2, 1);
                pointer-events: auto;
                -webkit-tap-highlight-color: transparent;
                touch-action: none;
                z-index: 2147483647 !important;
            }

            .mc-badge:hover, .mc-badge.mc-pop-active {
                opacity: 1 !important;
                background: rgba(15, 15, 20, 0.88);
                box-shadow: 0 12px 40px rgba(0, 0, 0, 0.55);
            }

            /* Auto-hide: the badge fades out and stops receiving events until the
               pointer moves again (used for both layouts). */
            .mc-badge.mc-hushed {
                opacity: 0 !important;
                pointer-events: none !important;
            }

            /* Side rail: a compact vertical strip fused to the player's edge.
               Popovers stay disabled until it slides open, so nothing is ever
               rendered sideways. */
            .mc-badge.mc-strip:not(.mc-strip-open) .mc-zone > .mc-spd-pop,
            .mc-badge.mc-strip:not(.mc-strip-open) .mc-zone > .mc-vol-pop,
            .mc-badge.mc-strip:not(.mc-strip-open) .mc-zone > .mc-eye-pop,
            .mc-badge.mc-strip:not(.mc-strip-open) .mc-zone > .mc-save-pop {
                display: none !important;
            }

            .mc-badge.mc-strip-open {
                background: rgba(15, 15, 20, 0.9);
                box-shadow: 0 12px 40px rgba(0, 0, 0, 0.55);
            }

            /* The opened rail sits against the player's right edge, so its
               popovers are right-aligned instead of centred — otherwise the
               right-most chip would push its slider off the screen. */
            .mc-badge.mc-strip-open .mc-spd-pop,
            .mc-badge.mc-strip-open .mc-vol-pop,
            .mc-badge.mc-strip-open .mc-eye-pop,
            .mc-badge.mc-strip-open .mc-save-pop {
                left: auto;
                right: 0;
                transform: translateX(0) scale(0.95);
            }

            .mc-badge.mc-strip-open .mc-zone:hover > .mc-spd-pop,
            .mc-badge.mc-strip-open .mc-zone:hover > .mc-vol-pop,
            .mc-badge.mc-strip-open .mc-zone:hover > .mc-eye-pop,
            .mc-badge.mc-strip-open .mc-zone:hover > .mc-save-pop,
            .mc-badge.mc-strip-open .mc-zone.mc-open > .mc-spd-pop,
            .mc-badge.mc-strip-open .mc-zone.mc-open > .mc-vol-pop,
            .mc-badge.mc-strip-open .mc-zone.mc-open > .mc-eye-pop,
            .mc-badge.mc-strip-open .mc-zone.mc-open > .mc-save-pop {
                /* no transform at all here: an identity transform would promote
                   the popover to its own composite layer, which some engines
                   then paint late (invisible for a frame or two). */
                transform: none;
            }

            .mc-badge.mc-dragging {
                opacity: 1 !important;
                background: rgba(15, 15, 20, 0.88);
                transition: none !important;
                cursor: grabbing;
            }

            .mc-zone {
                position: relative;
                display: flex;
                align-items: center;
                padding: 4px 10px;
                cursor: default;
                border-radius: 100px;
                transition: background 0.2s ease;
                touch-action: manipulation;
            }

            .mc-zone-speed:hover { background: rgba(166, 227, 161, 0.12); }
            .mc-zone-vol:hover   { background: rgba(137, 180, 250, 0.12); }
            .mc-zone-eye:hover   { background: rgba(255, 255, 255, 0.1); }
            .mc-zone-reset { color: #ffffff !important; }
            .mc-zone-reset:hover { background: rgba(255, 255, 255, 0.15); }
            .mc-zone-grip { cursor: grab; padding: 4px 6px; color: rgba(205, 214, 244, 0.55); }
            .mc-zone-grip:hover { background: rgba(255, 255, 255, 0.1); color: #fff; }

            .mc-sep {
                width: 1px;
                height: 12px;
                background: rgba(255, 255, 255, 0.1);
                margin: 0;
            }

            .mc-label {
                font-size: 10px;
                font-weight: 700;
                color: rgba(205, 214, 244, 0.9);
                white-space: nowrap;
                letter-spacing: 0.02em;
                font-variant-numeric: tabular-nums;
            }

            .mc-speed-val { color: #a6e3a1; }
            .mc-vol-val   { color: #89b4fa; }

            .mc-spd-pop, .mc-vol-pop, .mc-eye-pop, .mc-save-pop {
                position: absolute;
                top: calc(100% - 2px);
                left: 50%;
                transform: translateX(-50%) scale(0.95);
                display: flex;
                align-items: center;
                gap: 6px;
                background: rgba(24, 24, 37, 0.97);
                border: 1px solid rgba(255, 255, 255, 0.12);
                border-radius: 12px;
                padding: 8px 10px;
                opacity: 0;
                pointer-events: none;
                transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
                box-shadow: 0 12px 48px rgba(0, 0, 0, 0.6);
                margin-top: 5px;
            }

            .mc-spd-pop::before, .mc-vol-pop::before, .mc-eye-pop::before, .mc-save-pop::before {
                content: "";
                position: absolute;
                top: -10px;
                left: 0;
                right: 0;
                height: 10px;
                background: transparent;
            }

            .mc-zone:hover .mc-spd-pop, .mc-zone:hover .mc-vol-pop, .mc-zone:hover .mc-eye-pop, .mc-zone:hover .mc-save-pop,
            .mc-zone.mc-open .mc-spd-pop, .mc-zone.mc-open .mc-vol-pop, .mc-zone.mc-open .mc-eye-pop, .mc-zone.mc-open .mc-save-pop {
                opacity: 1;
                pointer-events: auto;
                transform: translateX(-50%) scale(1);
            }

            .mc-sbtn {
                display: flex;
                align-items: center;
                justify-content: center;
                min-width: 26px;
                height: 26px;
                border: none;
                border-radius: 7px;
                background: rgba(255, 255, 255, 0.05);
                color: rgba(205, 214, 244, 0.9);
                font-size: 12px;
                font-weight: 700;
                cursor: pointer;
                transition: all 0.15s ease;
                padding: 0 5px;
            }

            .mc-sbtn:hover { background: rgba(166, 227, 161, 0.2); color: #a6e3a1; }
            .mc-sbtn:active { transform: scale(0.92); }

            .mc-sbtn-t:hover { background: rgba(180, 190, 254, 0.2); color: #b4befe; }
            .mc-sbtn-d:hover { background: rgba(250, 179, 135, 0.2); color: #fab387; }
            .mc-sbtn-g:hover { background: rgba(166, 227, 161, 0.2); color: #a6e3a1; }
            .mc-sbtn-c:hover { background: rgba(243, 139, 168, 0.2); color: #f38ba8; }

            .mc-sbtn.mc-active {
                background: rgba(255, 255, 255, 0.15);
                box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.2);
            }

            .mc-vslider {
                -webkit-appearance: none;
                appearance: none;
                width: 84px;
                height: 3px;
                border-radius: 10px;
                background: rgba(255, 255, 255, 0.1);
                outline: none;
            }

            .mc-vslider::-webkit-slider-thumb {
                -webkit-appearance: none;
                width: 12px;
                height: 12px;
                border-radius: 50%;
                background: #89b4fa;
                box-shadow: 0 0 10px rgba(137, 180, 250, 0.4);
                cursor: pointer;
                border: 2px solid #1e1e2e;
            }

            .mc-vslider::-moz-range-thumb {
                width: 12px;
                height: 12px;
                border-radius: 50%;
                background: #89b4fa;
                cursor: pointer;
                border: 2px solid #1e1e2e;
            }

            .mc-vpct {
                font-size: 10px;
                font-weight: 800;
                color: #89b4fa;
                min-width: 30px;
                text-align: right;
            }

            .mc-zone-reset svg {
                transition: transform 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275);
            }
            .mc-zone-reset:hover svg {
                transform: rotate(-180deg) scale(1.1);
            }
        `;
    }

    function createEl(tag, className, text = '', props = {}) {
        const el = document.createElement(tag);
        if (className) el.className = className;
        if (text) el.textContent = text;
        Object.assign(el, props);
        return el;
    }

    function createSvgIcon({ width, height, viewBox, stroke = 'currentColor', attrs = {}, children = [] }) {
        const SVG_NS = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('xmlns', SVG_NS);
        svg.setAttribute('width', String(width));
        svg.setAttribute('height', String(height));
        svg.setAttribute('viewBox', viewBox);
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', stroke);
        svg.setAttribute('stroke-width', '2');
        svg.setAttribute('stroke-linecap', 'round');
        svg.setAttribute('stroke-linejoin', 'round');

        Object.entries(attrs).forEach(([key, value]) => svg.setAttribute(key, String(value)));

        children.forEach(({ tag, attrs: childAttrs }) => {
            const child = document.createElementNS(SVG_NS, tag);
            Object.entries(childAttrs).forEach(([key, value]) => child.setAttribute(key, String(value)));
            svg.appendChild(child);
        });

        return svg;
    }

    // ── Overlay widget ──────────────────────────────────────────────────

    function destroyOverlay() {
        const overlay = state.overlay;
        if (!overlay) return;
        state.overlay = null;
        try { overlay.destroy(); } catch (e) { }
    }

    function createOverlay(target) {
        const isVideo = target.tagName === 'VIDEO';
        const host = createEl('div', '__mc-overlay-host');
        host.dataset.mcFixed = '1';
        host.dataset.mcVersion = MC_VERSION;
        host.style.cssText = 'position:fixed;top:0;left:0;pointer-events:none;z-index:2147483647;';

        const shadow = host.attachShadow({ mode: 'open' });
        shadow.appendChild(createEl('style', '', buildOverlayStyles()));

        const badge = createEl('div', 'mc-badge');

        // ── Drag handle ──
        const gripZone = createEl('div', 'mc-zone mc-zone-grip');
        gripZone.title = 'Drag to move · double-click to snap back to the player';
        gripZone.appendChild(createSvgIcon({
            width: 11, height: 11, viewBox: '0 0 24 24',
            children: [
                { tag: 'circle', attrs: { cx: '9', cy: '6', r: '1' } },
                { tag: 'circle', attrs: { cx: '9', cy: '12', r: '1' } },
                { tag: 'circle', attrs: { cx: '9', cy: '18', r: '1' } },
                { tag: 'circle', attrs: { cx: '15', cy: '6', r: '1' } },
                { tag: 'circle', attrs: { cx: '15', cy: '12', r: '1' } },
                { tag: 'circle', attrs: { cx: '15', cy: '18', r: '1' } }
            ]
        }));

        // ── Speed zone ──
        const speedZone = createEl('div', 'mc-zone mc-zone-speed');
        const speedLabel = createEl('span', 'mc-label mc-speed-val', state.currentSpeed.toFixed(2) + 'x');

        const spdPop = createEl('div', 'mc-spd-pop');
        const btnMinus = createEl('button', 'mc-sbtn', '\u2212');
        const btnResetSpeed = createEl('button', 'mc-sbtn mc-sbtn-rst', '1\u00d7');
        const btnPlus = createEl('button', 'mc-sbtn', '+');
        spdPop.append(btnMinus, btnResetSpeed, btnPlus);
        speedZone.append(speedLabel, spdPop);

        // ── Volume zone ──
        const volZone = createEl('div', 'mc-zone mc-zone-vol');
        const volLabel = createEl('span', 'mc-label mc-vol-val', Math.round(state.currentVolume * 100) + '%');

        const volPop = createEl('div', 'mc-vol-pop');
        const volSlider = createEl('input', 'mc-vslider', '', {
            type: 'range', min: '0', max: String(MAX_BOOST * 100), step: '1',
            value: String(Math.round(state.currentVolume * 100))
        });
        const volPct = createEl('span', 'mc-vpct', Math.round(state.currentVolume * 100) + '%');
        volPop.append(volSlider, volPct);
        volZone.append(volLabel, volPop);

        // ── Reset zone ──
        const resetZone = createEl('div', 'mc-zone mc-zone-reset');
        resetZone.title = 'Reset (1.0x speed, 100% volume)';
        resetZone.appendChild(createSvgIcon({
            width: 13, height: 13, viewBox: '0 0 24 24',
            attrs: { style: 'color:#ffffff !important;' },
            children: [
                { tag: 'path', attrs: { d: 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8' } },
                { tag: 'path', attrs: { d: 'M3 3v5h5' } }
            ]
        }));

        // ── Save / preset zone ──
        const saveZone = createEl('div', 'mc-zone mc-zone-save');
        const saveIcon = createEl('span', 'mc-label');
        saveIcon.appendChild(createSvgIcon({
            width: 13, height: 13, viewBox: '0 0 24 24',
            children: [{ tag: 'path', attrs: { d: 'm19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z' } }]
        }));
        const savePop = createEl('div', 'mc-save-pop');
        const btnTab = createEl('button', 'mc-sbtn mc-sbtn-t', 'T', { title: 'Lock to Tab' });
        const btnDom = createEl('button', 'mc-sbtn mc-sbtn-d', 'D', { title: 'Lock to Domain' });
        const btnGlo = createEl('button', 'mc-sbtn mc-sbtn-g', 'G', { title: 'Lock Globally' });
        const btnClr = createEl('button', 'mc-sbtn mc-sbtn-c', '\u2715', { title: 'Clear Preset' });
        savePop.append(btnTab, btnDom, btnGlo, btnClr);
        saveZone.append(saveIcon, savePop);

        // ── Opacity zone ──
        const eyeZone = createEl('div', 'mc-zone mc-zone-eye');
        const eyeIcon = createEl('span', 'mc-label');
        eyeIcon.appendChild(createSvgIcon({
            width: 13, height: 13, viewBox: '0 0 24 24',
            children: [
                { tag: 'path', attrs: { d: 'M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0' } },
                { tag: 'circle', attrs: { cx: '12', cy: '12', r: '3' } }
            ]
        }));
        const eyePop = createEl('div', 'mc-eye-pop');
        const EYE_DEFAULT = 45;
        const eyeSlider = createEl('input', 'mc-vslider', '', {
            type: 'range', min: '15', max: '100', step: '5', value: String(EYE_DEFAULT)
        });
        const eyePct = createEl('span', 'mc-vpct', EYE_DEFAULT + '%');
        eyePop.append(eyeSlider, eyePct);
        eyeZone.append(eyeIcon, eyePop);

        badge.append(gripZone, speedZone, createEl('div', 'mc-sep'), volZone, resetZone, saveZone, eyeZone);
        shadow.appendChild(badge);

        // ── Display sync ──
        function syncDisplay() {
            const volPercent = Math.round(state.currentVolume * 100);
            speedLabel.textContent = state.currentSpeed.toFixed(2) + 'x';
            volLabel.textContent = volPercent + '%';
            if (document.activeElement !== volSlider && shadow.activeElement !== volSlider) {
                volSlider.value = String(volPercent);
            }
            volPct.textContent = volPercent + '%';

            [btnTab, btnDom, btnGlo].forEach(b => b.classList.remove('mc-active'));
            if (state.activeMode === 'tab') btnTab.classList.add('mc-active');
            else if (state.activeMode === 'domain') btnDom.classList.add('mc-active');
            else if (state.activeMode === 'global') btnGlo.classList.add('mc-active');
        }

        // ── Preset mode buttons ──
        const setOverlayMode = (mode) => {
            chrome.runtime.sendMessage({
                action: 'setMode',
                mode,
                volume: Math.round(state.currentVolume * 100),
                speed: Math.round(state.currentSpeed * SPEED_SCALE)
            }, () => fetchAndApplyPreset());
        };
        btnTab.onclick = (e) => { e.stopPropagation(); setOverlayMode('tab'); };
        btnDom.onclick = (e) => { e.stopPropagation(); setOverlayMode('domain'); };
        btnGlo.onclick = (e) => { e.stopPropagation(); setOverlayMode('global'); };
        btnClr.onclick = (e) => { e.stopPropagation(); setOverlayMode('clear'); };

        // ── Speed controls ──
        function stepSpeed(direction, stepOverride) {
            const curr = Math.round(state.currentSpeed * 100);
            const step = Number.isFinite(stepOverride) ? stepOverride : 5;
            const next = direction > 0 ? Math.min(1600, curr + step) : Math.max(10, curr - step);
            setSpeed(next / 100);
        }
        btnMinus.addEventListener('click', (e) => { e.stopPropagation(); stepSpeed(-1); });
        btnPlus.addEventListener('click', (e) => { e.stopPropagation(); stepSpeed(1); });
        btnResetSpeed.addEventListener('click', (e) => { e.stopPropagation(); setSpeed(1.0); });
        speedZone.addEventListener('wheel', (e) => {
            e.preventDefault();
            e.stopPropagation();
            stepSpeed(e.deltaY < 0 ? 1 : -1, settings.wheelSpeedStep);
        }, { passive: false });

        // ── Volume controls ──
        function setVolumeFromSlider(value) {
            setVolume(clamp(value, 0, MAX_BOOST * 100) / 100);
        }
        volSlider.addEventListener('input', (e) => {
            e.stopPropagation();
            setVolumeFromSlider(parseInt(e.target.value, 10));
        });
        volZone.addEventListener('wheel', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const step = (e.deltaY < 0 ? 1 : -1) * settings.wheelVolumeStep;
            const next = clamp(Math.round(state.currentVolume * 100) + step, 0, MAX_BOOST * 100);
            setVolume(next / 100);
        }, { passive: false });

        // Sliders must not leak pointer events into the player below them.
        [volSlider, eyeSlider].forEach(slider => {
            const stopImmediate = (e) => { e.stopPropagation(); e.stopImmediatePropagation(); };
            ['pointerdown', 'mousedown', 'touchstart'].forEach(evt => {
                slider.addEventListener(evt, (e) => {
                    stopImmediate(e);
                    if (e.pointerId && slider.setPointerCapture) {
                        try { slider.setPointerCapture(e.pointerId); } catch (_) { }
                    }
                }, { capture: true });
            });
            ['pointermove', 'mousemove', 'touchmove', 'pointerup', 'mouseup', 'touchend', 'click'].forEach(evt => {
                slider.addEventListener(evt, stopImmediate, { capture: true });
            });
            slider.addEventListener('pointerup', (e) => {
                if (e.pointerId && slider.hasPointerCapture && slider.hasPointerCapture(e.pointerId)) {
                    try { slider.releasePointerCapture(e.pointerId); } catch (_) { }
                }
            });
        });

        // ── Reset ──
        resetZone.addEventListener('click', (e) => {
            e.stopPropagation();
            setSpeed(1.0);
            setVolume(1.0);
        });

        // ── Opacity ──
        function applyIdleOpacity(value) {
            eyePct.textContent = value + '%';
            badge.style.setProperty('--mc-idle-opacity', value / 100);
            try { chrome.storage.local.set({ badgeOpacity: value }); } catch (err) { }
        }
        eyeSlider.addEventListener('input', (e) => {
            e.stopPropagation();
            applyIdleOpacity(parseInt(e.target.value, 10));
        });
        eyeZone.addEventListener('wheel', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const next = clamp(parseInt(eyeSlider.value, 10) + (e.deltaY < 0 ? 5 : -5), 15, 100);
            eyeSlider.value = String(next);
            applyIdleOpacity(next);
        }, { passive: false });
        try {
            chrome.storage.local.get(['badgeOpacity'], (result) => {
                const saved = result && Number(result.badgeOpacity);
                if (Number.isFinite(saved) && saved >= 15 && saved <= 100) {
                    eyeSlider.value = String(saved);
                    applyIdleOpacity(saved);
                }
            });
        } catch (e) { /* ignore */ }

        // ── Touch tap-to-open popovers ──
        const isTouchPrimary = () => window.matchMedia('(hover: none)').matches;
        const toggleZones = [
            { zone: speedZone }, { zone: volZone }, { zone: eyeZone }, { zone: saveZone }
        ];
        function closeAllPops(exceptZone) {
            toggleZones.forEach(({ zone }) => { if (zone !== exceptZone) zone.classList.remove('mc-open'); });
            badge.classList.toggle('mc-pop-active', toggleZones.some(({ zone }) => zone.classList.contains('mc-open')));
        }
        toggleZones.forEach(({ zone }) => {
            zone.addEventListener('click', (e) => {
                if (!isTouchPrimary()) return;
                e.stopPropagation();
                if (e.target.closest && (e.target.closest('.mc-sbtn') || e.target.closest('.mc-vslider'))) return;
                const wasOpen = zone.classList.contains('mc-open');
                closeAllPops(null);
                if (!wasOpen) {
                    zone.classList.add('mc-open');
                    badge.classList.add('mc-pop-active');
                }
            });
        });
        const onOutsideClick = (e) => {
            if (!isTouchPrimary()) return;
            const path = e.composedPath ? e.composedPath() : [];
            if (!path.includes(badge)) closeAllPops(null);
        };
        document.addEventListener('click', onOutsideClick, { capture: true, passive: true });

        // ── Positioning ──
        // The badge lives inside a host box that tracks the player. It may be
        // dragged outside that box — clamping is done against the *viewport*,
        // not against the player, so the badge never has to cover the video.
        function clampBadgePosition(x, y) {
            const hostRect = host.getBoundingClientRect();
            const bw = badge.offsetWidth || 0;
            const bh = badge.offsetHeight || 0;
            if (!bw || !bh) return { x, y };
            const minX = -hostRect.left + 4;
            const maxX = window.innerWidth - hostRect.left - bw - 4;
            const minY = -hostRect.top + 4;
            const maxY = window.innerHeight - hostRect.top - bh - 4;
            return {
                x: clamp(x, minX, Math.max(minX, maxX)),
                y: clamp(y, minY, Math.max(minY, maxY))
            };
        }

        // Two layouts are supported:
        //   'pill'  → the classic draggable badge (left/top + no transform)
        //   'strip' → a vertical rail fused to the player's right edge. Its box is
        //             pinned once per resize and everything else is a transform, so
        //             scrolling never lags and open/close stays smooth.
        let hushed = false;          // auto-hidden
        let stripOpen = false;       // rail expanded into the full horizontal badge
        let idleTimer = null;
        let collapseTimer = null;
        let pointerDownInside = false;
        let lastTimerReset = 0;

        // Cached player rect: `pointermove` fires constantly, so it must never
        // force a synchronous layout. positionHost() refreshes this.
        let hostRectCache = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };

        function usingStrip(rect) {
            if (settings.overlayStyle !== 'strip') return false;
            const r = rect || hostRectCache;
            // Not enough room for a vertical rail? Fall back to the pill.
            return r.width >= 90 && r.height >= Math.max(badge.offsetWidth, 160);
        }

        function layoutBadge() {
            if (dragging || !badge.offsetWidth || host.style.display === 'none') return;
            const hostRect = host.getBoundingClientRect();
            hostRectCache = hostRect;

            if (usingStrip(hostRect)) {
                const bw = badge.offsetWidth;
                const bh = badge.offsetHeight;
                const visualW = stripOpen ? bw : bh;
                // Visual centre: flush against the player's right edge, vertically centred.
                const cx = hostRect.width - visualW / 2;
                const cy = hostRect.height / 2;
                badge.style.left = Math.round(cx - bw / 2) + 'px';
                badge.style.top = Math.round(cy - bh / 2) + 'px';
                const slide = stripOpen || !hushed ? 0 : Math.max(0, bh - STRIP_PEEK);
                badge.style.transform = stripOpen
                    ? `translateX(${slide}px) rotate(0deg)`
                    : `translateX(${slide}px) rotate(90deg)`;
                return;
            }

            let x;
            let y;
            if (state.badgeOffset) {
                x = state.badgeOffset.x;
                y = state.badgeOffset.y;
            } else {
                x = Math.max(0, Math.round((hostRect.width - badge.offsetWidth) / 2));
                y = 8;
            }
            const pos = clampBadgePosition(x, y);
            badge.style.transform = 'none';
            badge.style.left = pos.x + 'px';
            badge.style.top = pos.y + 'px';
        }

        // ── Auto-hide / reveal ──
        function setHushed(value) {
            if (hushed === value) return;
            hushed = value;
            if (hushed) {
                stripOpen = false;
                badge.classList.remove('mc-strip-open');
                closeAllPops(null);
            }
            badge.classList.toggle('mc-hushed', hushed);
            layoutBadge();
        }

        function scheduleIdleHide() {
            clearTimeout(idleTimer);
            if (!settings.autoHide) return;
            idleTimer = setTimeout(() => {
                if (dragging || pointerDownInside) { scheduleIdleHide(); return; }
                if (badge.matches(':hover')) { scheduleIdleHide(); return; }
                setHushed(true);
            }, IDLE_HIDE_MS);
        }

        function reveal() {
            if (hushed) setHushed(false);
            const now = Date.now();
            if (now - lastTimerReset > 1000) {
                lastTimerReset = now;
                scheduleIdleHide();
            }
        }

        const onPointerMove = () => {
            // Both layouts behave the same: any pointer activity brings the UI
            // back, and it slips away again after IDLE_HIDE_MS of stillness.
            reveal();
        };

        // Approaching the player's edge also counts, so a resting pointer next to
        // the rail keeps it out (the idle timer would otherwise hide it).
        const onPointerNearEdge = (e) => {
            if (!usingStrip() || stripOpen) return;
            const r = hostRectCache;
            if (e.clientX > r.right - STRIP_REVEAL_ZONE &&
                e.clientY > r.top - 40 && e.clientY < r.bottom + 40) {
                lastTimerReset = Date.now();
                scheduleIdleHide();
            }
        };

        function openStrip() {
            if (usingStrip() && !stripOpen && !hushed) {
                clearTimeout(collapseTimer);
                stripOpen = true;
                badge.classList.add('mc-strip-open');
                layoutBadge();
            }
        }

        function scheduleCollapse() {
            if (!usingStrip()) return;
            clearTimeout(collapseTimer);
            collapseTimer = setTimeout(() => {
                if (badge.matches(':hover') || dragging || pointerDownInside) return;
                stripOpen = false;
                badge.classList.remove('mc-strip-open');
                layoutBadge();
            }, 400);
        }

        badge.addEventListener('pointerenter', () => {
            clearTimeout(collapseTimer);
            reveal();
            openStrip();
        });
        badge.addEventListener('pointerleave', () => {
            scheduleCollapse();
            scheduleIdleHide();
        });
        badge.addEventListener('pointerdown', () => { pointerDownInside = true; });
        ['pointerup', 'pointercancel'].forEach(evt => {
            badge.addEventListener(evt, () => {
                pointerDownInside = false;
                scheduleIdleHide();
            });
        });

        // ── Drag ──
        let dragStartX = 0;
        let dragStartY = 0;
        let startOffsetX = 0;
        let startOffsetY = 0;
        let dragging = false;

        const canStartDragFromTarget = (target) => {
            if (!target || !target.closest) return true;
            return !target.closest('.mc-sbtn') && !target.closest('.mc-vslider');
        };

        function startDrag(startX, startY) {
            dragStartX = startX;
            dragStartY = startY;
            const pos = state.badgeOffset || { x: badge.offsetLeft, y: badge.offsetTop };
            startOffsetX = pos.x;
            startOffsetY = pos.y;
            dragging = false;

            const onMove = (me) => {
                me.stopPropagation();
                me.preventDefault();
                const cx = me.touches ? me.touches[0].clientX : me.clientX;
                const cy = me.touches ? me.touches[0].clientY : me.clientY;
                if (!Number.isFinite(cx) || !Number.isFinite(cy)) return;
                const dx = cx - dragStartX;
                const dy = cy - dragStartY;
                if (!dragging && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
                    dragging = true;
                    badge.classList.add('mc-dragging');
                }
                if (!dragging) return;
                const next = clampBadgePosition(startOffsetX + dx, startOffsetY + dy);
                badge.style.left = next.x + 'px';
                badge.style.top = next.y + 'px';
            };

            const onUp = (ue) => {
                ue.stopPropagation();
                if (dragging) {
                    state.badgeOffset = { x: badge.offsetLeft, y: badge.offsetTop };
                    saveBadgeOffset();
                }
                dragging = false;
                badge.classList.remove('mc-dragging');
                const opts = { capture: true, passive: false };
                ['mousemove', 'pointermove', 'touchmove'].forEach(evt => document.removeEventListener(evt, onMove, opts));
                ['mouseup', 'pointerup', 'pointercancel', 'touchend', 'touchcancel'].forEach(evt => document.removeEventListener(evt, onUp, opts));
            };

            const opts = { capture: true, passive: false };
            ['mousemove', 'pointermove', 'touchmove'].forEach(evt => document.addEventListener(evt, onMove, opts));
            ['mouseup', 'pointerup', 'pointercancel', 'touchend', 'touchcancel'].forEach(evt => document.addEventListener(evt, onUp, opts));
        }

        badge.addEventListener('pointerdown', (e) => {
            if (e.pointerType === 'mouse' && e.button !== 0) return;
            if (usingStrip()) return; // the rail is docked, dragging is a pill-mode thing
            if (!canStartDragFromTarget(e.target)) return;
            e.stopPropagation();
            if (badge.setPointerCapture) {
                try { badge.setPointerCapture(e.pointerId); } catch (_) { }
            }
            startDrag(e.clientX, e.clientY);
        });

        badge.addEventListener('dblclick', (e) => {
            // Snap the badge back to the player's top edge.
            state.badgeOffset = null;
            const key = `overlay_pos_${normalizeHost(location.hostname)}`;
            try { chrome.storage.local.remove([key]); } catch (err) { }
            layoutBadge();
        });

        // Never let badge interactions reach the player underneath.
        ['mousedown', 'click', 'dblclick', 'mouseup', 'pointerdown', 'pointerup',
            'contextmenu', 'wheel', 'dragstart', 'drag', 'drop', 'keydown', 'keyup', 'keypress'
        ].forEach(evt => badge.addEventListener(evt, (e) => e.stopPropagation(), false));
        badge.addEventListener('dragstart', (e) => { e.preventDefault(); e.stopPropagation(); }, false);

        // ── Host positioning (tracks the media element on every frame it moves) ──
        function positionHost() {
            if (!target.isConnected) return false;

            if (!isVideo) {
                host.style.display = '';
                host.style.left = '0px';
                host.style.top = '0px';
                host.style.width = window.innerWidth + 'px';
                host.style.height = window.innerHeight + 'px';
                hostRectCache = {
                    left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight,
                    width: window.innerWidth, height: window.innerHeight
                };
                layoutBadge();
                return true;
            }

            const r = target.getBoundingClientRect();
            const cs = window.getComputedStyle(target);
            const visible = r.width > 0 && r.height > 0 &&
                cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
            const onScreen = r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth;

            if (!visible || !onScreen) {
                host.style.display = 'none';
                return true;
            }

            host.style.display = '';
            host.style.left = r.left + 'px';
            host.style.top = r.top + 'px';
            host.style.width = r.width + 'px';
            host.style.height = r.height + 'px';
            hostRectCache = r;
            layoutBadge();
            return true;
        }

        document.body.appendChild(host);

        const adjustFullscreenParent = () => {
            const fsNode = document.fullscreenElement || document.webkitFullscreenElement;
            if (fsNode && host.parentElement !== fsNode) fsNode.appendChild(host);
            else if (!fsNode && host.parentElement !== document.body) document.body.appendChild(host);
        };
        document.addEventListener('fullscreenchange', adjustFullscreenParent);
        document.addEventListener('webkitfullscreenchange', adjustFullscreenParent);

        document.addEventListener('pointermove', onPointerMove, { passive: true });
        document.addEventListener('pointermove', onPointerNearEdge, { passive: true });
        document.addEventListener('pointerdown', onPointerMove, { passive: true, capture: true });
        scheduleIdleHide();

        let rafPending = false;
        const schedulePosition = () => {
            if (rafPending) return;
            rafPending = true;
            requestAnimationFrame(() => {
                rafPending = false;
                positionHost();
            });
        };
        window.addEventListener('scroll', schedulePosition, { passive: true, capture: true });
        window.addEventListener('resize', schedulePosition, { passive: true });

        let resizeObserver = null;
        if (typeof ResizeObserver !== 'undefined') {
            resizeObserver = new ResizeObserver(schedulePosition);
            resizeObserver.observe(target);
        }

        positionHost();
        setTimeout(positionHost, 50);

        return {
            video: target,
            host,
            syncDisplay,
            position: positionHost,
            layout: layoutBadge,
            refreshSettings() {
                clearTimeout(idleTimer);
                clearTimeout(collapseTimer);
                stripOpen = false;
                hushed = false;
                badge.classList.remove('mc-strip-open');
                badge.classList.remove('mc-hushed');
                layoutBadge();
                scheduleIdleHide();
            },
            destroy() {
                clearTimeout(idleTimer);
                clearTimeout(collapseTimer);
                try { resizeObserver && resizeObserver.disconnect(); } catch (e) { }
                window.removeEventListener('scroll', schedulePosition, { capture: true });
                window.removeEventListener('resize', schedulePosition);
                document.removeEventListener('pointermove', onPointerMove);
                document.removeEventListener('pointermove', onPointerNearEdge);
                document.removeEventListener('pointerdown', onPointerMove, { capture: true });
                document.removeEventListener('click', onOutsideClick, { capture: true });
                document.removeEventListener('fullscreenchange', adjustFullscreenParent);
                document.removeEventListener('webkitfullscreenchange', adjustFullscreenParent);
                try { host.remove(); } catch (e) { }
            }
        };
    }

    function syncOverlay() {
        if (!state.enabled || !settings.showOverlay || !state.primary) {
            destroyOverlay();
            return;
        }
        const target = state.primary;
        if (state.overlay && state.overlay.video === target) {
            state.overlay.position();
            state.overlay.syncDisplay();
            return;
        }
        destroyOverlay();
        try {
            state.overlay = createOverlay(target);
        } catch (e) {
            state.overlay = null;
        }
    }

    // ── Media discovery ─────────────────────────────────────────────────

    const knownShadowRoots = new Set();

    function collectFromRoot(root, out) {
        if (!root || !root.querySelectorAll) return;
        root.querySelectorAll('video, audio').forEach(el => out.add(el));
    }

    function deepQueryMediaAll() {
        const seen = new Set();
        collectFromRoot(document, seen);
        knownShadowRoots.forEach(shadowRoot => collectFromRoot(shadowRoot, seen));
        return Array.from(seen);
    }

    function discoverShadowRoots(root) {
        if (!root || !root.querySelectorAll) return;
        root.querySelectorAll('*').forEach(el => {
            if (!el.shadowRoot) return;
            if (!knownShadowRoots.has(el.shadowRoot)) {
                knownShadowRoots.add(el.shadowRoot);
                observeShadowRoot(el.shadowRoot);
            }
        });
    }

    // ── Primary media selection ─────────────────────────────────────────

    function scoreMedia(media) {
        if (!media.isConnected) return 0;
        if (!media.currentSrc && !media.src && !media.srcObject && media.readyState === 0) return 0;

        if (media.tagName === 'AUDIO') {
            // Audio-only players get a fixed mid score: better than a tiny muted
            // preview, worse than a real, visible video player.
            return 20000;
        }

        const r = media.getBoundingClientRect();
        if (r.width < MIN_VIDEO_W || r.height < MIN_VIDEO_H) return 0;
        if (r.bottom <= 8 || r.right <= 8) return 0;
        if (r.top >= window.innerHeight - 8 || r.left >= window.innerWidth - 8) return 0;

        const cs = window.getComputedStyle(media);
        if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') return 0;
        if (typeof media.checkVisibility === 'function' &&
            !media.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return 0;

        let score = r.width * r.height;
        // Muted videos are almost always previews/ads/background decoration.
        if (media.muted || media.volume === 0) score *= 0.05;
        if (media.paused) score *= 0.9;
        return score;
    }

    function pickPrimary(previous) {
        const candidates = deepQueryMediaAll();
        let best = null;
        let bestScore = 0;
        for (const media of candidates) {
            const score = scoreMedia(media);
            if (score > bestScore) {
                bestScore = score;
                best = media;
            }
        }
        if (!best || bestScore < MIN_PRIMARY_SCORE) return null;

        // Hysteresis: only steal the badge when the challenger is clearly
        // bigger, otherwise a page with two equally sized players flickers.
        if (previous && previous !== best && previous.isConnected) {
            const prevScore = scoreMedia(previous);
            if (prevScore > 0 && bestScore < prevScore * 1.6) return previous;
        }
        return best;
    }

    // ── Applying state to the primary only ──────────────────────────────

    function applyVolume() {
        const media = state.primary;
        if (!media) {
            setGain(1);
            syncOverlay();
            return;
        }
        const info = infoFor(media);
        const vol = state.currentVolume;

        if (info.routed === 'gain') {
            // Already hooked: the gain node is the single source of truth.
            resumeAudioContext();
            setGain(vol);
        } else if (vol > 1.0) {
            // Boost requested — hook the element through Web Audio.
            if (routeViaGain(media)) {
                ourSetVolume(media, info.baseVolume); // gain becomes the only multiplier
                resumeAudioContext();
                setGain(vol);
            }
            // If the element cannot be captured (cross-origin media without CORS,
            // or already owned by another AudioContext) we deliberately leave it
            // alone instead of slamming its element volume to 100 %.
        } else if (vol < 1.0) {
            ourSetVolume(media, vol);
        }
        // vol === 1.0 and not hooked → stay completely passive.

        syncOverlay();
    }

    const _applyingSpeedSet = new WeakSet();
    const _loadingClipSet = new WeakSet();

    function applySpeed() {
        const media = state.primary;
        if (!media) {
            syncOverlay();
            return;
        }
        _applyingSpeedSet.add(media);
        ourSetRate(media, state.currentSpeed);
        Promise.resolve().then(() => _applyingSpeedSet.delete(media));
        syncOverlay();
    }

    // Elements we already pulled a preset for. Re-promoting the same element
    // (e.g. the largest video flapping while scrolling) must not throw away the
    // user's current volume; genuine new clips are handled by `loadstart`.
    const _promotedOnce = new WeakSet();

    function promote(media) {
        log('promote', media.tagName, media.currentSrc);
        infoFor(media);
        attachMediaListeners(media);
        applyVolume();
        applySpeed();

        if (_promotedOnce.has(media)) return;
        _promotedOnce.add(media);
        _loadingClipSet.add(media);
        fetchAndApplyPreset(() => {
            _loadingClipSet.delete(media);
            applySpeed();
        });
    }

    function demote(media) {
        const info = state.mediaInfoMap.get(media);
        if (!info) return;
        if (info.routed === 'gain') routeDirect(media);
        if (info.appliedVolume !== null && Math.abs(media.volume - info.appliedVolume) < 1e-3) {
            safeSetVolume(media, info.baseVolume);
            info.appliedVolume = null;
        }
        if (info.rateApplied && info.appliedRate !== null &&
            Math.abs(media.playbackRate - info.appliedRate) < 1e-3) {
            safeSetRate(media, info.baseRate);
            info.appliedRate = null;
            info.rateApplied = false;
        }
    }

    function refreshPrimary() {
        if (!state.enabled) return;
        const previous = state.primary;
        const next = pickPrimary(previous);

        if (previous && previous !== next) {
            demote(previous);
            state.primary = null;
        }
        if (next && next !== state.primary) {
            state.primary = next;
            promote(next);
        } else if (next && next === state.primary) {
            // Keep the badge glued to it even when nothing else changed.
            syncOverlay();
        }
        if (!next) {
            state.primary = null;
            destroyOverlay();
        }
    }

    // ── Media listeners ─────────────────────────────────────────────────

    const _listening = new WeakSet();

    let _initialLoadGuard = true;
    setTimeout(() => { _initialLoadGuard = false; }, 3000);

    function attachMediaListeners(media) {
        if (_listening.has(media)) return;
        _listening.add(media);

        const syncFromExternal = () => {
            if (media !== state.primary) return;
            if (_applyingSpeedSet.has(media)) return;
            if (_loadingClipSet.has(media)) return;
            if (_initialLoadGuard) return;
            const newRate = media.playbackRate;
            if (Math.abs(newRate - state.currentSpeed) > 0.05) {
                state.currentSpeed = newRate;
                persistState();
                syncOverlay();
            }
        };

        const reApply = () => {
            if (media !== state.primary) return;
            _applyingSpeedSet.add(media);
            safeSetRate(media, state.currentSpeed);
            Promise.resolve().then(() => _applyingSpeedSet.delete(media));
            applyVolume();
        };

        media.addEventListener('ratechange', syncFromExternal);
        media.addEventListener('play', reApply);
        media.addEventListener('loadeddata', reApply);
        media.addEventListener('loadstart', () => {
            if (media !== state.primary) return;
            _loadingClipSet.add(media);
            fetchAndApplyPreset(() => {
                _loadingClipSet.delete(media);
                applySpeed();
            });
        });
    }

    // Global safety net: whenever anything starts playing, re-evaluate who the
    // primary is (a page can swap/insert players without a mutation we see).
    document.addEventListener('play', (e) => {
        if (!state.enabled) return;
        const t = e.target;
        if (!t || (t.tagName !== 'VIDEO' && t.tagName !== 'AUDIO')) return;
        scheduleRefresh();
    }, { capture: true, passive: true });

    document.addEventListener('loadedmetadata', (e) => {
        if (!state.enabled) return;
        const t = e.target;
        if (!t || (t.tagName !== 'VIDEO' && t.tagName !== 'AUDIO')) return;
        scheduleRefresh();
    }, { capture: true, passive: true });

    window.addEventListener('resize', () => { if (state.enabled) scheduleRefresh(); }, { passive: true });

    // ── Throttled refresh ───────────────────────────────────────────────

    let refreshTimer = null;
    function scheduleRefresh(delay) {
        if (refreshTimer) return;
        refreshTimer = setTimeout(() => {
            refreshTimer = null;
            refreshPrimary();
        }, typeof delay === 'number' ? delay : 120);
    }

    // ── Presets / persistence ───────────────────────────────────────────

    function persistState() {
        // The background decides which preset layer records the change (explicit
        // preset first, otherwise the auto-remember scope) and reports it back so
        // the overlay can highlight the right lock button immediately.
        try {
            chrome.runtime.sendMessage({
                action: 'persistState',
                volume: Math.round(state.currentVolume * 100),
                speed: Math.round(state.currentSpeed * SPEED_SCALE)
            }, (response) => {
                void chrome.runtime.lastError; // silence "no receiver" noise
                if (!response || !response.mode) return;
                if (response.mode !== state.activeMode) {
                    state.activeMode = response.mode;
                    syncOverlay();
                }
            });
        } catch (e) { /* extension context is gone */ }
    }

    function setVolume(value) {
        state.currentVolume = clamp(value, 0, MAX_BOOST);
        applyVolume();
        persistState();
        syncOverlay();
    }

    function setSpeed(value) {
        state.currentSpeed = clamp(value, 0.1, 16);
        applySpeed();
        persistState();
        syncOverlay();
    }

    function fetchAndApplyPreset(onDone) {
        let settled = false;
        const settle = () => {
            if (settled) return;
            settled = true;
            if (typeof onDone === 'function') onDone();
        };
        const safetyTimer = setTimeout(settle, 4000);

        chrome.runtime.sendMessage({ action: 'requestInitialState', domain: location.hostname }, (response) => {
            clearTimeout(safetyTimer);
            if (!response || !state.enabled) { settle(); return; }
            if (response.mode !== undefined) state.activeMode = response.mode;
            if (response.volume !== undefined) state.currentVolume = response.volume / 100;
            if (response.speed !== undefined) state.currentSpeed = response.speed / SPEED_SCALE;
            applySpeed();
            applyVolume();
            syncOverlay();

            // Sites such as YouTube overwrite playbackRate right after load.
            // Hold our value for a short window, then release the guard.
            setTimeout(() => { if (state.enabled) applySpeed(); }, 300);
            setTimeout(() => { if (state.enabled) applySpeed(); }, 800);
            setTimeout(() => {
                if (state.enabled) applySpeed();
                settle();
            }, 1200);
        });
    }

    // ── Mutation observation ────────────────────────────────────────────

    const observedShadowRoots = new WeakSet();
    function observeShadowRoot(shadowRoot) {
        if (!shadowRoot || observedShadowRoots.has(shadowRoot)) return;
        observedShadowRoots.add(shadowRoot);
        const observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType !== 1) continue;
                    if (node.nodeName === 'VIDEO' || node.nodeName === 'AUDIO' ||
                        (node.querySelector && node.querySelector('video, audio'))) {
                        scheduleRefresh();
                        return;
                    }
                }
            }
        });
        observer.observe(shadowRoot, { childList: true, subtree: true });
    }

    let domObserver = null;
    function startDomObserver() {
        if (domObserver) return;
        domObserver = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType !== 1) continue;
                    if (node.classList && node.classList.contains('__mc-overlay-host')) continue;
                    if (node.nodeName === 'VIDEO' || node.nodeName === 'AUDIO' ||
                        (node.querySelector && node.querySelector('video, audio'))) {
                        scheduleRefresh();
                        return;
                    }
                    if (node.shadowRoot || node.nodeName.includes('-')) {
                        const tryObserve = (attempts) => {
                            if (node.shadowRoot) {
                                knownShadowRoots.add(node.shadowRoot);
                                observeShadowRoot(node.shadowRoot);
                                scheduleRefresh();
                            } else if (attempts > 0) {
                                setTimeout(() => tryObserve(attempts - 1), 100);
                            }
                        };
                        tryObserve(8);
                    }
                }
            }
        });
        domObserver.observe(document.body || document.documentElement, { childList: true, subtree: true });
    }

    // ── Lifecycle ───────────────────────────────────────────────────────

    let slowScanTimer = null;
    let fastScanTimer = null;
    let urlWatcher = null;

    function startScans() {
        if (fastScanTimer) return;
        let fastCount = 0;
        fastScanTimer = setInterval(() => {
            if (!state.enabled) return;
            refreshPrimary();
            fastCount++;
            if (fastCount >= 12 && fastScanTimer) {
                clearInterval(fastScanTimer);
                fastScanTimer = null;
            }
        }, 2500);

        if (!slowScanTimer) {
            // Cheap ongoing watchdog (one querySelectorAll + a few rect reads).
            slowScanTimer = setInterval(() => {
                if (!state.enabled) return;
                refreshPrimary();
            }, 6000);
        }
    }

    function watchUrlChanges() {
        if (urlWatcher) return;
        let lastUrl = location.href;
        urlWatcher = new MutationObserver(() => {
            if (location.href === lastUrl) return;
            lastUrl = location.href;
            _initialLoadGuard = true;
            setTimeout(() => { _initialLoadGuard = false; }, 3000);
            setTimeout(() => {
                if (!state.enabled) return;
                refreshPrimary();
                fetchAndApplyPreset();
            }, 150);
        });
        urlWatcher.observe(document.body || document.documentElement, { subtree: true, childList: true });
    }

    function activate() {
        if (state.enabled) return;
        state.enabled = true;
        log('activate on', location.hostname);
        _initialLoadGuard = true;
        setTimeout(() => { _initialLoadGuard = false; }, 3000);

        discoverShadowRoots(document);
        startDomObserver();
        watchUrlChanges();
        startScans();
        markPageState();

        refreshPrimary();
        fetchAndApplyPreset();
    }

    function deactivate() {
        if (!state.enabled) return;
        log('deactivate on', location.hostname);
        state.enabled = false;
        if (state.primary) demote(state.primary);
        state.primary = null;
        destroyOverlay();
        markPageState();
        if (fastScanTimer) { clearInterval(fastScanTimer); fastScanTimer = null; }
    }

    // ── Messaging ───────────────────────────────────────────────────────

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (!message || !message.action) return;

        if (message.action === 'setVolume') {
            if (!state.enabled) { sendResponse({ success: false, inactive: true }); return true; }
            setVolume(message.value);
            sendResponse({ success: true });
        } else if (message.action === 'setSpeed') {
            if (!state.enabled) { sendResponse({ success: false, inactive: true }); return true; }
            setSpeed(message.value);
            sendResponse({ success: true });
        } else if (message.action === 'getState') {
            sendResponse({
                volume: Math.round(state.currentVolume * 100),
                speed: Math.round(state.currentSpeed * SPEED_SCALE),
                mode: state.activeMode,
                inactive: !state.enabled,
                siteMode: settings.siteMode,
                hasPrimary: !!state.primary
            });
        } else if (message.action === 'refreshPreset') {
            if (state.enabled) fetchAndApplyPreset();
            sendResponse({ success: true });
        }
        return true;
    });

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (changes.siteMode || changes.whitelist) {
            if (changes.siteMode) settings.siteMode = changes.siteMode.newValue || 'whitelist';
            if (changes.whitelist && Array.isArray(changes.whitelist.newValue)) {
                settings.whitelist = changes.whitelist.newValue;
            }
            settings.loaded = true;
            if (isSiteAllowed()) activate();
            else deactivate();
        }
        if (changes.showOverlay) {
            settings.showOverlay = changes.showOverlay.newValue !== false;
            if (!settings.showOverlay) destroyOverlay();
            else if (state.enabled) syncOverlay();
        }
        if (changes.overlayStyle || changes.autoHide) {
            const nextStyle = changes.overlayStyle && changes.overlayStyle.newValue;
            if (nextStyle === 'strip' || nextStyle === 'pill') settings.overlayStyle = nextStyle;
            const nextAutoHide = changes.autoHide && changes.autoHide.newValue;
            if (typeof nextAutoHide === 'boolean') settings.autoHide = nextAutoHide;
            if (state.overlay && state.overlay.refreshSettings) state.overlay.refreshSettings();
        }
        if (changes.wheelVolumeStep !== undefined || changes.wheelSpeedStep !== undefined) {
            const v = Number(changes.wheelVolumeStep && changes.wheelVolumeStep.newValue);
            const sp = Number(changes.wheelSpeedStep && changes.wheelSpeedStep.newValue);
            if (WHEEL_STEPS.includes(v)) settings.wheelVolumeStep = v;
            if (WHEEL_STEPS.includes(sp)) settings.wheelSpeedStep = sp;
        }
    });

    // ── Boot ────────────────────────────────────────────────────────────

    loadSettings().then(() => {
        state.initialised = true;
        if (isSiteAllowed()) activate();
        else log('site not in whitelist:', location.hostname);
    });
})();
