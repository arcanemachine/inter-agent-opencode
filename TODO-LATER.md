# Later follow-ups

Environment-specific validation is intentionally deferred and is not part of the current release scope.

- Windows locking, permissions, and symlink protections: resume only on a real Windows host or CI runner; do not emulate these checks on Linux.
