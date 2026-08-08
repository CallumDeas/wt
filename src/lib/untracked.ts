import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import * as output from "./output.js";

const GENERATED_DIRS = new Set([
    "node_modules",
    "dist",
    "build",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".turbo",
    ".cache",
    ".expo",
    "coverage",
    "out",
    ".parcel-cache",
    "storybook-static",
]);

function isGenerated(filePath: string): boolean {
    return filePath.split("/").some((segment) => GENERATED_DIRS.has(segment));
}

/*
 * A monorepo's ignored listing is dominated by node_modules — 6.5MB of paths in
 * a mid-sized pnpm workspace. spawnSync's default maxBuffer is 1MB, and on
 * overflow it kills git, returns truncated stdout and sets status to null, which
 * the old `status !== 0 → []` read as "no untracked files". Every .env was then
 * silently dropped. Keep the ceiling high enough that real repos never reach it,
 * and never treat a failure as an empty result.
 */
const LS_FILES_MAX_BUFFER = 256 * 1024 * 1024;

function lsFiles(dir: string, args: string[]): string[] {
    const result = spawnSync("git", ["-C", dir, "ls-files", ...args], {
        encoding: "utf-8",
        maxBuffer: LS_FILES_MAX_BUFFER,
    });

    // stdout is truncated when the buffer overflows, so it is not a usable
    // partial result — report the failure rather than copying a random subset.
    if (result.error || result.status !== 0) {
        const reason = result.error?.message ?? result.stderr?.trim() ?? `git ls-files exited ${result.status}`;
        output.warn(`Could not list untracked files (${reason})`);
        output.warn("Untracked files such as .env were NOT copied — move them across manually.");
        return [];
    }

    return result.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
}

/** Returns untracked files (both gitignored and non-ignored) relative to dir, excluding generated dirs. */
export function collectUntrackedFiles(dir: string): string[] {
    const untracked = lsFiles(dir, ["--others", "--exclude-standard"]);
    const ignored = lsFiles(dir, ["--others", "--ignored", "--exclude-standard"]);
    const all = [...new Set([...untracked, ...ignored])];
    return all.filter((f) => !isGenerated(f));
}

/**
 * Copy untracked files (e.g. .env) from the default branch worktree into a new worktree.
 * No-ops if the default worktree directory doesn't exist yet.
 */
export function copyUntrackedFromDefault(root: string, defBranch: string, worktreeDir: string): void {
    const defWorktreeDir = join(root, defBranch);
    if (!existsSync(defWorktreeDir)) return;
    const files = collectUntrackedFiles(defWorktreeDir);
    const copied = copyUntrackedFiles(defWorktreeDir, worktreeDir, files);
    if (copied.length > 0) {
        output.success(`Copied ${copied.length} untracked file(s) from ${defBranch}/`);
        for (const f of copied) output.dim(`  ${f}`);
    } else if (files.length > 0) {
        output.warn(`Found ${files.length} untracked file(s) in ${defBranch}/ but copied none.`);
    }
}

/** Copies files (relative paths) from srcDir to destDir, preserving directory structure. Returns copied paths. */
export function copyUntrackedFiles(srcDir: string, destDir: string, files: string[]): string[] {
    const copied: string[] = [];
    for (const file of files) {
        const src = join(srcDir, file);
        const dest = join(destDir, file);
        try {
            mkdirSync(dirname(dest), { recursive: true });
            cpSync(src, dest, { recursive: true });
            copied.push(file);
        } catch {
            // Skip files that can't be copied (e.g. deleted between collection and copy)
        }
    }
    return copied;
}
