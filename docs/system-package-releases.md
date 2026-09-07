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
      "buildCommand": "make release-archive",
      "asset": "dist/tool-darwin-arm64.tar.gz",
      "tap": "acme/homebrew-tap",
      "catalogPath": "Formula/tool.rb"
    }
  ]
}
```

`path`, `identity`, and `asset` are repository-relative. `identity` is a formula file for Homebrew,
a manifest directory for WinGet, a manifest file for Scoop, a `.nuspec` file for Chocolatey, a
Debian source directory, or an RPM `.spec` file. The supplied `versionCommand` is deliberately an
author-owned escape hatch: it must print the version in that native metadata, and packaging refuses
to continue when it differs from the shared identity version.

The release workflow runs each selected surface in a native job and uploads a separate
`system-<id>` artifact. The generic Ubuntu gate and package job must omit these surfaces, then
merge those artifacts under `dist/release/system/<id>`. Homebrew runs on macOS; WinGet, Scoop, and
Chocolatey on Windows; apt on Ubuntu; and RPM in Fedora. Local validation reports a successful
delegation when the current host cannot run a selected package manager or the manager needs its
isolated native CI setup.

Homebrew, WinGet, and Scoop are catalog submissions. Toolfactory stages and validates the authored
formula/manifest and archive, but a Homebrew core, WinGet, or public Scoop listing remains a reviewed
repository contribution. WinGet therefore stops at a reviewed submission bundle. Homebrew and Scoop
require an author-controlled tap/bucket and an explicit `catalogPath`; after the GitHub Release has
created their referenced assets, their jobs commit and push the authored formula/manifest to that
repository. They use `HOMEBREW_TAP_TOKEN` and `SCOOP_BUCKET_TOKEN` respectively.

Chocolatey directly pushes a built `.nupkg` with its API key. apt is a configured Launchpad PPA: it
uploads a signed Debian source package with `dput`; it is not a universal apt registry. RPM is a
configured COPR project: it uploads a source RPM with `copr-cli`; dnf is not a registry. Removing
catalog entries or PPA/COPR builds is a repository/dashboard action.

The module invokes the upstream format and transport tools: `brew readall`, `brew style`, `brew audit`
and a post-release source install,
`winget validate`, PowerShell JSON parsing for Scoop, `choco pack`, `dpkg-buildpackage`, `dput`,
`rpmbuild`, and `copr-cli`. It does not write a formula, installer, manifest, Debian control file,
or spec file. WinGet release output is an auditable submission bundle; make the reviewed WinGet pull
request after inspecting it. `buildCommand` remains author-owned and produces
the declared `asset`; apt and RPM declare `buildDependencies`, which their native CI jobs install
alongside the packaging tools. Debian stages the complete `.changes`, `.dsc`, tarball/diff, and
build-info set referenced by source uploads.

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
