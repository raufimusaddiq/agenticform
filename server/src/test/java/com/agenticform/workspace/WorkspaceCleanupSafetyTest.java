package com.agenticform.workspace;

import com.agenticform.config.AgenticformProperties;
import com.agenticform.project.ProjectEntity;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Cleanup must refuse anything it cannot prove safe. These cover the documented
 * refusals: unmanaged paths, missing branch, dirty worktree, and unmerged branch.
 */
class WorkspaceCleanupSafetyTest {
    @TempDir Path temp;

    private WorkspaceManager manager() {
        AgenticformProperties properties = new AgenticformProperties();
        properties.getWorkspace().setRoot(temp.resolve("worktrees").toString());
        return new WorkspaceManager(properties);
    }

    private ProjectEntity project(Path root) {
        return new ProjectEntity("proj", "proj", root.toString(), "main");
    }

    private void git(Path cwd, List<String> args) throws Exception {
        List<String> argv = new java.util.ArrayList<>(List.of("git", "-C", cwd.toString()));
        argv.addAll(args);
        Process process = new ProcessBuilder(argv).redirectErrorStream(true).start();
        process.getInputStream().readAllBytes();
        assertEquals(0, process.waitFor(), "git command failed: " + argv);
    }

    @Test
    void refusesWorktreeOutsideManagedRoot() {
        var inspection = manager().inspectForCleanup(project(temp), temp.resolve("elsewhere").toString(), "main");
        assertFalse(inspection.eligible());
        assertTrue(inspection.reason().contains("outside the managed worktree root"));
    }

    @Test
    void refusesWhenBranchIsUnknown() {
        var inspection = manager().inspectForCleanup(project(temp), temp.resolve("worktrees/proj/a").toString(), " ");
        assertFalse(inspection.eligible());
        assertTrue(inspection.reason().contains("no managed branch"));
    }

    @Test
    void refusesDirtyWorktreeEvenWhenBranchIsMerged() throws Exception {
        Path repo = Files.createDirectories(temp.resolve("repo"));
        git(repo, List.of("init", "-q", "-b", "main"));
        Files.writeString(repo.resolve("README.md"), "base\n");
        git(repo, List.of("add", "README.md"));
        git(repo, List.of("-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-q", "-m", "base"));

        WorkspaceManager manager = manager();
        WorkspaceManager.WorkspaceAllocation allocation = manager.allocate(
                project(repo), WorkspaceMode.ISOLATED_WORKTREE, "Cleanup Agent", null, "main");

        // Merged branch, but an uncommitted local edit must still block cleanup.
        Files.writeString(allocation.workingDirectory().resolve("scratch.txt"), "uncommitted work\n");
        var dirty = manager.inspectForCleanup(project(repo), allocation.workingDirectory().toString(), allocation.branch());
        assertFalse(dirty.eligible());
        assertTrue(dirty.reason().contains("uncommitted changes"), dirty.reason());

        // After committing the edit the branch is no longer merged, so cleanup is
        // still refused until the work is actually merged.
        git(allocation.workingDirectory(), List.of("add", "scratch.txt"));
        git(allocation.workingDirectory(), List.of("-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-q", "-m", "scratch"));
        var unmerged = manager.inspectForCleanup(project(repo), allocation.workingDirectory().toString(), allocation.branch());
        assertFalse(unmerged.eligible());
        assertTrue(unmerged.reason().contains("not merged"), unmerged.reason());
    }

    @Test
    void allowsCleanMergedWorktreeAndRemovesIt() throws Exception {
        Path repo = Files.createDirectories(temp.resolve("repo2"));
        git(repo, List.of("init", "-q", "-b", "main"));
        Files.writeString(repo.resolve("README.md"), "base\n");
        git(repo, List.of("add", "README.md"));
        git(repo, List.of("-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-q", "-m", "base"));

        WorkspaceManager manager = manager();
        WorkspaceManager.WorkspaceAllocation allocation = manager.allocate(
                project(repo), WorkspaceMode.ISOLATED_WORKTREE, "Merged Agent", null, "main");
        git(repo, List.of("merge", "--no-ff", "-q", "-m", "merge", allocation.branch()));

        var clean = manager.inspectForCleanup(project(repo), allocation.workingDirectory().toString(), allocation.branch());
        assertTrue(clean.eligible(), clean.reason());

        WorkspaceManager.CleanupResult result = manager.removeMergedWorktree(
                project(repo), allocation.workingDirectory().toString(), allocation.branch());
        assertFalse(Files.exists(allocation.workingDirectory()));
        assertTrue(result.reason().toLowerCase().contains("removed"), result.reason());
    }
}
