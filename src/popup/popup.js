document.addEventListener('DOMContentLoaded', () => {
    // ── Theme ───────────────────────────────────────────────────────────
    const themeToggle = document.getElementById('themeToggle');
    const rootElement = document.documentElement;

    chrome.storage.local.get(['themePref'], (result) => {
        if (result.themePref === 'light') {
            rootElement.setAttribute('data-theme', 'light');
            themeToggle.checked = false;
        } else {
            themeToggle.checked = true;
        }
    });

    themeToggle.addEventListener('change', (e) => {
        const newTheme = e.target.checked ? 'dark' : 'light';
        if (newTheme === 'light') rootElement.setAttribute('data-theme', 'light');
        else rootElement.removeAttribute('data-theme');
        chrome.storage.local.set({ themePref: newTheme });
    });

    // ── Elements ────────────────────────────────────────────────────────
    const volSlider = document.getElementById('volumeSlider');
    const volValueDisplay = document.getElementById('volumeValue');
    const btnVolReset = document.getElementById('btnVolReset');
    const btnVolMute = document.getElementById('btnVolMute');

    const speedSlider = document.getElementById('speedSlider');
    const speedValueDisplay = document.getElementById('speedValue');
    const btnSpeedReset = document.getElementById('btnSpeedReset');
    const btnSpeedFast = document.getElementById('btnSpeedFast');

    const btnSaveTab = document.getElementById('btnSaveTab');
    const btnSaveDomain = document.getElementById('btnSaveDomain');
    const btnSaveGlobal = document.getElementById('btnSaveGlobal');
    const btnClearPreset = document.getElementById('btnClearPreset');
    const saveStatusBadge = document.getElementById('saveStatusBadge');
    const saveInfo = document.getElementById('saveInfo');

    const segWhitelist = document.getElementById('segWhitelist');
    const segAll = document.getElementById('segAll');
    const siteStatusBadge = document.getElementById('siteStatusBadge');
    const currentHostLabel = document.getElementById('currentHostLabel');
    const btnToggleSite = document.getElementById('btnToggleSite');
    const whitelistArea = document.getElementById('whitelistArea');
    const newHostInput = document.getElementById('newHostInput');
    const btnAddHost = document.getElementById('btnAddHost');
    const hostChips = document.getElementById('hostChips');
    const btnToggleOverlay = document.getElementById('btnToggleOverlay');
    const btnResetBadge = document.getElementById('btnResetBadge');

    const autoSeg = document.getElementById('autoSeg');
    const autoHint = document.getElementById('autoHint');

    // ── Auto-remember scope ─────────────────────────────────────────────
    const AUTO_HINTS = {
        off: 'Settings stay temporary — every new video starts at 100%.',
        domain: 'New tabs of this site reopen with the same volume & speed.',
        global: 'Every site you adjust is remembered everywhere.'
    };

    function renderAuto(value) {
        const mode = AUTO_HINTS[value] ? value : 'domain';
        autoSeg.querySelectorAll('.seg-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.auto === mode);
        });
        autoHint.textContent = AUTO_HINTS[mode];
    }

    autoSeg.addEventListener('click', (e) => {
        const btn = e.target.closest('.seg-btn');
        if (!btn) return;
        const value = btn.dataset.auto;
        renderAuto(value);
        chrome.storage.local.set({ autoRemember: value });
    });

    // ── Site scope helpers ──────────────────────────────────────────────
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

    const scope = {
        siteMode: 'whitelist',
        whitelist: [],
        showOverlay: true
    };

    let currentHost = '';
    let currentTabId = null;
    let domain = '';
    let modeKeys = null;

    function isAllowedHere() {
        if (!currentHost) return false;
        if (scope.siteMode !== 'whitelist') return true;
        return scope.whitelist.some(entry => hostMatches(currentHost, entry));
    }

    function saveScope(updates) {
        Object.assign(scope, updates);
        chrome.storage.local.set(updates, renderScope);
    }

    function renderScope() {
        const whitelistMode = scope.siteMode === 'whitelist';
        segWhitelist.classList.toggle('active', whitelistMode);
        segAll.classList.toggle('active', !whitelistMode);
        whitelistArea.style.display = whitelistMode ? '' : 'none';

        const allowed = isAllowedHere();

        if (!currentHost) {
            siteStatusBadge.textContent = 'NO SITE';
            siteStatusBadge.className = 'save-badge save-badge--off';
            currentHostLabel.textContent = 'This page has no addressable host';
            btnToggleSite.disabled = true;
            btnToggleSite.style.opacity = '0.5';
        } else {
            const listed = scope.whitelist.some(entry => hostMatches(currentHost, entry));
            siteStatusBadge.textContent = allowed ? 'ACTIVE HERE' : 'INACTIVE HERE';
            siteStatusBadge.className = 'save-badge ' + (allowed ? 'save-badge--on' : 'save-badge--off');
            currentHostLabel.textContent = currentHost;
            btnToggleSite.disabled = false;
            btnToggleSite.style.opacity = '';
            btnToggleSite.textContent = listed ? 'Remove' : 'Allow';
        }

        btnToggleOverlay.textContent = scope.showOverlay ? 'Hide badge' : 'Show badge';

        // Chips
        while (hostChips.firstChild) hostChips.removeChild(hostChips.firstChild);
        if (!scope.whitelist.length) {
            const empty = document.createElement('div');
            empty.className = 'chip-empty';
            empty.textContent = 'No sites yet — the extension stays off everywhere.';
            hostChips.appendChild(empty);
        } else {
            scope.whitelist.forEach(entry => {
                const chip = document.createElement('div');
                chip.className = 'chip';
                const label = document.createElement('span');
                label.textContent = entry;
                const remove = document.createElement('button');
                remove.textContent = '\u2715';
                remove.title = `Remove ${entry}`;
                remove.addEventListener('click', () => {
                    saveScope({ whitelist: scope.whitelist.filter(item => item !== entry) });
                });
                chip.append(label, remove);
                hostChips.appendChild(chip);
            });
        }
    }

    function addHost(rawValue) {
        const host = normalizeHost(rawValue);
        // Accept regular host names, IP addresses and single-label hosts (localhost).
        if (!host || !/^[a-z0-9][a-z0-9.-]*$/.test(host)) return false;
        if (scope.whitelist.some(entry => entry === host)) return true;
        saveScope({ whitelist: scope.whitelist.concat([host]) });
        return true;
    }

    segWhitelist.addEventListener('click', () => saveScope({ siteMode: 'whitelist' }));
    segAll.addEventListener('click', () => saveScope({ siteMode: 'all' }));

    btnToggleSite.addEventListener('click', () => {
        if (!currentHost) return;
        const listed = scope.whitelist.some(entry => hostMatches(currentHost, entry));
        if (listed) {
            saveScope({ whitelist: scope.whitelist.filter(entry => !hostMatches(currentHost, entry)) });
        } else {
            addHost(currentHost);
        }
    });

    btnAddHost.addEventListener('click', () => {
        if (addHost(newHostInput.value)) newHostInput.value = '';
    });
    newHostInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            if (addHost(newHostInput.value)) newHostInput.value = '';
        }
    });

    btnToggleOverlay.addEventListener('click', () => {
        saveScope({ showOverlay: !scope.showOverlay });
    });

    btnResetBadge.addEventListener('click', () => {
        if (!currentHost) return;
        chrome.storage.local.remove([`overlay_pos_${currentHost}`]);
    });

    // ── Presets ─────────────────────────────────────────────────────────
    function getCurrentPreset(tabKey, domainKey, globalKey, callback) {
        chrome.storage.local.get([tabKey, domainKey, globalKey], (result) => {
            if (result[tabKey]) return callback('tab');
            if (domain && result[domainKey]) return callback('domain');
            if (result[globalKey]) return callback('global');
            callback('none');
        });
    }

    function syncActivePreset(mode, tabKey, domainKey, globalKey, volume, speed) {
        if (mode === 'none') return;
        const payload = { volume, speed };
        if (mode === 'tab') chrome.storage.local.set({ [tabKey]: payload });
        else if (mode === 'domain') chrome.storage.local.set({ [domainKey]: payload });
        else if (mode === 'global') chrome.storage.local.set({ [globalKey]: payload });
    }

    // Shared communication logic
    function sendToContentScript(action, value, tabId, storageKey, keys) {
        const data = {};
        data[storageKey] = value;
        chrome.storage.local.set(data);

        if (keys) {
            const currentVolume = parseInt(volSlider.value, 10);
            const currentSpeed = parseInt(speedSlider.value, 10);
            getCurrentPreset(keys.tabKey, keys.domainKey, keys.globalKey, (mode) => {
                syncActivePreset(mode, keys.tabKey, keys.domainKey, keys.globalKey, currentVolume, currentSpeed);
            });
        }

        const convertedValue = action === 'setVolume' ? parseInt(value, 10) / 100 : parseFloat(value) / 100;

        chrome.tabs.sendMessage(tabId, {
            action: action,
            value: convertedValue
        }).catch(() => {
            // First time script injection fallback
            chrome.scripting.executeScript({
                target: { tabId: tabId, allFrames: true },
                files: ['src/content/content.js']
            }).then(() => {
                chrome.tabs.sendMessage(tabId, { action: action, value: convertedValue });
            }).catch((e) => console.error('Could not inject script: ', e));
        });
    }

    // Trigger UI updates
    function updateVolume(vol, tabId, keys) {
        const volInt = parseInt(vol, 10);
        volSlider.value = volInt;
        volValueDisplay.textContent = volInt + '%';

        if (volInt === 0) {
            btnVolMute.classList.add('muted');
            btnVolMute.textContent = 'Muted';
        } else {
            btnVolMute.classList.remove('muted');
            btnVolMute.textContent = 'Mute';
        }

        sendToContentScript('setVolume', volInt, tabId, `tab_volume_${tabId}`, keys);
    }

    function updateSpeed(speedScaled, tabId, keys) {
        const speedInt = parseInt(speedScaled, 10);
        speedSlider.value = speedInt;
        speedValueDisplay.textContent = (speedInt / 100).toFixed(2) + 'x';
        sendToContentScript('setSpeed', speedInt, tabId, `tab_speed_${tabId}`, keys);
    }

    function applyToUI(vol, speed) {
        const volInt = parseInt(vol, 10);
        volSlider.value = volInt;
        volValueDisplay.textContent = volInt + '%';

        if (volInt === 0) {
            btnVolMute.classList.add('muted');
            btnVolMute.textContent = 'Muted';
        } else {
            btnVolMute.classList.remove('muted');
            btnVolMute.textContent = 'Mute';
        }

        const speedInt = parseInt(speed, 10);
        speedSlider.value = speedInt;
        speedValueDisplay.textContent = (speedInt / 100).toFixed(2) + 'x';
    }

    // ── Boot ────────────────────────────────────────────────────────────
    chrome.storage.local.get(['siteMode', 'whitelist', 'showOverlay', 'autoRemember'], (result) => {
        scope.siteMode = result.siteMode || 'whitelist';
        scope.whitelist = Array.isArray(result.whitelist) ? result.whitelist : [];
        scope.showOverlay = result.showOverlay !== false;
        renderAuto(result.autoRemember || 'domain');
        renderScope();
    });

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs.length === 0) return;
        const activeTab = tabs[0];
        const tabId = activeTab.id;
        currentTabId = tabId;

        try {
            if (activeTab.url) {
                const parsed = new URL(activeTab.url);
                if (parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'file:') {
                    domain = parsed.hostname;
                    currentHost = normalizeHost(parsed.hostname);
                }
            }
        } catch (e) { }

        renderScope();

        // Storage keys for this tab/site
        const tabKey = `saved_tab_${tabId}`;
        const domainKey = `saved_domain_${domain}`;
        const globalKey = 'saved_global';
        const keys = { tabKey, domainKey, globalKey };
        modeKeys = keys;

        // 1. Load contextually: saved tab / domain / global preset
        function loadContext() {
            chrome.storage.local.get([tabKey, domainKey, globalKey], (result) => {
                let vol = 100;
                let speed = 100;

                if (result[tabKey]) {
                    vol = result[tabKey].volume;
                    speed = result[tabKey].speed;
                } else if (domain && result[domainKey]) {
                    vol = result[domainKey].volume;
                    speed = result[domainKey].speed;
                } else if (result[globalKey]) {
                    vol = result[globalKey].volume;
                    speed = result[globalKey].speed;
                }

                applyToUI(vol, speed);
                updateSaveUI();
            });
        }

        // Prefer the live state reported by the content script
        chrome.tabs.sendMessage(tabId, { action: 'getState' })
            .then((response) => {
                if (response && response.volume !== undefined) {
                    applyToUI(response.volume, response.speed);
                    if (response.mode !== undefined) {
                        // keep the content script and popup in agreement
                        void response.mode;
                    }
                    updateSaveUI();
                } else {
                    loadContext();
                }
            })
            .catch(() => loadContext());

        // Live sync: listen for updates coming from the overlay
        chrome.runtime.onMessage.addListener((message) => {
            if (message.action === 'persistState') {
                applyToUI(message.volume, message.speed);
            }
        });

        // Sync save UI when the overlay changes mode (storage keys change)
        chrome.storage.onChanged.addListener((changes, areaName) => {
            if (areaName !== 'local') return;
            const relevant = [tabKey, domainKey, globalKey];
            if (relevant.some(k => k in changes)) updateSaveUI();
        });

        // Event listeners
        volSlider.addEventListener('input', (e) => updateVolume(e.target.value, tabId, keys));
        btnVolReset.addEventListener('click', () => updateVolume(100, tabId, keys));
        btnVolMute.addEventListener('click', () => {
            const currentVol = parseInt(volSlider.value, 10);
            updateVolume(currentVol === 0 ? 100 : 0, tabId, keys);
        });

        speedSlider.addEventListener('input', (e) => updateSpeed(e.target.value, tabId, keys));
        btnSpeedReset.addEventListener('click', () => updateSpeed(100, tabId, keys));
        btnSpeedFast.addEventListener('click', () => updateSpeed(200, tabId, keys));

        function updateSaveUI() {
            chrome.storage.local.get([tabKey, domainKey, globalKey], (result) => {
                [btnSaveTab, btnSaveDomain, btnSaveGlobal].forEach(btn => btn.classList.remove('active'));

                if (result[tabKey]) {
                    saveStatusBadge.textContent = 'TAB SAVED';
                    saveStatusBadge.className = 'save-badge save-badge--tab';
                    saveInfo.textContent = 'Locked settings to this specific tab.';
                    btnSaveTab.classList.add('active');
                } else if (domain && result[domainKey]) {
                    saveStatusBadge.textContent = 'DOMAIN SAVED';
                    saveStatusBadge.className = 'save-badge save-badge--domain';
                    saveInfo.textContent = `Locked for all ${domain} pages.`;
                    btnSaveDomain.classList.add('active');
                } else if (result[globalKey]) {
                    saveStatusBadge.textContent = 'GLOBAL SAVED';
                    saveStatusBadge.className = 'save-badge save-badge--global';
                    saveInfo.textContent = 'Locked for all sites.';
                    btnSaveGlobal.classList.add('active');
                } else {
                    saveStatusBadge.textContent = 'NO PRESET';
                    saveStatusBadge.className = 'save-badge save-badge--none';
                    saveInfo.textContent = 'Adjusting a slider saves it for this site automatically.';
                }
            });
        }

        const notifyOverlay = () => {
            chrome.tabs.sendMessage(tabId, { action: 'refreshPreset' }).catch(() => { });
        };

        btnSaveTab.addEventListener('click', () => {
            const payload = { [tabKey]: { volume: parseInt(volSlider.value, 10), speed: parseInt(speedSlider.value, 10) } };
            chrome.storage.local.set(payload, () => { updateSaveUI(); notifyOverlay(); });
        });

        btnSaveDomain.addEventListener('click', () => {
            if (!domain) return;
            const payload = { [domainKey]: { volume: parseInt(volSlider.value, 10), speed: parseInt(speedSlider.value, 10) } };
            chrome.storage.local.remove([tabKey], () => {
                chrome.storage.local.set(payload, () => { updateSaveUI(); notifyOverlay(); });
            });
        });

        btnSaveGlobal.addEventListener('click', () => {
            const payload = { [globalKey]: { volume: parseInt(volSlider.value, 10), speed: parseInt(speedSlider.value, 10) } };
            chrome.storage.local.remove([tabKey, domainKey], () => {
                chrome.storage.local.set(payload, () => { updateSaveUI(); notifyOverlay(); });
            });
        });

        btnClearPreset.addEventListener('click', () => {
            // Smart clear: only remove the highest-priority active layer so the page
            // falls back to the next layer (Tab -> Domain -> Global -> default).
            chrome.storage.local.get([tabKey, domainKey, globalKey], (result) => {
                let keyToRemove = null;
                if (result[tabKey]) keyToRemove = tabKey;
                else if (domain && result[domainKey]) keyToRemove = domainKey;
                else if (result[globalKey]) keyToRemove = globalKey;

                if (keyToRemove) {
                    chrome.storage.local.remove([keyToRemove], () => { updateSaveUI(); notifyOverlay(); });
                } else {
                    updateSaveUI();
                }
            });
        });
    });
});
