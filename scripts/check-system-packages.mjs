#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const { systemPackageJobs } = await import(
  process.env.SYSTEM_PACKAGE_HELPER ?? "../src/distribution/system.ts"
);

const [id] = process.argv.slice(2);
const ids = new Set(["homebrew", "winget", "scoop", "chocolatey", "apt", "rpm"]);
if (!ids.has(id)) throw new Error(`usage: check-system-packages.mjs <${[...ids].join("|")}>`);

const root = process.cwd();
const fixture = mkdtempSync(join(root, ".system-package-smoke-"));
const path = relative(root, fixture);
const version = "1.2.3";
const write = (name, contents) => {
  const file = join(fixture, name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, contents);
  return file;
};
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const windowsExe = () => {
  const source = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
  const destination = write("toolfactory-smoke.exe", readFileSync(source));
  return { destination, hash: sha256(destination) };
};

function fixtureConfig() {
  switch (id) {
    case "homebrew": {
      const asset = "toolfactory-smoke-1.2.3.tar.gz";
      const absoluteAsset = join(fixture, asset);
      write("bin/toolfactory-smoke", `#!/bin/sh\necho ${version}\n`);
      chmodSync(join(fixture, "bin/toolfactory-smoke"), 0o755);
      execFileSync("tar", ["-czf", absoluteAsset, "bin"], { cwd: fixture });
      write(
        "Formula/toolfactory-smoke.rb",
        `class ToolfactorySmoke < Formula\n  desc "Disposable Toolfactory package smoke fixture"\n  homepage "https://example.com/toolfactory-smoke"\n  url "file://${absoluteAsset}"\n  version "${version}"\n  sha256 "${sha256(absoluteAsset)}"\n  license "MIT"\n\n  def install\n    bin.install "toolfactory-smoke"\n  end\nend\n`,
      );
      return {
        id,
        path,
        identity: "Formula/toolfactory-smoke.rb",
        name: "toolfactory-smoke",
        versionCommand:
          'ruby -ne \'puts $1 if /version \\"([^\\"]+)\\"/ =~ $_\' Formula/toolfactory-smoke.rb',
        buildCommand: `test -f ${asset}`,
        asset: `${path}/${asset}`,
        tap: "toolfactory-ci/homebrew-tap",
        catalogPath: "Formula/toolfactory-smoke.rb",
      };
    }
    case "winget": {
      const { hash } = windowsExe();
      const manifests = "manifests";
      const identifier = "Toolfactory.ToolfactorySmoke";
      write(
        `${manifests}/${identifier}.installer.yaml`,
        `PackageIdentifier: ${identifier}\nPackageVersion: ${version}\nInstallers:\n  - Architecture: x64\n    InstallerType: portable\n    InstallerUrl: https://example.com/toolfactory-smoke.exe\n    InstallerSha256: ${hash}\nManifestType: installer\nManifestVersion: 1.6.0\n`,
      );
      write(
        `${manifests}/${identifier}.locale.en-US.yaml`,
        `PackageIdentifier: ${identifier}\nPackageVersion: ${version}\nPackageLocale: en-US\nPublisher: Toolfactory\nPackageName: Toolfactory smoke fixture\nShortDescription: Disposable package validation fixture\nManifestType: defaultLocale\nManifestVersion: 1.6.0\n`,
      );
      write(
        `${manifests}/${identifier}.yaml`,
        `PackageIdentifier: ${identifier}\nPackageVersion: ${version}\nDefaultLocale: en-US\nManifestType: version\nManifestVersion: 1.6.0\n`,
      );
      return {
        id,
        path,
        identity: manifests,
        name: identifier,
        versionCommand: `(Get-Content -Raw '${manifests}/${identifier}.yaml' | Select-String -Pattern '(?m)^PackageVersion: (\\S+)').Matches[0].Groups[1].Value`,
        buildCommand: `Copy-Item -Force "$env:SystemRoot\\System32\\cmd.exe" toolfactory-smoke.exe`,
        asset: `${path}/toolfactory-smoke.exe`,
      };
    }
    case "scoop": {
      const { hash } = windowsExe();
      write(
        "toolfactory-smoke.json",
        `${JSON.stringify({ version, description: "Disposable Toolfactory package smoke fixture", homepage: "https://example.com/toolfactory-smoke", url: "https://example.com/toolfactory-smoke.exe", hash, bin: "toolfactory-smoke.exe" }, null, 2)}\n`,
      );
      return {
        id,
        path,
        identity: "toolfactory-smoke.json",
        name: "toolfactory-smoke",
        versionCommand: "(Get-Content -Raw 'toolfactory-smoke.json' | ConvertFrom-Json).version",
        buildCommand: `Copy-Item -Force "$env:SystemRoot\\System32\\cmd.exe" toolfactory-smoke.exe`,
        asset: `${path}/toolfactory-smoke.exe`,
        bucket: "toolfactory-ci/scoop-bucket",
        bucketName: "toolfactory-ci",
        catalogPath: "bucket/toolfactory-smoke.json",
      };
    }
    case "chocolatey":
      write(
        "toolfactory-smoke.nuspec",
        `<?xml version="1.0"?>\n<package><metadata><id>toolfactory-smoke</id><version>${version}</version><authors>Toolfactory</authors><description>Disposable Toolfactory package smoke fixture.</description></metadata><files><file src="tools\\**" target="tools" /></files></package>\n`,
      );
      write(
        "tools/chocolateyinstall.ps1",
        "Write-Host 'Toolfactory smoke fixture: no installation performed.'\n",
      );
      return {
        id,
        path,
        identity: "toolfactory-smoke.nuspec",
        name: "toolfactory-smoke",
        versionCommand: "([xml](Get-Content 'toolfactory-smoke.nuspec')).package.metadata.version",
      };
    case "apt":
      write(
        "debian/changelog",
        `toolfactory-smoke (${version}) unstable; urgency=medium\n\n  * Disposable Toolfactory package smoke fixture.\n\n -- Toolfactory <smoke@example.com>  Mon, 07 Sep 2026 12:00:00 +0000\n`,
      );
      write(
        "debian/control",
        "Source: toolfactory-smoke\nSection: utils\nPriority: optional\nMaintainer: Toolfactory <smoke@example.com>\nBuild-Depends: debhelper-compat (= 13)\nStandards-Version: 4.7.0\nRules-Requires-Root: no\n\nPackage: toolfactory-smoke\nArchitecture: all\nDepends: ${misc:Depends}\nDescription: Toolfactory smoke fixture\n Disposable package validation fixture.\n",
      );
      write("debian/rules", "#!/usr/bin/make -f\n%:\n\tdh $@\n");
      chmodSync(join(fixture, "debian/rules"), 0o755);
      write("debian/source/format", "3.0 (native)\n");
      write("README", "Toolfactory package smoke fixture.\n");
      return {
        id,
        path,
        identity: "debian/control",
        name: "toolfactory-smoke",
        versionCommand: "dpkg-parsechangelog -SVersion | sed 's/-[^-]*$//'",
        buildDependencies: ["debhelper"],
        ppa: "toolfactory-ci/smoke",
      };
    case "rpm":
      write("toolfactory-smoke.txt", "Toolfactory package smoke fixture.\n");
      write(
        "toolfactory-smoke.spec",
        `Name: toolfactory-smoke\nVersion: ${version}\nRelease: 1%{?dist}\nSummary: Toolfactory package smoke fixture\nLicense: MIT\nBuildArch: noarch\nSource0: toolfactory-smoke.txt\n\n%description\nDisposable Toolfactory package validation fixture.\n\n%prep\n%setup -q -c -T\ncp %{_sourcedir}/toolfactory-smoke.txt .\n\n%build\n\n%install\nmkdir -p %{buildroot}%{_datadir}/toolfactory-smoke\ncp toolfactory-smoke.txt %{buildroot}%{_datadir}/toolfactory-smoke/\n\n%files\n%{_datadir}/toolfactory-smoke/toolfactory-smoke.txt\n\n%changelog\n* Mon Sep 07 2026 Toolfactory <smoke@example.com> - ${version}-1\n- Disposable smoke fixture\n`,
      );
      return {
        id,
        path,
        identity: "toolfactory-smoke.spec",
        name: "toolfactory-smoke",
        versionCommand: "rpm --specfile toolfactory-smoke.spec --qf '%{VERSION}\\n'",
        buildDependencies: ["rpm-build"],
        coprProject: "toolfactory-ci/smoke",
      };
  }
}

const entry = fixtureConfig();
const project = {
  root,
  identity: {
    name: "toolfactory-smoke",
    version,
    repository: "https://github.com/toolfactory-ci/toolfactory-smoke",
  },
  tool: { surfaces: [id], systemPackages: [entry] },
};
const job = systemPackageJobs(project, process.env.GITHUB_SHA ?? "HEAD")[`system-${id}`];
if (!job || !Array.isArray(job.steps)) throw new Error(`system-${id} job was not generated`);

for (const step of job.steps) {
  if (typeof step !== "object" || step === null) continue;
  if ("uses" in step) {
    console.log(`Skipping action step: ${step.uses}`);
    continue;
  }
  if (!("run" in step) || typeof step.run !== "string") continue;
  const shell = step.shell === "pwsh" ? "pwsh" : process.platform === "win32" ? "pwsh" : "bash";
  const args =
    shell === "pwsh" ? ["-NoProfile", "-Command", step.run] : ["-eo", "pipefail", "-c", step.run];
  console.log(`$ ${step.run}`);
  const result = spawnSync(shell, args, { cwd: root, stdio: "inherit", env: process.env });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
