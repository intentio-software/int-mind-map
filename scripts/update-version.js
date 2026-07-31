#!/usr/bin/env node
// Bumps the version in package.json (via npm), tauri.conf.json, and both
// Cargo.toml files — the app's and the standalone MCP crate's.
// Called by semantic-release's prepareCmd with the next version as the first argument.
const { execSync } = require('child_process');
const fs = require('fs');

const version = process.argv[2];
if (!version) {
  console.error('Usage: update-version.js <version>');
  process.exit(1);
}

// npm handles package.json + package-lock.json
execSync(`npm version ${version} --no-git-tag-version`, { stdio: 'inherit' });

// tauri.conf.json
const tauriConf = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'));
tauriConf.version = version;
fs.writeFileSync('src-tauri/tauri.conf.json', JSON.stringify(tauriConf, null, 2) + '\n');

// Cargo.toml — replace only the [package] version line.
//
// Both manifests are bumped. The MCP crate is not a workspace member (this app
// deliberately has no root workspace), so nothing bumps it implicitly, and it
// otherwise sits at its initial version forever while the app moves on.
for (const manifest of ['src-tauri/Cargo.toml', 'crates/int-mindmap-mcp/Cargo.toml']) {
  const cargo = fs.readFileSync(manifest, 'utf8');
  const bumped = cargo.replace(/^version = ".*"/m, `version = "${version}"`);
  if (bumped === cargo) {
    console.error(`Could not find a version line in ${manifest}`);
    process.exit(1);
  }
  fs.writeFileSync(manifest, bumped);
}

console.log(`Bumped all version files to ${version}`);
