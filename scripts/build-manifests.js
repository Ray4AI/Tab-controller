const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const sourceManifestPath = path.join(rootDir, 'manifest.json');
const distDir = path.join(rootDir, 'dist');

function readSourceManifest() {
    return JSON.parse(fs.readFileSync(sourceManifestPath, 'utf8'));
}

function writeManifest(target, manifest) {
    const targetDir = path.join(distDir, target);
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(
        path.join(targetDir, 'manifest.json'),
        JSON.stringify(manifest, null, 2) + '\n'
    );
}

function buildChromeManifest(source) {
    const manifest = structuredClone(source);
    manifest.background = {
        service_worker: source.background.service_worker
    };
    // Chrome has no notion of gecko settings and an `update_url` would make it
    // look for a non-store update manifest, so drop the whole block.
    delete manifest.browser_specific_settings;
    return manifest;
}

function buildFirefoxManifest(source) {
    const manifest = structuredClone(source);
    manifest.background = {
        scripts: source.background.scripts || [source.background.service_worker]
    };
    return manifest;
}

function validateChromeManifest(manifest) {
    if (manifest.manifest_version !== 3) throw new Error('Chrome manifest must use Manifest V3.');
    if (!manifest.background || !manifest.background.service_worker) {
        throw new Error('Chrome Manifest V3 requires background.service_worker.');
    }
    if ('scripts' in manifest.background) {
        throw new Error('Chrome Manifest V3 output must not include background.scripts.');
    }
}

function validateFirefoxManifest(manifest) {
    if (!manifest.background || !Array.isArray(manifest.background.scripts) || manifest.background.scripts.length === 0) {
        throw new Error('Firefox output must include background.scripts.');
    }
}

const source = readSourceManifest();
const chromeManifest = buildChromeManifest(source);
const firefoxManifest = buildFirefoxManifest(source);

validateChromeManifest(chromeManifest);
validateFirefoxManifest(firefoxManifest);

writeManifest('chrome', chromeManifest);
writeManifest('firefox', firefoxManifest);

console.log('✅ Built browser-specific manifests in dist/chrome and dist/firefox');
