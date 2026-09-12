package com.agenticform.project;

import com.agenticform.config.AgenticformProperties;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.FileVisitResult;
import java.nio.file.FileVisitor;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Set;
import java.util.UUID;

@Service
public class ProjectDiscoveryService {
    private static final Set<String> PRUNED_DIRECTORIES = Set.of(
            ".git", ".idea", ".gradle", ".cache", "node_modules", "target", "build", "dist", "vendor");

    private final ProjectPathPolicy pathPolicy;
    private final ProjectRepository projects;
    private final AgenticformProperties properties;

    public ProjectDiscoveryService(ProjectPathPolicy pathPolicy, ProjectRepository projects,
                                   AgenticformProperties properties) {
        this.pathPolicy = pathPolicy;
        this.projects = projects;
        this.properties = properties;
    }

    public List<Candidate> discover() {
        int maxDepth = Math.max(1, Math.min(8, properties.getProjectDiscovery().getMaxDepth()));
        int maxCandidates = Math.max(1, Math.min(1000, properties.getProjectDiscovery().getMaxCandidates()));
        LinkedHashMap<String, Candidate> candidates = new LinkedHashMap<>();

        for (Path root : pathPolicy.allowedRoots()) {
            if (candidates.size() >= maxCandidates) break;
            scanRoot(root, maxDepth, maxCandidates, candidates);
        }
        return candidates.values().stream()
                .sorted(Comparator.comparing(Candidate::path))
                .toList();
    }

    private void scanRoot(Path root, int maxDepth, int maxCandidates,
                          LinkedHashMap<String, Candidate> candidates) {
        try {
            Files.walkFileTree(root, Set.of(), maxDepth, new FileVisitor<>() {
                @Override
                public FileVisitResult preVisitDirectory(Path dir, BasicFileAttributes attrs) {
                    if (!dir.equals(root) && PRUNED_DIRECTORIES.contains(dir.getFileName().toString())) {
                        return FileVisitResult.SKIP_SUBTREE;
                    }
                    if (isRepository(dir)) {
                        addCandidate(root, dir, candidates);
                        return candidates.size() >= maxCandidates
                                ? FileVisitResult.TERMINATE : FileVisitResult.SKIP_SUBTREE;
                    }
                    return candidates.size() >= maxCandidates
                            ? FileVisitResult.TERMINATE : FileVisitResult.CONTINUE;
                }

                @Override public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) {
                    return FileVisitResult.CONTINUE;
                }
                @Override public FileVisitResult visitFileFailed(Path file, IOException exc) {
                    return FileVisitResult.SKIP_SUBTREE;
                }
                @Override public FileVisitResult postVisitDirectory(Path dir, IOException exc) {
                    return FileVisitResult.CONTINUE;
                }
            });
        } catch (IOException error) {
            throw new IllegalStateException("Unable to scan configured project root: " + root, error);
        }
    }

    private void addCandidate(Path root, Path directory, LinkedHashMap<String, Candidate> candidates) {
        Path canonical = pathPolicy.requireAllowedDirectory(directory.toString());
        String path = canonical.toString();
        if (candidates.containsKey(path)) return;

        ProjectEntity registered = projects.findByRootDirectory(path).orElse(null);
        String name = canonical.getFileName() == null ? canonical.toString() : canonical.getFileName().toString();
        candidates.put(path, new Candidate(
                name,
                path,
                root.toString(),
                detectedBranch(canonical),
                registered != null,
                registered == null ? null : registered.getId()));
    }

    private boolean isRepository(Path directory) {
        Path marker = directory.resolve(".git");
        return Files.isDirectory(marker, LinkOption.NOFOLLOW_LINKS)
                || Files.isRegularFile(marker, LinkOption.NOFOLLOW_LINKS);
    }

    private String detectedBranch(Path repository) {
        Path gitMarker = repository.resolve(".git");
        if (!Files.isDirectory(gitMarker, LinkOption.NOFOLLOW_LINKS)) return null;
        Path head = gitMarker.resolve("HEAD");
        if (!Files.isRegularFile(head, LinkOption.NOFOLLOW_LINKS)) return null;
        try {
            String value = Files.readString(head, StandardCharsets.UTF_8).trim();
            String prefix = "ref: refs/heads/";
            return value.startsWith(prefix) && value.length() > prefix.length()
                    ? value.substring(prefix.length()) : null;
        } catch (IOException ignored) {
            return null;
        }
    }

    public record Candidate(String name, String path, String configuredRoot,
                            String detectedBranch, boolean registered, UUID projectId) {}
}
