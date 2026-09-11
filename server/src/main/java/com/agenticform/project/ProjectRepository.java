package com.agenticform.project;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.UUID;

public interface ProjectRepository extends JpaRepository<ProjectEntity, UUID> {
    boolean existsBySlug(String slug);
    boolean existsByRootDirectory(String rootDirectory);
    boolean existsByRepositoryUrl(String repositoryUrl);
}
