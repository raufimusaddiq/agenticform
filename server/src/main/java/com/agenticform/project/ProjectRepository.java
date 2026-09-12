package com.agenticform.project;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.Optional;
import java.util.UUID;

public interface ProjectRepository extends JpaRepository<ProjectEntity, UUID> {
    boolean existsBySlug(String slug);
    boolean existsByRootDirectory(String rootDirectory);
    Optional<ProjectEntity> findByRootDirectory(String rootDirectory);
    boolean existsByRepositoryUrl(String repositoryUrl);
}
