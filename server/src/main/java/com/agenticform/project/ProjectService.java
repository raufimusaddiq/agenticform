package com.agenticform.project;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.net.URI;
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
        return register(name, ProjectSourceType.LOCAL_PATH, path, null, defaultBranch);
    }

    @Transactional
    public ProjectEntity register(String name, ProjectSourceType sourceType, String path,
                                  String repositoryUrl, String defaultBranch) {
        ProjectSourceType type = sourceType == null ? ProjectSourceType.LOCAL_PATH : sourceType;
        String slug = slugify(name);
        if (repository.existsBySlug(slug)) throw new IllegalArgumentException("Project slug already exists: " + slug);
        if (defaultBranch == null || defaultBranch.isBlank()) throw new IllegalArgumentException("Default branch is required");

        if (type == ProjectSourceType.LOCAL_PATH) {
            Path canonical = pathPolicy.requireAllowedDirectory(path);
            if (repository.existsByRootDirectory(canonical.toString())) {
                throw new IllegalArgumentException("Project directory is already registered");
            }
            return repository.save(new ProjectEntity(name.trim(), slug, type,
                    canonical.toString(), null, defaultBranch.trim()));
        }

        String normalizedRepository = normalizeRepositoryUrl(repositoryUrl);
        if (repository.existsByRepositoryUrl(normalizedRepository)) {
            throw new IllegalArgumentException("Git repository is already registered");
        }
        return repository.save(new ProjectEntity(name.trim(), slug, type,
                null, normalizedRepository, defaultBranch.trim()));
    }

    private String normalizeRepositoryUrl(String value) {
        if (value == null || value.isBlank()) throw new IllegalArgumentException("Repository URL is required for GIT projects");
        try {
            URI uri = URI.create(value.trim());
            if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null) {
                throw new IllegalArgumentException("Git project repository must use an HTTPS URL");
            }
            if (uri.getUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null) {
                throw new IllegalArgumentException("Repository URL may not contain credentials, query parameters, or fragments");
            }
            String normalized = uri.toString();
            while (normalized.endsWith("/")) normalized = normalized.substring(0, normalized.length() - 1);
            return normalized;
        } catch (IllegalArgumentException error) {
            throw error;
        } catch (Exception error) {
            throw new IllegalArgumentException("Invalid repository URL", error);
        }
    }

    private String slugify(String value) {
        if (value == null || value.isBlank()) throw new IllegalArgumentException("Project name is required");
        String slug = value.toLowerCase(Locale.ROOT)
                .replaceAll("[^a-z0-9]+", "-")
                .replaceAll("(^-|-$)", "");
        if (slug.isBlank()) throw new IllegalArgumentException("Project name must contain letters or numbers");
        return slug;
    }
}
