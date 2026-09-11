package com.agenticform.project;

import com.agenticform.config.AgenticformProperties;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

@Component
public class ProjectPathPolicy {
    private final AgenticformProperties properties;

    public ProjectPathPolicy(AgenticformProperties properties) {
        this.properties = properties;
    }

    public Path requireAllowedDirectory(String rawPath) {
        try {
            Path candidate = Path.of(rawPath).toRealPath();
            if (!Files.isDirectory(candidate)) {
                throw new IllegalArgumentException("Project path is not a directory: " + candidate);
            }
            List<Path> roots = properties.getProjectRoots().stream()
                    .map(Path::of)
                    .map(this::realPath)
                    .toList();
            if (roots.stream().noneMatch(candidate::startsWith)) {
                throw new IllegalArgumentException("Project path is outside configured project roots");
            }
            return candidate;
        } catch (IOException e) {
            throw new IllegalArgumentException("Project path cannot be resolved: " + rawPath, e);
        }
    }

    private Path realPath(Path path) {
        try {
            return path.toRealPath();
        } catch (IOException e) {
            throw new IllegalStateException("Configured project root cannot be resolved: " + path, e);
        }
    }
}
