/**
 * java-spring.ts — stack validator for Java / Spring Boot projects.
 *
 * STUB — not yet implemented. The presence of this validator prevents other
 * validators (especially Dart/Flutter dead-code detection) from running on
 * Java projects, where dead-code detection is a false-positive generator
 * because Spring DI instantiates beans via annotations at runtime.
 *
 * Future checks to implement:
 *   - JAVA_ENTITY_WITHOUT_ID: @Entity class without @Id field
 *   - JAVA_SERVICE_WRITE_WITHOUT_TRANSACTIONAL: @Service method that writes to DB without @Transactional
 *   - JAVA_NPLUSONE_SUSPECT: @OneToMany without FetchType.LAZY or without @EntityGraph on query
 *   - JAVA_DTO_COLLISION: same DTO class name in multiple packages with divergent fields
 *   - JAVA_CONTROLLER_MONOLITH: @RestController with more than N endpoints (split by resource)
 *   - JAVA_HARDCODED_CONFIG: hardcoded config values instead of @Value/@ConfigurationProperties
 *
 * Things we MUST NOT check (false-positive generators in Spring):
 *   - Dead code (DI wires beans by annotation, not import text)
 *   - Unused classes (@Component/@Service/@Repository/@Entity instantiated reflectively)
 *   - Force-unwraps (Java doesn't have them)
 */

import * as fs from 'fs';
import * as path from 'path';
import { StackValidator, ValidatorContext, ValidationWarning } from './types';

export const JavaSpringValidator: StackValidator = {
  name: 'java-spring',
  label: 'Java / Spring Boot',

  detect(cwd: string): boolean {
    // Any pom.xml or build.gradle(.kts) under the repo root or a conventional subdir
    const candidates = [cwd, path.join(cwd, 'api'), path.join(cwd, 'backend'), path.join(cwd, 'server')];
    for (const c of candidates) {
      if (fs.existsSync(path.join(c, 'pom.xml'))) return true;
      if (fs.existsSync(path.join(c, 'build.gradle'))) return true;
      if (fs.existsSync(path.join(c, 'build.gradle.kts'))) return true;
    }
    return false;
  },

  async validate(_ctx: ValidatorContext): Promise<ValidationWarning[]> {
    // TODO: implement the checks listed in the file header.
    // For now, return empty to signal the stack is recognized but no checks run yet.
    return [];
  },
};
