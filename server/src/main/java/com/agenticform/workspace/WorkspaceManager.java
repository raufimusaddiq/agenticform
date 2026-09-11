package com.agenticform.workspace;

import com.agenticform.config.AgenticformProperties;
import com.agenticform.project.ProjectEntity;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

@Service
public class WorkspaceManager {
    public record WorkspaceAllocation(Path workingDirectory, String branch) {}
    public record CleanupInspection(boolean eligible, String reason, long estimatedBytes) {}
    public record CleanupResult(long freedBytes, String reason) {}
    private record CommandResult(int exitCode, String output) {}

    private final AgenticformProperties properties;

    public WorkspaceManager(AgenticformProperties properties) {
        this.properties = properties;
    }

    public WorkspaceAllocation allocate(ProjectEntity project, WorkspaceMode mode, String agentName,
                                        String requestedBranch, String baseBranch) {
        if (mode == WorkspaceMode.SHARED_PROJECT) {
            return new WorkspaceAllocation(Path.of(project.getRootDirectory()), baseBranch);
        }

        String suffix = UUID.randomUUID().toString().substring(0, 8);
        String safeName = agentName.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9]+", "-").replaceAll("(^-|-$)", "");
        String branch = requestedBranch == null || requestedBranch.isBlank()
                ? "agent/" + safeName + "-" + suffix
                : requestedBranch;
        Path target = Path.of(properties.getWorkspace().getRoot(), project.getSlug(), safeName + "-" + suffix)
                .toAbsolutePath().normalize();

        try {
            Files.createDirectories(target.getParent());
            CommandResult result = run(java.util.List.of(
                    "git", "-C", project.getRootDirectory(), "worktree", "add", "-b", branch,
                    target.toString(), baseBranch));
            if (result.exitCode() != 0) {
                throw new IllegalStateException("git worktree add failed: " + result.output().trim());
            }
            return new WorkspaceAllocation(target, branch);
        } catch (IOException e) {
            throw new IllegalStateException("Unable to create Git worktree", e);
        }
    }

    public CleanupInspection inspectForCleanup(ProjectEntity project, String workingDirectory, String branch) {
        if (branch == null || branch.isBlank()) return new CleanupInspection(false, "Worktree has no managed branch", 0);
        Path target;
        try {
            target = requireManagedWorktree(workingDirectory);
        } catch (RuntimeException error) {
            return new CleanupInspection(false, error.getMessage(), 0);
        }
        if (!Files.exists(target)) return new CleanupInspection(false, "Worktree directory is already absent", 0);

        try {
            CommandResult status = run(java.util.List.of("git", "-C", target.toString(), "status", "--porcelain"));
            if (status.exitCode() != 0) return new CleanupInspection(false, "Unable to verify worktree status", 0);
            if (!status.output().isBlank()) return new CleanupInspection(false, "Worktree has uncommitted changes", directorySize(target));

            CommandResult merged = run(java.util.List.of(
                    "git", "-C", project.getRootDirectory(), "merge-base", "--is-ancestor",
                    branch, project.getDefaultBranch()));
            if (merged.exitCode() == 1) return new CleanupInspection(false, "Branch is not merged into " + project.getDefaultBranch(), directorySize(target));
            if (merged.exitCode() != 0) return new CleanupInspection(false, "Unable to prove branch merge state", directorySize(target));
            return new CleanupInspection(true, "Clean worktree and branch is merged", directorySize(target));
        } catch (Exception error) {
            return new CleanupInspection(false, "Cleanup inspection failed: " + safeMessage(error), 0);
        }
    }

    public CleanupResult removeMergedWorktree(ProjectEntity project, String workingDirectory, String branch) {
        CleanupInspection inspection = inspectForCleanup(project, workingDirectory, branch);
        if (!inspection.eligible()) throw new IllegalStateException("Workspace is not safe to clean: " + inspection.reason());
        Path target = requireManagedWorktree(workingDirectory);
        try {
            CommandResult remove = run(java.util.List.of(
                    "git", "-C", project.getRootDirectory(), "worktree", "remove", target.toString()));
            if (remove.exitCode() != 0) throw new IllegalStateException("git worktree remove failed: " + remove.output().trim());

            CommandResult deleteBranch = run(java.util.List.of(
                    "git", "-C", project.getRootDirectory(), "branch", "-d", branch));
            run(java.util.List.of("git", "-C", project.getRootDirectory(), "worktree", "prune"));
            String reason = deleteBranch.exitCode() == 0
                    ? "Removed merged worktree and local branch"
                    : "Removed merged worktree; local branch cleanup was skipped: " + deleteBranch.output().trim();
            return new CleanupResult(inspection.estimatedBytes(), reason);
        } catch (IOException error) {
            throw new IllegalStateException("Unable to remove Git worktree", error);
        }
    }

    private Path requireManagedWorktree(String workingDirectory) {
        if (workingDirectory == null || workingDirectory.isBlank()) throw new IllegalArgumentException("Working directory is required");
        Path root = Path.of(properties.getWorkspace().getRoot()).toAbsolutePath().normalize();
        Path target = Path.of(workingDirectory).toAbsolutePath().normalize();
        if (!target.startsWith(root) || target.equals(root)) {
            throw new IllegalArgumentException("Refusing to clean a path outside the managed worktree root");
        }
        return target;
    }

    private long directorySize(Path target) {
        try (var paths = Files.walk(target)) {
            return paths.filter(Files::isRegularFile).mapToLong(path -> {
                try { return Files.size(path); }
                catch (IOException ignored) { return 0L; }
            }).sum();
        } catch (IOException ignored) {
            return 0L;
        }
    }

    private CommandResult run(java.util.List<String> argv) throws IOException {
        try {
            Process process = new ProcessBuilder(argv).redirectErrorStream(true).start();
            Duration timeout = properties.getWorkspace().getGitTimeout();
            boolean completed = process.waitFor(timeout.toMillis(), TimeUnit.MILLISECONDS);
            if (!completed) {
                process.destroyForcibly();
                process.waitFor(5, TimeUnit.SECONDS);
                throw new IllegalStateException("Git command timed out");
            }
            return new CommandResult(process.exitValue(),
                    new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8));
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("Interrupted while running Git command", error);
        }
    }

    private String safeMessage(Throwable error) {
        String message = error.getMessage();
        return message == null || message.isBlank() ? error.getClass().getSimpleName() : message;
    }
}
