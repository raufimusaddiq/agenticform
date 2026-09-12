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
        if (rawPath == null || rawPath.isBlank()) throw new IllegalArgumentException("Project path is required");
        try {
            Path candidate = Path.of(rawPath).toRealPath();
            if (!Files.isDirectory(candidate)) {
                throw new IllegalArgumentException("Project path is not a directory: " + candidate);
            }
            if (allowedRoots().stream().noneMatch(candidate::startsWith)) {
                throw new IllegalArgumentException("Project path is outside configured project roots");
            }
            return candidate;
        } catch (IOException e) {
            throw new IllegalArgumentException("Project path cannot be resolved: " + rawPath, e);
        }
    }

    public List<Path> allowedRoots() {
        return properties.getProjectRoots().stream()
                .map(Path::of)
                .map(this::realDirectory)
                .distinct()
                .toList();
    }

    private Path realDirectory(Path path) {
        try {
            Path real = path.toRealPath();
            if (!Files.isDirectory(real)) {
                throw new IllegalStateException("Configured project root is not a directory: " + real);
            }
            return real;
        } catch (IOException e) {
            throw new IllegalStateException("Configured project root cannot be resolved: " + path, e);
        }
    }
}
