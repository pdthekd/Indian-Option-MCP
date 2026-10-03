# Disabled workflows

GitHub Actions only runs files in `.github/workflows/`. Files here are kept for
reference and never run.

## release.yml — disabled 2026-10-03

Reasons (see docs/SECURITY_AUDIT.md §G):

- Publishes to npm under the **upstream** package name `indian-option-mcp`;
  this fork is not a distribution channel.
- Interpolates `${{ needs.validate.outputs.version }}` (derived from the git tag
  name) directly into `run:` shell scripts — command injection by anyone who can
  push a tag.
- Grants `contents: write` and `id-token: write` to every job, including ones
  that need neither.
- Uses a third-party action (`softprops/action-gh-release@v2`) pinned to a
  mutable tag while holding write permissions.

Before re-enabling: decide on a package name you own, pass tag-derived values via
`env:` instead of `${{ }}` in scripts, scope permissions per job, and pin all
actions to commit SHAs.
