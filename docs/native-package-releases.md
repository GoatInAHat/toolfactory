# Native package releases

`tool.nativePackages` is for an authored native package that lives in this repository. It does not
translate a Toolfactory TypeScript or Python tool into another language and never creates a runtime
launcher for a registry.

Each selected surface needs exactly one entry with an id, native package directory, native identity
file, and registry identity. Toolfactory reads the native version with that ecosystem's standard
CLI by default; `versionCommand` is an escape hatch that must print only the native version.
Release packaging compares it with the shared identity version; a disagreement is a release error,
never a silent rewrite. Packagist and Go modules are the exception: their version is the final
`v*` Git tag, so they have no pre-release version command or package step to compare.

For example, add `cargo` to `surfaces` and this entry to `dev.toolfactory/tool.json`:

```json
{
  "nativePackages": [
    { "id": "cargo", "path": "native/cli", "identity": "Cargo.toml", "name": "your-crate" }
  ]
}
```

The native package must already build using its own toolchain. Keep its normal configuration
files, dependencies, build scripts, plugins, and code; none is generated or restricted by
Toolfactory. Every selected toolchain must be installed for a local gate or package run.

| Surface | Typical identity file | Install command |
|---|---|---|
| `cargo` | `Cargo.toml` | `cargo install your-crate` for a binary crate |
| `nuget` | `Tool.csproj` | `dotnet add package Your.Package` |
| `maven-central` | `pom.xml` | add the `groupId:artifactId` dependency |
| `rubygems` | `tool.gemspec` | `gem install your-gem` |
| `packagist` | `composer.json` | `composer require vendor/package` |
| `go-module` | `go.mod` | `go get example.com/your/module@v1.2.3` |

PyPI remains the Python distribution surface: `pip install your-package` and `uv add your-package`
use the same published package. No separate pip registry or duplicated publishing job exists.

Cargo, NuGet, Maven Central, and RubyGems create conventional package assets. Cargo uses its token;
NuGet uses an API key; Maven Central needs a Central user token and GPG material, with the authored
POM configuring the Central publishing plugin and server id `central`; RubyGems uses an API key and
pushes the verified prebuilt gem. Cargo yanks and NuGet unlists through their upstream clients.
Maven release withdrawal is a Central Portal action.

Packagist and Go modules are VCS discovery systems. The final GitHub release job creates the
repository's `v*` tag after packaging; Packagist discovers it through its configured webhook or
normal polling, and the Go proxy discovers it on a later module query. Go's `name` is the module
root and consumption is `go get`; retract with a later `go.mod` containing a `retract` directive.
Both currently require package path `.` because the release workflow creates a repository-root tag.
They deliberately create no pre-release publish job or fabricated archive upload.
