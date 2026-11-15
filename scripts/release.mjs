#!/usr/bin/env node
// Build the Windows installer and publish it as a GitHub release, which installed copies of Orrery
// pick up through Settings → Updates.
//
//   npm version patch      (or minor / major: bumps package.json, commits and tags vX.Y.Z)
//   npm run release        (checks, pushes the commit and tag, builds, uploads the release)
//
// Uses your existing GitHub CLI sign-in (`gh auth login`); the token is handed to electron-builder
// through the environment only and never printed or written to disk.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const sh = (cmd, args, opts = {}) => (execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }) ?? "").trim();
const fail = (msg) => {
    console.error(`release: ${msg}`);
    process.exit(1);
};

const { version, build } = JSON.parse(readFileSync("package.json", "utf8"));
const tag = `v${version}`;
const gh = build.publish?.find?.((p) => p.provider === "github");
if (!gh) fail("package.json build.publish has no GitHub entry.");

if (sh("git", ["status", "--porcelain"])) fail("the working tree has uncommitted changes. Commit them first.");
if (!sh("git", ["tag", "--list", tag])) fail(`there is no ${tag} tag. Run \`npm version patch\` (or minor/major) first.`);
if (sh("git", ["rev-parse", `${tag}^{commit}`]) !== sh("git", ["rev-parse", "HEAD"])) fail(`${tag} doesn't point at the current commit.`);
if (!existsSync("public/models")) fail("speech models are missing. Run `npm run models` first.");

let token;
try {
    token = sh("gh", ["auth", "token"]);
} catch {
    fail("GitHub CLI isn't signed in. Run `gh auth login`.");
}
const existing = spawnSync("gh", ["release", "view", tag, "--repo", `${gh.owner}/${gh.repo}`], { stdio: "ignore" });
if (existing.status === 0) fail(`release ${tag} already exists on GitHub. Bump the version.`);

console.log(`Pushing ${tag}…`);
sh("git", ["push", "origin", "HEAD", tag], { stdio: "inherit" });

const run = (args) => {
    const r = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", args, { stdio: "inherit", shell: process.platform === "win32", env: { ...process.env, GH_TOKEN: token } });
    if (r.status !== 0) fail(`\`npm ${args.join(" ")}\` failed.`);
};
console.log(`Building and publishing Orrery ${version}…`);
run(["run", "licenses"]);
run(["run", "build"]);
run(["exec", "--", "electron-builder", "--win", "--x64", "--publish", "always"]);
console.log(`\nPublished: https://github.com/${gh.owner}/${gh.repo}/releases/tag/${tag}`);
