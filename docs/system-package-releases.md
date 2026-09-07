# System package releases

System package surfaces consume an authored native artifact and packaging metadata. They do not wrap
the Toolfactory TypeScript/Python kernel in another runtime. Each selected surface needs exactly one
`tool.systemPackages` entry with a package path, identity, registry name, and version command.

```json
{
  "systemPackages": [
    {
      "id": "homebrew",
      "path": "packaging/homebrew",
      "identity": "tool.rb",
      "name": "tool",
      "versionCommand": "ruby -ne 'puts $1 if /version \\\"([^\\\"]+)/i' tool.rb'",
      "asset": "dist/tool-darwin-arm64.tar.gz",
      "tap": "acme/homebrew-tap"
    }
  ]
}
```

`path`, `identity`, and `asset` are repository-relative. `identity` is a formula file for Homebrew,
a manifest directory for WinGet, a manifest file for Scoop, a `.nuspec` file for Chocolatey, a
Debian source directory, or an RPM `.spec` file. The supplied `versionCommand` is deliberately an
author-owned escape hatch: it must print the version in that native metadata, and packaging refuses
to continue when it differs from the shared identity version.

Homebrew, WinGet, and Scoop are catalog submissions. Toolfactory stages and validates the authored
formula/manifest and archive, but a Homebrew core, WinGet, or public Scoop listing remains a reviewed
repository contribution. An author-controlled Homebrew tap can publish the staged formula separately.

Chocolatey directly pushes a built `.nupkg` with its API key. apt is a configured Launchpad PPA: it
uploads a signed Debian source package with `dput`; it is not a universal apt registry. RPM is a
configured COPR project: it uploads a source RPM with `copr-cli`; dnf is not a registry. Removing
catalog entries or PPA/COPR builds is a repository/dashboard action.

The module invokes the upstream format and transport tools: `brew audit` / source install,
`winget validate`, PowerShell JSON parsing for Scoop, `choco pack`, `dpkg-buildpackage`, `dput`,
`rpmbuild`, and `copr-cli`. It does not write a formula, installer, manifest, Debian control file,
or spec file. Homebrew, WinGet, and Scoop release output is an auditable submission bundle; make the
reviewed pull request to the configured tap or public bucket after inspecting it.

Credentials are required only for direct publication: `CHOCOLATEY_API_KEY`, a base64-encoded
`APT_GPG_PRIVATE_KEY` plus `APT_GPG_KEY_ID`, or `COPR_LOGIN` and `COPR_TOKEN`. A PPA needs a
Launchpad account with the signing key registered, and a COPR project must already exist. Chocolatey
checks whether the exact version is already public before it pushes. PPA uploads and COPR builds are
left to their upstream duplicate/version policies.

Primary references: [Homebrew Formula Cookbook](https://docs.brew.sh/Formula-Cookbook),
[WinGet manifests](https://learn.microsoft.com/windows/package-manager/package/manifest),
[Scoop manifests](https://github.com/ScoopInstaller/Scoop/wiki/App-Manifests),
[Chocolatey package creation](https://docs.chocolatey.org/en-us/create/create-packages/),
[Debian source packages](https://www.debian.org/doc/manuals/maint-guide/build.en.html),
[Launchpad PPAs](https://documentation.ubuntu.com/launchpad/en/latest/user/explanation/packaging/ppas/),
and [Fedora COPR CLI](https://docs.pagure.org/copr.copr/user_documentation.html#command-line-interface).
