import type { Command } from "commander";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { postSetupFlow } from "../lib/config.js";
import * as git from "../lib/git.js";
import * as output from "../lib/output.js";
import { exitWithError, pc, promptTheme } from "../lib/output.js";
import { checkbox, confirm } from "../lib/prompt.js";
import { registerRepo } from "../lib/registry.js";
import { collectUntrackedFiles, copyUntrackedFiles } from "../lib/untracked.js";

const STAGING_DIR = "._wt_tmp";
const SKIP_ENTRIES = new Set([".bare", STAGING_DIR]);

function dirNameFromBranch(branch: string): string {
    const ticketMatch = branch.match(/([A-Z]+-\d+)/);
    return ticketMatch ? ticketMatch[1] : branch.replace(/\//g, "-");
}

async function portBranches(
    root: string,
    defBranch: string,
    opts: { port?: string[]; portBranches?: boolean },
): Promise<void> {
    const branches = git.branchListLocalWithDates(root).filter((b) => b.name !== defBranch);

    if (branches.length === 0) return;
    if (opts.portBranches === false) return;

    let selected: string[];

    if (opts.port) {
        // Validate that the requested branches exist
        const localNames = new Set(branches.map((b) => b.name));
        for (const name of opts.port) {
            if (!localNames.has(name)) {
                output.warn(`Branch "${name}" not found locally — skipping`);
            }
        }
        selected = opts.port.filter((name) => localNames.has(name));
    } else {
        const shouldPort = await confirm(
            {
                message: "Port existing local branches as worktrees?",
                default: false,
                theme: promptTheme,
            },
            { output: process.stderr },
        );
        if (!shouldPort) return;

        const maxLen = Math.max(...branches.map((b) => b.name.length));
        selected = await checkbox(
            {
                message: "Select branches to port:",
                choices: branches.map((b) => ({
                    value: b.name,
                    name: `${pc.cyan(b.name.padEnd(maxLen))}  ${pc.dim(b.date)}`,
                })),
                pageSize: 15,
                theme: promptTheme,
            },
            { output: process.stderr },
        );
    }

    if (selected.length === 0) return;

    output.blank();

    for (const branch of selected) {
        const dirName = dirNameFromBranch(branch);
        const worktreePath = join(root, dirName);

        if (existsSync(worktreePath)) {
            output.warn(`  Skipped ${branch} — directory "${dirName}" already exists`);
            continue;
        }

        try {
            git.worktreeAdd(root, worktreePath, branch);
            if (git.remoteBranchExists(root, branch)) {
                git.setUpstream(worktreePath, branch);
            }
            output.success(`  Ported ${branch} → ${dirName}`);
        } catch {
            output.warn(`  Failed to port ${branch} — skipping`);
        }
    }
}

export function registerConvert(program: Command): void {
    program
        .command("convert")
        .description("Convert an existing git clone into a bare worktree structure")
        .option("--no-config", "Skip .worktreerc.json creation")
        .option("--post-create <cmd>", "Set post-create command")
        .option("--editor <cmd>", "Set editor command (code, cursor, vim, nvim, zed)")
        .option("--install", "Run post-create after conversion")
        .option("--no-install", "Skip post-create after conversion")
        .option("-y, --yes", "Skip confirmation prompt (use in CI/scripts)")
        .option("--port <branches...>", "Port specific local branches as worktrees (agent/CI-friendly)")
        .option("--no-port-branches", "Skip branch porting prompt")
        .addHelpText(
            "after",
            `\n${pc.bold("Fully non-interactive example:")}\n` +
                pc.dim("  wt convert --yes --post-create 'npm ci' --install --no-port-branches") +
                `\n\n${pc.bold("Port specific branches (agent-friendly):")}\n` +
                pc.dim("  wt convert --yes --port feat/auth feat/payments --post-create 'npm ci'"),
        )
        .action(
            async (opts: {
                config?: boolean;
                postCreate?: string;
                editor?: string;
                install?: boolean;
                yes?: boolean;
                port?: string[];
                portBranches?: boolean;
            }) => {
                const root = resolve(process.cwd());
                const bareDir = join(root, ".bare");
                const stagingDir = join(root, STAGING_DIR);

                // --- Validation ---
                if (!git.isNormalGitRepo(root)) {
                    exitWithError("Not a git repository (no .git directory found)");
                }

                if (existsSync(bareDir)) {
                    exitWithError("Already a wt-managed repository (.bare exists)");
                }

                if (!git.isCleanWorkingTree(root)) {
                    exitWithError("Working tree has uncommitted changes. Commit or stash before running wt convert.");
                }

                output.blank();
                output.warn("This will restructure the repository into a bare worktree layout.");
                output.warn("The default branch worktree is created automatically.");
                output.warn("You'll be prompted to port other local branches as worktrees.");
                output.warn("Untracked files (e.g. .env) will be copied into the default worktree.");
                output.warn("Generated dirs (node_modules, dist, .next, etc.) are excluded.");
                output.blank();

                if (!opts.yes) {
                    const proceed = await confirm(
                        {
                            message: "Continue with conversion?",
                            default: true,
                            theme: promptTheme,
                        },
                        { output: process.stderr },
                    );
                    if (!proceed) process.exit(0);
                }

                output.blank();
                output.info("Converting to bare worktree structure...");

                // --- Structural conversion (.git → .bare, worktree creation) ---
                // Only this block triggers rollback on failure. Config and post-create
                // are handled separately since the conversion is already complete.
                // Collect before .git is renamed so git still works normally
                const untrackedFiles = collectUntrackedFiles(root);

                let worktreeDir: string;
                let defBranch: string;
                let filesStaged = false;
                let worktreeCreated = false;
                try {
                    renameSync(join(root, ".git"), bareDir);

                    git.configSet(bareDir, "core.bare", "true");
                    git.configSet(bareDir, "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");

                    output.info("Fetching remote refs...");
                    git.fetch(root);

                    // Ensure origin/HEAD is set so defaultBranch can detect non-standard defaults
                    git.remoteSetHead(root);

                    defBranch = git.defaultBranch(root);
                    output.info(`Default branch detected: ${defBranch}`);

                    // --- Stage existing files out of root ---
                    const entries = readdirSync(root).filter((e) => !SKIP_ENTRIES.has(e));
                    mkdirSync(stagingDir, { recursive: true });
                    for (const entry of entries) {
                        renameSync(join(root, entry), join(stagingDir, entry));
                    }
                    filesStaged = true;

                    // --- Create worktree for default branch ---
                    worktreeDir = join(root, defBranch);
                    output.info(`Creating worktree at ${worktreeDir}...`);

                    try {
                        git.worktreeAdd(root, worktreeDir, defBranch);
                    } catch {
                        git.worktreeAdd(root, worktreeDir, defBranch, { track: `origin/${defBranch}` });
                    }
                    worktreeCreated = true;

                    // Prune any stale worktree registrations inherited from .git/worktrees/
                    git.worktreePrune(root, { now: true });

                    // --- Rescue untracked files into the new worktree ---
                    if (untrackedFiles.length > 0) {
                        const copied = copyUntrackedFiles(stagingDir, worktreeDir, untrackedFiles);
                        if (copied.length > 0) {
                            output.success(`Preserved ${copied.length} untracked file(s) → ${defBranch}/`);
                            for (const f of copied) output.dim(`  ${f}`);
                        } else {
                            // The banner above promises untracked files are carried over, so
                            // never let a total failure pass in silence.
                            output.warn(
                                `Found ${untrackedFiles.length} untracked file(s) but copied none — check ${defBranch}/ for .env files.`,
                            );
                        }
                    }

                    // --- Clean up staging ---
                    rmSync(stagingDir, { recursive: true, force: true });
                } catch (err) {
                    // --- Rollback ---
                    output.warn("Conversion failed — rolling back...");

                    // Remove worktree registration if it was created
                    if (worktreeCreated) {
                        try {
                            git.worktreeRemove(root, worktreeDir!, true);
                        } catch {
                            // Best-effort: prune stale entries
                            try {
                                git.worktreePrune(root);
                            } catch {
                                /* best-effort */
                            }
                        }
                    }

                    // Restore staged files
                    if (filesStaged && existsSync(stagingDir)) {
                        try {
                            for (const entry of readdirSync(stagingDir)) {
                                renameSync(join(stagingDir, entry), join(root, entry));
                            }
                            rmSync(stagingDir, { recursive: true, force: true });
                        } catch {
                            output.error(`Could not restore files from ${STAGING_DIR}. Manual recovery may be needed.`);
                        }
                    }

                    // Restore .git
                    if (existsSync(bareDir) && !existsSync(join(root, ".git"))) {
                        try {
                            renameSync(bareDir, join(root, ".git"));
                            git.configSet(join(root, ".git"), "core.bare", "false");
                        } catch {
                            output.error("Could not restore .git directory. Manual recovery may be needed.");
                        }
                    }

                    exitWithError(`Conversion failed: ${(err as Error).message}`);
                }

                // --- Post-conversion steps (non-rollbackable) ---
                output.blank();
                output.success("Repository converted");
                output.dim(`  Root:     ${root}`);
                output.dim(`  Bare:     ${bareDir}`);
                output.dim(`  Worktree: ${worktreeDir}`);
                output.blank();
                try {
                    registerRepo(root);
                } catch {
                    /* best-effort — never fail a convert */
                }

                // --- Branch porting ---
                await portBranches(root, defBranch, opts);

                await postSetupFlow(root, worktreeDir, opts);

                // --- Next steps ---
                output.blank();
                output.success("Next steps:");
                output.dim(`  cd ${worktreeDir}`);
                output.dim(`  wt get <branch>          Check out existing branches`);
                output.dim(`  wt new <branch>          Create a new branch`);
                output.dim(`  wt ls                    List all worktrees`);
            },
        );
}
