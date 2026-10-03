# Bundled contract ABIs

Full forge artifact JSONs (the indexer reads the `abi` field) for the five
SPORE v1 core contracts, exported from `contracts/out/` at deploy time.

These are committed because `contracts/out/` is gitignored build output and
the hosted indexer needs the ABIs at runtime (see `ARTIFACTS_DIR`).

**When contracts change:** re-run `forge build`, re-copy the five artifact
JSONs here, and redeploy the indexer.
