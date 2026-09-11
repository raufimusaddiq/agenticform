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
            Process process = new ProcessBuilder(
                    "git", "-C", project.getRootDirectory(), "worktree", "add", "-b", branch,
                    target.toString(), baseBranch
            ).redirectErrorStream(true).start();

            Duration timeout = properties.getWorkspace().getGitTimeout();
            boolean completed = process.waitFor(timeout.toMillis(), TimeUnit.MILLISECONDS);
            if (!completed) {
                process.destroyForcibly();
                throw new IllegalStateException("git worktree add timed out");
            }
            String output = new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
            if (process.exitValue() != 0) {
                throw new IllegalStateException("git worktree add failed: " + output.trim());
            }
            return new WorkspaceAllocation(target, branch);
        } catch (IOException e) {
            throw new IllegalStateException("Unable to create Git worktree", e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("Interrupted while creating Git worktree", e);
        }
    }

    public record WorkspaceAllocation(Path workingDirectory, String branch) {}
}
