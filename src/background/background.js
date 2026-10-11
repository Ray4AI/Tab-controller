// Sites that get the extension when the whitelist scope is enabled.
// Kept in sync with src/content/content.js.
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

// Seed the default activation scope on install/update. Existing user values are
// never touched.
chrome.runtime.onInstalled.addListener(() => {
    chrome.storage.local.get(['siteMode', 'whitelist', 'showOverlay', 'autoRemember'], (result) => {
        const updates = {};
        if (!result.siteMode) updates.siteMode = 'whitelist';
        if (!Array.isArray(result.whitelist)) updates.whitelist = DEFAULT_WHITELIST;
        if (typeof result.showOverlay !== 'boolean') updates.showOverlay = true;
        if (!result.autoRemember) updates.autoRemember = 'domain';
        if (Object.keys(updates).length) chrome.storage.local.set(updates);
    });
});

// Clean up storage variables when a tab is actively closed
chrome.tabs.onRemoved.addListener((tabId) => {
    chrome.storage.local.remove([
        `tab_volume_${tabId}`,
        `tab_speed_${tabId}`,
        `saved_tab_${tabId}`
    ]);
});

// Handle requests from content script and popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'persistState' && sender.tab) {
        const tabId = sender.tab.id;
        let domain = '';
        try {
            if (sender.tab.url) domain = new URL(sender.tab.url).hostname;
        } catch (e) { }

        const tabKey = `saved_tab_${tabId}`;
        const domainKey = `saved_domain_${domain}`;
        const globalKey = 'saved_global';

        // Single read, then single write — avoids race conditions
        chrome.storage.local.get([tabKey, domainKey, globalKey, 'autoRemember'], (result) => {
            const payload = {
                volume: message.volume !== undefined ? message.volume : 100,
                speed: message.speed !== undefined ? message.speed : 100
            };

            const updates = {};
            if (message.volume !== undefined) updates[`tab_volume_${tabId}`] = message.volume;
            if (message.speed !== undefined) updates[`tab_speed_${tabId}`] = message.speed;

            // Decide which preset layer records this change.
            //   1. an explicitly saved preset always wins,
            //   2. otherwise the auto-remember scope decides (off / this site / everywhere).
            const auto = result.autoRemember || 'domain';
            let mode = 'none';
            if (result[tabKey]) mode = 'tab';
            else if (domain && result[domainKey]) mode = 'domain';
            else if (result[globalKey]) mode = 'global';

            if (auto === 'global') {
                // "Everywhere" never keeps a per-site layer around.
                mode = 'global';
            } else if (auto === 'domain' && domain && mode !== 'tab') {
                // "This site" promotes a global preset to a per-site one so a new
                // tab of this site reuses exactly these values.
                mode = 'domain';
            }

            if (mode === 'tab') updates[tabKey] = payload;
            else if (mode === 'domain') updates[domainKey] = payload;
            else if (mode === 'global') updates[globalKey] = payload;

            chrome.storage.local.set(updates, () => sendResponse({ success: true, mode }));
        });
        return true;
    }

    if (message.action === 'requestInitialState' && sender.tab) {
        const tabId = sender.tab.id;
        let domain = message.domain || '';
        try {
            if (!domain && sender.tab.url) domain = new URL(sender.tab.url).hostname;
        } catch (e) { }

        const liveVolKey = `tab_volume_${tabId}`;
        const liveSpeedKey = `tab_speed_${tabId}`;
        const tabKey = `saved_tab_${tabId}`;
        const domainKey = `saved_domain_${domain}`;
        const globalKey = 'saved_global';

        chrome.storage.local.get([liveVolKey, liveSpeedKey, tabKey, domainKey, globalKey], (result) => {
            const hasTabPreset = !!result[tabKey];
            const hasDomainPreset = !!(domain && result[domainKey]);
            const hasGlobalPreset = !!result[globalKey];
            const hasActivePreset = hasTabPreset || hasDomainPreset || hasGlobalPreset;

            let activeMode = 'none';
            if (hasTabPreset) activeMode = 'tab';
            else if (hasDomainPreset) activeMode = 'domain';
            else if (hasGlobalPreset) activeMode = 'global';

            if (!hasActivePreset) {
                // Default mode: always reset to baseline and clear per-tab temporary state.
                chrome.storage.local.remove([liveVolKey, liveSpeedKey], () => {
                    sendResponse({ volume: 100, speed: 100, mode: activeMode });
                });
            } else if (hasTabPreset) {
                // Always use preset values — never the ephemeral live keys when a preset is
                // active.  The live keys can be polluted by site-driven resets (e.g. YouTube
                // resetting playbackRate on every new clip) before fetchAndApplyPreset runs.
                sendResponse({ volume: result[tabKey].volume, speed: result[tabKey].speed, mode: activeMode });
            } else if (hasDomainPreset) {
                sendResponse({ volume: result[domainKey].volume, speed: result[domainKey].speed, mode: activeMode });
            } else if (hasGlobalPreset) {
                sendResponse({ volume: result[globalKey].volume, speed: result[globalKey].speed, mode: activeMode });
            } else {
                // Safety fallback: reset to baseline.
                sendResponse({ volume: 100, speed: 100, mode: activeMode });
            }
        });
        return true; // Keep channel open for async response
    }

    if (message.action === 'setMode') {
        const tabId = sender.tab.id;
        let domain = '';
        try {
            if (sender.tab.url) domain = new URL(sender.tab.url).hostname;
        } catch (e) { }

        const tabKey = `saved_tab_${tabId}`;
        const domainKey = `saved_domain_${domain}`;
        const globalKey = 'saved_global';
        const payload = { volume: message.volume, speed: message.speed };

        if (message.mode === 'tab') {
            // Auto-switch: Tab is highest, no need to clear anything
            chrome.storage.local.set({ [tabKey]: payload }, () => sendResponse({ success: true }));
        } else if (message.mode === 'domain' && domain) {
            // Auto-switch: Clear Tab preset so Domain can take over immediately
            chrome.storage.local.remove([tabKey], () => {
                chrome.storage.local.set({ [domainKey]: payload }, () => sendResponse({ success: true }));
            });
        } else if (message.mode === 'global') {
            // Auto-switch: Clear Tab and Domain presets so Global can take over immediately
            chrome.storage.local.remove([tabKey, domainKey], () => {
                chrome.storage.local.set({ [globalKey]: payload }, () => sendResponse({ success: true }));
            });
        } else if (message.mode === 'clear') {
            // Smart clear: remove only the highest-priority active layer so the page
            // falls back to the next layer rather than resetting to defaults.
            chrome.storage.local.get([tabKey, domainKey, globalKey], (result) => {
                let keyToRemove = null;
                if (result[tabKey])                      keyToRemove = tabKey;
                else if (domain && result[domainKey])    keyToRemove = domainKey;
                else if (result[globalKey])              keyToRemove = globalKey;

                if (keyToRemove) {
                    chrome.storage.local.remove([keyToRemove], () => sendResponse({ success: true }));
                } else {
                    sendResponse({ success: true });
                }
            });
            return true; // keep async channel open
        } else {
            sendResponse({ success: true });
        }
        return true;
    }
});
