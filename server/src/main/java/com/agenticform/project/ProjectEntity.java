package com.agenticform.project;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.PreUpdate;
import jakarta.persistence.Table;
import com.fasterxml.jackson.annotation.JsonIgnore;

import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "projects")
public class ProjectEntity {
    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(nullable = false)
    private String name;

    @Column(nullable = false, unique = true)
    private String slug;

    @Column(name = "root_directory", unique = true)
    private String rootDirectory;

    @Enumerated(EnumType.STRING)
    @Column(name = "source_type", nullable = false, length = 32)
    private ProjectSourceType sourceType = ProjectSourceType.LOCAL_PATH;

    @Column(name = "repository_url", columnDefinition = "text")
    private String repositoryUrl;

    @Column(name = "default_branch", nullable = false)
    private String defaultBranch;

    @JsonIgnore
    @Column(name = "github_token_ciphertext", columnDefinition = "text")
    private String githubTokenCiphertext;

    @Column(nullable = false)
    private boolean enabled = true;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    protected ProjectEntity() {}

    public ProjectEntity(String name, String slug, String rootDirectory, String defaultBranch) {
        this(name, slug, ProjectSourceType.LOCAL_PATH, rootDirectory, null, defaultBranch);
    }

    public ProjectEntity(String name, String slug, ProjectSourceType sourceType,
                         String rootDirectory, String repositoryUrl, String defaultBranch) {
        this.name = name;
        this.slug = slug;
        this.sourceType = sourceType;
        this.rootDirectory = rootDirectory;
        this.repositoryUrl = repositoryUrl;
        this.defaultBranch = defaultBranch;
    }

    @PrePersist
    void onCreate() {
        createdAt = Instant.now();
        updatedAt = createdAt;
    }

    @PreUpdate
    void onUpdate() { updatedAt = Instant.now(); }

    public UUID getId() { return id; }
    public String getName() { return name; }
    public String getSlug() { return slug; }
    public String getRootDirectory() { return rootDirectory; }
    public ProjectSourceType getSourceType() { return sourceType; }
    public String getRepositoryUrl() { return repositoryUrl; }
    public String getDefaultBranch() { return defaultBranch; }
    public String getGithubTokenCiphertext() { return githubTokenCiphertext; }
    public void setGithubTokenCiphertext(String value) { this.githubTokenCiphertext = value; }
    public boolean isEnabled() { return enabled; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }
}
