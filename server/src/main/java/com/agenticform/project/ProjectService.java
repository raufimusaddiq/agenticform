package com.agenticform.project;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.nio.file.Path;
import java.util.List;
import java.util.Locale;
import java.util.NoSuchElementException;
import java.util.UUID;

@Service
public class ProjectService {
    private final ProjectRepository repository;
    private final ProjectPathPolicy pathPolicy;

    public ProjectService(ProjectRepository repository, ProjectPathPolicy pathPolicy) {
        this.repository = repository;
        this.pathPolicy = pathPolicy;
    }

    public List<ProjectEntity> list() {
        return repository.findAll();
    }

    public ProjectEntity get(UUID id) {
        return repository.findById(id).orElseThrow(() -> new NoSuchElementException("Project not found: " + id));
    }

    @Transactional
    public ProjectEntity register(String name, String path, String defaultBranch) {
        Path canonical = pathPolicy.requireAllowedDirectory(path);
        String slug = slugify(name);
        if (repository.existsBySlug(slug)) {
            throw new IllegalArgumentException("Project slug already exists: " + slug);
        }
        if (repository.existsByRootDirectory(canonical.toString())) {
            throw new IllegalArgumentException("Project directory is already registered");
        }
        return repository.save(new ProjectEntity(name.trim(), slug, canonical.toString(), defaultBranch));
    }

    private String slugify(String value) {
        String slug = value.toLowerCase(Locale.ROOT)
                .replaceAll("[^a-z0-9]+", "-")
                .replaceAll("(^-|-$)", "");
        if (slug.isBlank()) {
            throw new IllegalArgumentException("Project name must contain letters or numbers");
        }
        return slug;
    }
}
