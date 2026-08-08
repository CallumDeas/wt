import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectUntrackedFiles, copyUntrackedFiles } from "../../src/lib/untracked.js";

const GIT_ENV = {
    GIT_AUTHOR_NAME: "Test User",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test User",
    GIT_COMMITTER_EMAIL: "test@example.com",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
};

function git(args: string[], cwd: string): void {
    const result = spawnSync("git", args, { cwd, env: { ...process.env, ...GIT_ENV }, encoding: "utf-8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
}

function makeGitRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "wt-untracked-test-"));
    git(["init", "-b", "main"], dir);
    writeFileSync(join(dir, "README.md"), "# test\n");
    git(["add", "README.md"], dir);
    git(["commit", "-m", "init"], dir);
    return dir;
}

describe("collectUntrackedFiles", () => {
    let repoDir: string;

    beforeEach(() => {
        repoDir = makeGitRepo();
    });

    afterEach(() => {
        rmSync(repoDir, { recursive: true, force: true });
    });

    it("returns gitignored files", () => {
        writeFileSync(join(repoDir, ".gitignore"), ".env\n");
        git(["add", ".gitignore"], repoDir);
        git(["commit", "-m", "add gitignore"], repoDir);
        writeFileSync(join(repoDir, ".env"), "SECRET=abc\n");

        const files = collectUntrackedFiles(repoDir);
        expect(files).toContain(".env");
    });

    it("returns untracked non-ignored files", () => {
        writeFileSync(join(repoDir, "local.config"), "key=val\n");

        const files = collectUntrackedFiles(repoDir);
        expect(files).toContain("local.config");
    });

    it("excludes node_modules", () => {
        mkdirSync(join(repoDir, "node_modules", "some-pkg"), { recursive: true });
        writeFileSync(join(repoDir, "node_modules", "some-pkg", "index.js"), "");

        const files = collectUntrackedFiles(repoDir);
        expect(files.some((f) => f.includes("node_modules"))).toBe(false);
    });

    it("excludes other generated dirs", () => {
        for (const dir of [".next", "dist", "build", "coverage"]) {
            mkdirSync(join(repoDir, dir), { recursive: true });
            writeFileSync(join(repoDir, dir, "output.js"), "");
        }

        const files = collectUntrackedFiles(repoDir);
        expect(files.some((f) => /^\.(next)|dist|build|coverage/.test(f))).toBe(false);
    });

    it("returns nested untracked files preserving relative paths", () => {
        writeFileSync(join(repoDir, ".gitignore"), "apps/**/.env.local\n");
        git(["add", ".gitignore"], repoDir);
        git(["commit", "-m", "add gitignore"], repoDir);
        mkdirSync(join(repoDir, "apps", "web"), { recursive: true });
        writeFileSync(join(repoDir, "apps", "web", ".env.local"), "NEXT_PUBLIC_URL=http://localhost\n");

        const files = collectUntrackedFiles(repoDir);
        expect(files).toContain("apps/web/.env.local");
    });

    it("returns empty array for a clean repo", () => {
        const files = collectUntrackedFiles(repoDir);
        expect(files).toHaveLength(0);
    });

    // Regression: a real monorepo's ignored listing runs to megabytes, which
    // overflowed spawnSync's 1MB default maxBuffer. git was killed, stdout came
    // back truncated with a null status, and the whole ignored list — every
    // .env — was dropped as if the repo were clean.
    it("still returns ignored files when the listing exceeds 1MB", () => {
        writeFileSync(join(repoDir, ".gitignore"), ".env\nbulk/\n");
        git(["add", ".gitignore"], repoDir);
        git(["commit", "-m", "add gitignore"], repoDir);
        writeFileSync(join(repoDir, ".env"), "SECRET=abc\n");

        // Long paths keep the listing above 1MB without the inode churn of tens
        // of thousands of files. The length lives in a nested directory rather
        // than the filename, which caps at 255 bytes on macOS.
        const bulkDir = join(repoDir, "bulk", "d".repeat(200));
        mkdirSync(bulkDir, { recursive: true });
        for (let i = 0; i < 5000; i++) {
            writeFileSync(join(bulkDir, `f-${i}`), "");
        }

        const files = collectUntrackedFiles(repoDir);
        expect(files).toContain(".env");
    });
});

describe("copyUntrackedFiles", () => {
    let srcDir: string;
    let destDir: string;

    beforeEach(() => {
        srcDir = mkdtempSync(join(tmpdir(), "wt-copy-src-"));
        destDir = mkdtempSync(join(tmpdir(), "wt-copy-dest-"));
    });

    afterEach(() => {
        rmSync(srcDir, { recursive: true, force: true });
        rmSync(destDir, { recursive: true, force: true });
    });

    it("copies files and returns their paths", () => {
        writeFileSync(join(srcDir, ".env"), "KEY=val\n");

        const copied = copyUntrackedFiles(srcDir, destDir, [".env"]);
        expect(copied).toEqual([".env"]);
        expect(readFileSync(join(destDir, ".env"), "utf-8")).toBe("KEY=val\n");
    });

    it("creates parent directories for nested files", () => {
        mkdirSync(join(srcDir, "apps", "web"), { recursive: true });
        writeFileSync(join(srcDir, "apps", "web", ".env.local"), "URL=x\n");

        const copied = copyUntrackedFiles(srcDir, destDir, ["apps/web/.env.local"]);
        expect(copied).toEqual(["apps/web/.env.local"]);
        expect(readFileSync(join(destDir, "apps", "web", ".env.local"), "utf-8")).toBe("URL=x\n");
    });

    it("skips missing files without throwing", () => {
        const copied = copyUntrackedFiles(srcDir, destDir, ["does-not-exist.env"]);
        expect(copied).toHaveLength(0);
    });

    it("returns only the files that were successfully copied", () => {
        writeFileSync(join(srcDir, "exists.env"), "A=1\n");

        const copied = copyUntrackedFiles(srcDir, destDir, ["exists.env", "missing.env"]);
        expect(copied).toEqual(["exists.env"]);
    });
});
