# Changelog

## 0.4.10

- Grant the generated ClawHub release jobs the permissions ClawHub's reusable workflows request (`id-token: write`, plus `actions: read` for the package leg). Without them GitHub refused to start those jobs, so tools that publish to ClawHub had to keep `release.yml` by hand, which then stopped following new versions.

## 0.4.9

- Refresh the web scaffold's lucide-react dependency to ^1.74.0 to match the official shadcn output; the web scaffold drift validator failed for every generated tool until then.

## 0.4.5

- Refresh the web scaffold's Base UI and lucide-react dependencies to match the official Vite and shadcn generators.

## 0.4.4

- Refresh the web scaffold's lucide-react and shadcn dependencies to match the official generators.

## 0.2.1

- Refresh the web scaffold's lucide-react dependency to match the official shadcn output.
- Keep DSH patch operators on their own line when generating or rebuilding managed regions.
- Pin this repository's OpenClaw validator to its scaffold version, 2026.9.2.

## 0.1.2

- Add Python-backed npm launchers and MCPB `uv` bundles, with PyPI as the canonical runtime.
- Publish the prebuilt Python wheel and sdist from the release artifact.
- Allow Codex plugins to omit eager MCP configuration with `codex.mcp: false`.
