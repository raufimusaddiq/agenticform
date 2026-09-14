package com.agenticform.project;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.net.URI;
import java.nio.file.Path;
import java.util.List;
import java.util.Locale;
import java.util.NoSuchElementException;
import java.util.UUID;
import com.agenticform.security.SecretBox;

@Service
public class ProjectService {
    private final ProjectRepository repository;
    private final ProjectPathPolicy pathPolicy;
    private final SecretBox secrets;
    private final GitHubRepositoryValidator github;

    public ProjectService(ProjectRepository repository, ProjectPathPolicy pathPolicy, SecretBox secrets,
                          GitHubRepositoryValidator github) {
        this.repository = repository;
        this.pathPolicy = pathPolicy;
        this.secrets = secrets;
        this.github = github;
    }

    public List<ProjectEntity> list() {
        return repository.findAll();
    }

    public ProjectEntity get(UUID id) {
        return repository.findById(id).orElseThrow(() -> new NoSuchElementException("Project not found: " + id));
    }

    @Transactional
    public ProjectEntity register(String name, String path, String defaultBranch) {
        return register(name, ProjectSourceType.LOCAL_PATH, path, null, defaultBranch, null);
    }

    @Transactional
    public ProjectEntity register(String name, ProjectSourceType sourceType, String path,
                                  String repositoryUrl, String defaultBranch, String githubToken) {
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
        ProjectEntity project = new ProjectEntity(name.trim(), slug, type,
                null, normalizedRepository, defaultBranch.trim());
        if (githubToken != null && !githubToken.isBlank()) {
            github.requirePushAccess(normalizedRepository, githubToken);
            project.setGithubTokenCiphertext(secrets.encrypt(githubToken.trim()));
        }
        return repository.save(project);
    }

    @Transactional
    public ProjectEntity update(UUID id, String name, String defaultBranch, boolean enabled, String githubToken) {
        ProjectEntity project = get(id);
        if (defaultBranch == null || defaultBranch.isBlank()) throw new IllegalArgumentException("Default branch is required");
        String slug = slugify(name);
        if (repository.existsBySlugAndIdNot(slug, id)) throw new IllegalArgumentException("Project slug already exists: " + slug);
        if (githubToken != null && !githubToken.isBlank()) {
            if (project.getSourceType() != ProjectSourceType.GIT || project.getRepositoryUrl() == null) {
                throw new IllegalArgumentException("GitHub token requires a GIT project");
            }
            github.requirePushAccess(project.getRepositoryUrl(), githubToken);
            project.setGithubTokenCiphertext(secrets.encrypt(githubToken.trim()));
        }
        project.updateMetadata(name.trim(), slug, defaultBranch.trim(), enabled);
        return repository.save(project);
    }

    public String githubToken(UUID projectId) {
        String ciphertext = get(projectId).getGithubTokenCiphertext();
        return ciphertext == null || ciphertext.isBlank() ? "" : secrets.decrypt(ciphertext);
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
