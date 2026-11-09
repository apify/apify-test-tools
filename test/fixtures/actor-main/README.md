Scratch area for the `ActorSource.main` unit tests. They write a test file per case into a temporary
subdirectory here, so the isolated type-check finds this `tsconfig.json` (and `typescript` above it) instead of
the project's, which would otherwise compile the fixtures along with everything else.
