#!/usr/bin/env node
// Bumps the version in package.json (via npm), tauri.conf.json, and Cargo.toml.
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

// Cargo.toml — replace only the [package] version line
let cargo = fs.readFileSync('src-tauri/Cargo.toml', 'utf8');
cargo = cargo.replace(/^version = ".*"/m, `version = "${version}"`);
fs.writeFileSync('src-tauri/Cargo.toml', cargo);

console.log(`Bumped all version files to ${version}`);
