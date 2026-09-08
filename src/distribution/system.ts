/**
 * Operating-system package managers consume authored native artifacts and packaging metadata.
 * This is intentionally not a cross-language compiler or a launcher generator.
 */
import { z } from "zod";
import type { Command, Project, Surface } from "../model.js";
import type { GateStep, Registry } from "../project/gate.js";

export const SYSTEM_PACKAGE_IDS = [
  "homebrew",
  "winget",
  "scoop",
  "chocolatey",
  "apt",
  "rpm",
] as const;
export type SystemPackageId = (typeof SYSTEM_PACKAGE_IDS)[number];

const repositoryPath = z
  .string()
  .min(1)
  .refine(
    (value) => !/^(?:[A-Za-z]:|[\\/])/.test(value) && !value.split(/[\\/]/).includes(".."),
    "path must stay inside the repository.",
  );

export const systemPackageConfigSchema = z
  .object({
    id: z.enum(SYSTEM_PACKAGE_IDS),
    path: repositoryPath,
    identity: repositoryPath.describe("Native package metadata path relative to path."),
    name: z
      .string()
      .min(1)
      .describe("Native package/catalog identity; never inferred from Toolfactory name."),
    versionCommand: z
      .string()
      .min(1)
      .describe("Command run in path that prints only the authored package version."),
    buildCommand: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Author-owned native build command, run in path before an archive or installer is staged.",
      ),
    buildDependencies: z
      .array(z.string().min(1))
      .default([])
      .describe("Native OS packages installed by the Debian or Fedora CI builder."),
    asset: repositoryPath
      .optional()
      .describe(
        "Repository-relative, author-built archive or installer when the manager consumes one.",
      ),
    tap: z
      .string()
      .min(1)
      .optional()
      .describe("Author-controlled Homebrew tap (owner/homebrew-tap)."),
    bucket: z
      .string()
      .min(1)
      .optional()
      .describe("Author-controlled Scoop bucket repository (owner/repo)."),
    bucketName: z
      .string()
      .min(1)
      .optional()
      .describe("Local Scoop bucket name used by install commands."),
    catalogPath: repositoryPath
      .optional()
      .describe("Repository-relative destination inside the author-controlled tap or bucket."),
    ppa: z.string().min(1).optional().describe("Launchpad PPA as owner/archive."),
    coprProject: z.string().min(1).optional().describe("COPR project name (owner/project)."),
  })
  .superRefine((entry, context) => {
    if (["homebrew", "winget", "scoop"].includes(entry.id) && !entry.asset)
      context.addIssue({
        code: "custom",
        path: ["asset"],
        message: `${entry.id} requires an author-built archive or installer asset.`,
      });
    if (["homebrew", "winget", "scoop"].includes(entry.id) && !entry.buildCommand)
      context.addIssue({
        code: "custom",
        path: ["buildCommand"],
        message: `${entry.id} requires an author-owned native build command for its asset.`,
      });
    if (entry.id === "homebrew" && !entry.tap)
      context.addIssue({
        code: "custom",
        path: ["tap"],
        message: "Homebrew requires an author-controlled tap.",
      });
    if (entry.id === "homebrew" && !entry.catalogPath)
      context.addIssue({
        code: "custom",
        path: ["catalogPath"],
        message: "Homebrew requires the destination formula path in its tap.",
      });
    if (entry.id === "scoop" && !entry.bucket)
      context.addIssue({
        code: "custom",
        path: ["bucket"],
        message: "Scoop requires an author-controlled bucket repository.",
      });
    if (entry.id === "scoop" && !entry.bucketName)
      context.addIssue({
        code: "custom",
        path: ["bucketName"],
        message: "Scoop requires its explicit bucket name.",
      });
    if (entry.id === "scoop" && !entry.catalogPath)
      context.addIssue({
        code: "custom",
        path: ["catalogPath"],
        message: "Scoop requires the destination manifest path in its bucket.",
      });
    if (entry.id === "apt" && !entry.ppa)
      context.addIssue({
        code: "custom",
        path: ["ppa"],
        message: "apt requires a configured Launchpad PPA; apt itself is not a registry.",
      });
    if (entry.id === "rpm" && !entry.coprProject)
      context.addIssue({
        code: "custom",
        path: ["coprProject"],
        message: "RPM requires a configured COPR project; dnf itself is not a registry.",
      });
    if (["apt", "rpm"].includes(entry.id) && entry.buildDependencies.length === 0)
      context.addIssue({
        code: "custom",
        path: ["buildDependencies"],
        message: `${entry.id} requires its native builder dependencies, even when the list contains only the package toolchain.`,
      });
  })
  .strict();
export type SystemPackageConfig = z.infer<typeof systemPackageConfigSchema>;

function quote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
function powershellQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
function all(project: Project): SystemPackageConfig[] {
  const values = (project.tool.systemPackages ?? []).map((value) =>
    systemPackageConfigSchema.parse(value),
  );
  const duplicates = values.filter(
    (value, index) => values.findIndex((other) => other.id === value.id) !== index,
  );
  if (duplicates.length)
    throw new Error(
      `System package configuration repeats: ${[...new Set(duplicates.map((value) => value.id))].join(", ")}.`,
    );
  return values;
}
function selected(project: Project, id: SystemPackageId): boolean {
  return project.tool.surfaces.includes(id);
}
function one(project: Project, id: SystemPackageId): SystemPackageConfig {
  const values = all(project).filter((value) => value.id === id);
  if (values.length !== 1)
    throw new Error(
      `Surface "${id}" requires exactly one tool.systemPackages entry with id "${id}".`,
    );
  return values[0] as SystemPackageConfig;
}
function active(project: Project): SystemPackageConfig[] {
  return SYSTEM_PACKAGE_IDS.filter((id) => selected(project, id)).map((id) => one(project, id));
}
function version(project: Project, entry: SystemPackageConfig): string {
  if (!project.identity.version)
    throw new Error(
      `System package "${entry.name}" requires the shared identity to declare version.`,
    );
  return project.identity.version;
}
function versionAssert(project: Project, entry: SystemPackageConfig): string {
  return `cd ${quote(entry.path)} && test "$(${entry.versionCommand})" = ${quote(version(project, entry))}`;
}
function windowsVersionAssert(project: Project, entry: SystemPackageConfig): string {
  return `Set-Location ${powershellQuote(entry.path)}; $actual = (& { ${entry.versionCommand} } | Out-String).Trim(); if ($actual -ne ${powershellQuote(version(project, entry))}) { throw "native metadata version $actual does not match release ${version(project, entry)}" }`;
}
function destination(entry: SystemPackageConfig): string {
  return `dist/release/system/${entry.id}`;
}

const validators: Record<SystemPackageId, (entry: SystemPackageConfig) => Command[]> = {
  homebrew: () => [],
  winget: (entry) => [
    {
      label: "WinGet validate",
      command: "winget",
      args: ["validate", entry.identity],
      cwd: entry.path,
    },
  ],
  scoop: (entry) => [
    {
      label: "Scoop manifest JSON",
      command: "powershell",
      args: [
        "-NoProfile",
        "-Command",
        `Get-Content -Raw ${powershellQuote(entry.identity)} | ConvertFrom-Json | Out-Null`,
      ],
      cwd: entry.path,
    },
  ],
  chocolatey: (entry) => [
    { label: "Chocolatey pack", command: "choco", args: ["pack", entry.identity], cwd: entry.path },
  ],
  apt: (entry) => [
    {
      label: "Debian source build",
      command: "dpkg-buildpackage",
      args: ["-S", "-us", "-uc"],
      cwd: entry.path,
    },
  ],
  rpm: (entry) => [
    {
      label: "RPM source build",
      command: "rpmbuild",
      args: ["-bs", entry.identity],
      cwd: entry.path,
    },
  ],
};

function compatibleLocally(id: SystemPackageId): boolean {
  if (id === "homebrew") return process.platform === "darwin";
  if (["winget", "scoop", "chocolatey"].includes(id)) return process.platform === "win32";
  return process.platform === "linux";
}

export const systemPackageSurfaces: Surface[] = SYSTEM_PACKAGE_IDS.map((id) => ({
  id,
  plan(project) {
    one(project, id);
    return [];
  },
  validate(project) {
    const entry = one(project, id);
    if (
      process.env.TOOLFACTORY_SYSTEM_NATIVE_JOBS === "true" ||
      id === "homebrew" ||
      !compatibleLocally(id)
    ) {
      return [
        {
          label: `${id} validation is delegated to native CI`,
          command: "node",
          args: [
            "-e",
            `console.log(${JSON.stringify(`${id} requires its native runner; system-${id} CI validates it.`)})`,
          ],
        },
      ];
    }
    return validators[id](entry);
  },
}));

/** Required CLI preflight for compatible local runs; native CI jobs install their own tooling. */
export function systemToolchainSteps(
  project: Project,
  options: { include?: boolean } = {},
): GateStep[] {
  if (options.include === false) return [];
  const tool: Record<SystemPackageId, string> = {
    homebrew: "brew",
    winget: "winget",
    scoop: "powershell",
    chocolatey: "choco",
    apt: "dpkg-buildpackage",
    rpm: "rpmbuild",
  };
  return active(project).map((entry) =>
    entry.id === "homebrew" || !compatibleLocally(entry.id)
      ? {
          name: `${entry.id} toolchain is delegated to native CI`,
          run: `echo ${quote(`${entry.id} requires its native runner; see system-${entry.id} CI job.`)}`,
        }
      : {
          name: `${entry.id} upstream toolchain`,
          run: `command -v ${tool[entry.id]} >/dev/null || { echo "${entry.id}: install ${tool[entry.id]} before packaging" >&2; exit 1; }`,
        },
  );
}

/** Build actual package artifacts or stage the authored catalog submission, all at portable paths. */
export function systemPackageSteps(
  project: Project,
  options: { include?: boolean; local?: boolean } = {},
): GateStep[] {
  if (options.include === false) return [];
  return active(project).flatMap((entry) => {
    if (options.local !== false && !compatibleLocally(entry.id))
      throw new Error(
        `${entry.id} cannot be packaged on ${process.platform}; run its generated system-${entry.id} job or use its native OS.`,
      );
    const out = destination(entry);
    const asset = entry.asset ? quote(entry.asset) : undefined;
    const steps: GateStep[] = [
      { name: `${entry.id} version matches release`, run: versionAssert(project, entry) },
    ];
    if (entry.buildCommand)
      steps.push({
        name: `${entry.id} native build`,
        run: `cd ${quote(entry.path)} && ${entry.buildCommand}`,
      });
    switch (entry.id) {
      case "homebrew":
        steps.push({
          name: "Homebrew formula submission",
          run: `mkdir -p ${quote(out)} && test -f ${quote(`${entry.path}/${entry.identity}`)} && test -f ${asset} && cp ${quote(`${entry.path}/${entry.identity}`)} ${quote(out)}/ && cp ${asset} ${quote(out)}/`,
        });
        break;
      case "winget":
        // A WinGet release is normally a three-file manifest directory, not a synthetic single
        // YAML. Stage that authored directory exactly as it is submitted to winget-pkgs.
        steps.push({
          name: "WinGet catalog submission",
          run: `mkdir -p ${quote(out)} && test -d ${quote(`${entry.path}/${entry.identity}`)} && test -f ${asset} && cp -R ${quote(`${entry.path}/${entry.identity}`)} ${quote(out)}/ && cp ${asset} ${quote(out)}/`,
        });
        break;
      case "scoop":
        steps.push({
          name: "Scoop catalog submission",
          run: `mkdir -p ${quote(out)} && test -f ${quote(`${entry.path}/${entry.identity}`)} && test -f ${asset} && cp ${quote(`${entry.path}/${entry.identity}`)} ${quote(out)}/ && cp ${asset} ${quote(out)}/`,
        });
        break;
      case "chocolatey":
        steps.push({
          name: "Chocolatey package",
          run: `mkdir -p ${quote(out)} && choco pack ${quote(`${entry.path}/${entry.identity}`)} --outputdirectory ${quote(out)}`,
        });
        break;
      case "apt":
        steps.push({
          name: "Debian source package",
          run: `mkdir -p ${quote(out)} && (cd ${quote(entry.path)} && dpkg-buildpackage -S -sa -us -uc) && find ${quote(`${entry.path}/..`)} -maxdepth 1 -type f '(' -name '*.changes' -o -name '*.dsc' -o -name '*.tar.*' -o -name '*.diff.gz' -o -name '*.buildinfo' ')' -exec cp {} ${quote(out)} \\;`,
        });
        break;
      case "rpm":
        steps.push({
          name: "RPM source package",
          run: `mkdir -p ${quote(out)} && workspace="$PWD" && rpmbuild -bs "$workspace/${entry.path}/${entry.identity}" --define "_sourcedir $workspace/${entry.path}" --define "_srcrpmdir $workspace/${out}"`,
        });
        break;
    }
    return steps;
  });
}

function registry(project: Project, entry: SystemPackageConfig): Registry {
  const v = version(project, entry);
  const shared: Pick<Registry, "id" | "surfaces" | "url"> = {
    id: entry.id,
    surfaces: [entry.id],
    url: {
      homebrew: `https://github.com/${entry.tap}`,
      winget: "https://github.com/microsoft/winget-pkgs",
      scoop: `https://github.com/${entry.bucket}`,
      chocolatey: "https://community.chocolatey.org/account",
      apt: `https://launchpad.net/~${entry.ppa?.split("/")[0]}/+archive/ubuntu/${entry.ppa?.split("/")[1]}`,
      rpm: `https://copr.fedorainfracloud.org/coprs/${entry.coprProject}/`,
    }[entry.id],
  };
  switch (entry.id) {
    case "chocolatey":
      return {
        ...shared,
        secrets: ["CHOCOLATEY_API_KEY"],
        exists: `choco search ${quote(entry.name)} --exact --version ${quote(v)} --limit-output | grep -q ${quote(`${entry.name}|${v}`)}`,
        gate: '[ -n "$CHOCOLATEY_API_KEY" ]',
        retractUrl: `https://community.chocolatey.org/packages/${entry.name}`,
      };
    case "apt":
      return {
        ...shared,
        secrets: ["APT_GPG_PRIVATE_KEY", "APT_GPG_KEY_ID"],
        gate: '[ -n "$APT_GPG_PRIVATE_KEY" ] && [ -n "$APT_GPG_KEY_ID" ]',
        retractUrl: shared.url,
      };
    case "rpm":
      return {
        ...shared,
        secrets: ["COPR_LOGIN", "COPR_TOKEN"],
        gate: '[ -n "$COPR_LOGIN" ] && [ -n "$COPR_TOKEN" ]',
        retractUrl: shared.url,
      };
    case "homebrew":
      return {
        ...shared,
        secrets: ["HOMEBREW_TAP_TOKEN"],
        gate: '[ -n "$HOMEBREW_TAP_TOKEN" ]',
        retractUrl: shared.url,
      };
    case "winget":
      return {
        ...shared,
        secrets: [],
        gate: "true",
        retractUrl: shared.url,
      };
    case "scoop":
      return {
        ...shared,
        secrets: ["SCOOP_BUCKET_TOKEN"],
        gate: '[ -n "$SCOOP_BUCKET_TOKEN" ]',
        retractUrl: shared.url,
      };
  }
}
export function systemRegistryRows(project: Project): Registry[] {
  return active(project).map((entry) => registry(project, entry));
}

type Job = Record<string, unknown>;
const download = (name: string, path: string) => ({
  uses: "actions/download-artifact@v8",
  with: { name, path },
});
const checkout = (sha: string) => ({ uses: "actions/checkout@v7", with: { ref: sha } });
const upload = (id: SystemPackageId) => ({
  uses: "actions/upload-artifact@v7",
  with: { name: `system-${id}`, path: `dist/release/system/${id}`, "if-no-files-found": "error" },
});

/**
 * Native runner jobs. The generic Ubuntu gate/package workflow must not execute OS surface steps;
 * it waits for these jobs and downloads each `system-<id>` artifact into dist/release/system/<id>.
 */
export function systemPackageJobs(project: Project, releaseSha: string): Record<string, Job> {
  const jobs: Record<string, Job> = {};
  for (const entry of active(project)) {
    const out = destination(entry);
    const key = `system-${entry.id}`;
    const posixBuild = entry.buildCommand
      ? { run: `cd ${quote(entry.path)} && ${entry.buildCommand}` }
      : undefined;
    const windowsBuild = entry.buildCommand
      ? {
          run: `Set-Location ${powershellQuote(entry.path)}; ${entry.buildCommand}; if ($LASTEXITCODE) { exit $LASTEXITCODE }`,
          shell: "pwsh",
        }
      : undefined;
    if (entry.id === "homebrew") {
      const temporaryTap = "toolfactory-ci/tap";
      jobs[key] = {
        "runs-on": "macos-latest",
        permissions: { contents: "read" },
        steps: [
          checkout(releaseSha),
          ...(posixBuild ? [posixBuild] : []),
          { run: versionAssert(project, entry) },
          {
            run: `brew tap-new --no-git ${quote(temporaryTap)} && taproot=$(brew --repository ${quote(temporaryTap)}) && install -m 0644 ${quote(`${entry.path}/${entry.identity}`)} "$taproot/Formula/$(basename ${quote(entry.identity)})" && brew readall ${quote(temporaryTap)} && brew style --formula ${quote(`${temporaryTap}/${entry.name}`)} && brew audit --formula ${quote(`${temporaryTap}/${entry.name}`)}`,
          },
          {
            run: `mkdir -p ${quote(out)} && test -f ${quote(`${entry.path}/${entry.identity}`)} && test -f ${quote(entry.asset ?? "")} && cp ${quote(`${entry.path}/${entry.identity}`)} ${quote(out)}/ && cp ${quote(entry.asset ?? "")} ${quote(out)}/`,
          },
          upload(entry.id),
        ],
      };
    }
    if (entry.id === "winget") {
      jobs[key] = {
        "runs-on": "windows-latest",
        permissions: { contents: "read" },
        steps: [
          checkout(releaseSha),
          {
            run: "if (!(Get-Command winget -ErrorAction SilentlyContinue)) { Install-Module -Name Microsoft.WinGet.Client -Force -Repository PSGallery; Repair-WinGetPackageManager -AllUsers }; if (!(Get-Command winget -ErrorAction SilentlyContinue)) { throw 'WinGet CLI is unavailable after Repair-WinGetPackageManager' }",
            shell: "pwsh",
          },
          ...(windowsBuild ? [windowsBuild] : []),
          { run: windowsVersionAssert(project, entry), shell: "pwsh" },
          {
            run: `Set-Location ${powershellQuote(entry.path)}; winget validate ${powershellQuote(entry.identity)}; if ($LASTEXITCODE) { exit $LASTEXITCODE }`,
            shell: "pwsh",
          },
          {
            run: `New-Item -ItemType Directory -Force ${powershellQuote(out)} | Out-Null; if (!(Test-Path ${powershellQuote(`${entry.path}/${entry.identity}`)} -PathType Container) -or !(Test-Path ${powershellQuote(entry.asset ?? "")} -PathType Leaf)) { throw 'WinGet manifest directory or asset is missing' }; Copy-Item -Recurse -Force ${powershellQuote(`${entry.path}/${entry.identity}`)} ${powershellQuote(out)}; Copy-Item -Force ${powershellQuote(entry.asset ?? "")} ${powershellQuote(out)}`,
            shell: "pwsh",
          },
          upload(entry.id),
        ],
      };
    }
    if (entry.id === "scoop") {
      jobs[key] = {
        "runs-on": "windows-latest",
        permissions: { contents: "read" },
        steps: [
          checkout(releaseSha),
          ...(windowsBuild ? [windowsBuild] : []),
          { run: windowsVersionAssert(project, entry), shell: "pwsh" },
          {
            run: `Get-Content -Raw ${powershellQuote(`${entry.path}/${entry.identity}`)} | ConvertFrom-Json | Out-Null`,
            shell: "pwsh",
          },
          {
            run: `New-Item -ItemType Directory -Force ${powershellQuote(out)} | Out-Null; if (!(Test-Path ${powershellQuote(`${entry.path}/${entry.identity}`)} -PathType Leaf) -or !(Test-Path ${powershellQuote(entry.asset ?? "")} -PathType Leaf)) { throw 'Scoop manifest or asset is missing' }; Copy-Item -Force ${powershellQuote(`${entry.path}/${entry.identity}`)} ${powershellQuote(out)}; Copy-Item -Force ${powershellQuote(entry.asset ?? "")} ${powershellQuote(out)}`,
            shell: "pwsh",
          },
          upload(entry.id),
        ],
      };
    }
    if (entry.id === "chocolatey") {
      jobs[key] = {
        "runs-on": "windows-latest",
        permissions: { contents: "read" },
        steps: [
          checkout(releaseSha),
          ...(windowsBuild ? [windowsBuild] : []),
          { run: windowsVersionAssert(project, entry), shell: "pwsh" },
          {
            run: `$workspace = (Get-Location).Path; $out = Join-Path $workspace ${powershellQuote(out)}; New-Item -ItemType Directory -Force $out | Out-Null; Set-Location ${powershellQuote(entry.path)}; choco pack ${powershellQuote(entry.identity)} --outputdirectory $out; if ($LASTEXITCODE) { exit $LASTEXITCODE }`,
            shell: "pwsh",
          },
          upload(entry.id),
        ],
      };
    }
    if (entry.id === "apt") {
      const dependencies = entry.buildDependencies.map(quote).join(" ");
      jobs[key] = {
        "runs-on": "ubuntu-latest",
        permissions: { contents: "read" },
        steps: [
          checkout(releaseSha),
          {
            run: `sudo apt-get update && sudo apt-get install -y devscripts dpkg-dev ${dependencies}`,
          },
          ...(posixBuild ? [posixBuild] : []),
          { run: versionAssert(project, entry) },
          {
            run: `mkdir -p ${quote(out)} && (cd ${quote(entry.path)} && dpkg-buildpackage -S -sa -us -uc) && find ${quote(`${entry.path}/..`)} -maxdepth 1 -type f '(' -name '*.changes' -o -name '*.dsc' -o -name '*.tar.*' -o -name '*.diff.gz' -o -name '*.buildinfo' ')' -exec cp {} ${quote(out)} \\;`,
          },
          upload(entry.id),
        ],
      };
    }
    if (entry.id === "rpm") {
      const dependencies = entry.buildDependencies.map(quote).join(" ");
      jobs[key] = {
        "runs-on": "ubuntu-latest",
        container: "fedora:latest",
        permissions: { contents: "read" },
        steps: [
          checkout(releaseSha),
          { run: `dnf -y install rpm-build ${dependencies}` },
          ...(posixBuild ? [posixBuild] : []),
          { run: versionAssert(project, entry) },
          {
            run: `mkdir -p ${quote(out)} && workspace="$PWD" && rpmbuild -bs "$workspace/${entry.path}/${entry.identity}" --define "_sourcedir $workspace/${entry.path}" --define "_srcrpmdir $workspace/${out}"`,
          },
          upload(entry.id),
        ],
      };
    }
  }
  return jobs;
}

/**
 * Publish only after the GitHub release exists. Homebrew taps and Scoop buckets are ordinary
 * author-controlled Git repositories; WinGet remains a reviewed microsoft/winget-pkgs submission.
 */
export function systemPublishJobs(
  project: Project,
  artifactDir: string,
  _releaseSha: string,
): Record<string, Job> {
  const jobs: Record<string, Job> = {};
  for (const entry of active(project)) {
    const base = {
      needs: ["gate", "release"],
      if: `needs.gate.outputs.${entry.id.replace(/-/g, "_")} == 'true'`,
      "runs-on": "ubuntu-latest",
      permissions: { contents: "read" },
    };
    const artifact = `system-${entry.id}`;
    if (entry.id === "chocolatey") {
      const packageName = powershellQuote(entry.name);
      const packageVersion = powershellQuote(version(project, entry));
      const published = powershellQuote(`${entry.name}|${version(project, entry)}`);
      jobs["publish-chocolatey"] = {
        ...base,
        "runs-on": "windows-latest",
        env: { CHOCOLATEY_API_KEY: "${{ secrets.CHOCOLATEY_API_KEY }}" },
        steps: [
          download(artifact, artifactDir),
          {
            run: `if (choco search ${packageName} --exact --version ${packageVersion} --limit-output | Select-String -SimpleMatch ${published}) { exit 0 }; Get-ChildItem ${powershellQuote(artifactDir)} -Recurse -Filter *.nupkg | ForEach-Object { choco push $_.FullName --source https://push.chocolatey.org/ --api-key $env:CHOCOLATEY_API_KEY; if ($LASTEXITCODE) { exit $LASTEXITCODE } }`,
            shell: "pwsh",
          },
        ],
      };
    }
    if (entry.id === "apt") {
      jobs["publish-apt"] = {
        ...base,
        env: {
          APT_GPG_PRIVATE_KEY: "${{ secrets.APT_GPG_PRIVATE_KEY }}",
          APT_GPG_KEY_ID: "${{ secrets.APT_GPG_KEY_ID }}",
        },
        steps: [
          download(artifact, artifactDir),
          { run: "sudo apt-get update && sudo apt-get install -y devscripts dput gnupg" },
          { run: 'printf "%s" "$APT_GPG_PRIVATE_KEY" | base64 --decode | gpg --batch --import' },
          {
            run: `changes=$(find ${quote(artifactDir)} -name '*.changes' -print -quit) && test -n "$changes" && debsign -k "$APT_GPG_KEY_ID" "$changes" && dput ${quote(`ppa:${entry.ppa ?? ""}`)} "$changes"`,
          },
        ],
      };
    }
    if (entry.id === "rpm") {
      jobs["publish-rpm"] = {
        ...base,
        container: "fedora:latest",
        env: { COPR_LOGIN: "${{ secrets.COPR_LOGIN }}", COPR_TOKEN: "${{ secrets.COPR_TOKEN }}" },
        steps: [
          download(artifact, artifactDir),
          { run: "dnf -y install copr-cli" },
          {
            run: 'mkdir -p ~/.config && printf \'[copr-cli]\\nlogin = %s\\ntoken = %s\\n\' "$COPR_LOGIN" "$COPR_TOKEN" > ~/.config/copr',
          },
          {
            run: `srpm=$(find ${quote(artifactDir)} -name '*.src.rpm' -print -quit) && test -n "$srpm" && copr-cli build ${quote(entry.coprProject ?? "")} "$srpm"`,
          },
        ],
      };
    }
    if (entry.id === "homebrew" || entry.id === "scoop") {
      const repository = entry.id === "homebrew" ? entry.tap : entry.bucket;
      const token = entry.id === "homebrew" ? "HOMEBREW_TAP_TOKEN" : "SCOOP_BUCKET_TOKEN";
      const destinationPath = entry.catalogPath ?? "";
      const stagedMetadata = quote(`.system-package/${entry.identity.split("/").at(-1) ?? ""}`);
      jobs[`publish-${entry.id}`] = {
        ...base,
        "runs-on": entry.id === "homebrew" ? "macos-latest" : "ubuntu-latest",
        permissions: { contents: "read" },
        env: { CATALOG_TOKEN: `\${{ secrets.${token} }}` },
        steps: [
          download(artifact, ".system-package"),
          {
            uses: "actions/checkout@v7",
            with: { repository, token: "${{ env.CATALOG_TOKEN }}", path: ".system-catalog" },
          },
          {
            run: `mkdir -p ".system-catalog/$(dirname ${quote(destinationPath)})" && test -f ${stagedMetadata} && install -m 0644 ${stagedMetadata} ${quote(`.system-catalog/${destinationPath}`)} && git -C .system-catalog add -- ${quote(destinationPath)} && if git -C .system-catalog diff --cached --quiet; then exit 0; fi && git -C .system-catalog config user.name toolfactory-release && git -C .system-catalog config user.email toolfactory-release@users.noreply.github.com && git -C .system-catalog commit -m ${quote(`Release ${entry.name} ${version(project, entry)}`)} && git -C .system-catalog push`,
          },
          ...(entry.id === "homebrew"
            ? [
                {
                  run: `brew tap-new --no-git toolfactory-postrelease/tap && taproot=$(brew --repository toolfactory-postrelease/tap) && install -m 0644 ${quote(`.system-catalog/${destinationPath}`)} "$taproot/Formula/$(basename ${quote(destinationPath)})" && brew install --build-from-source ${quote(`toolfactory-postrelease/tap/${entry.name}`)}`,
                },
              ]
            : []),
        ],
      };
    }
  }
  return jobs;
}

export function systemInstallLines(project: Project): string[] {
  return active(project).map(
    (entry) =>
      ({
        homebrew: `\`brew install ${entry.tap?.replace(/\/homebrew-/, "/")}/${entry.name}\``,
        winget: `\`winget install ${entry.name}\``,
        scoop: `\`scoop bucket add ${entry.bucketName} https://github.com/${entry.bucket}.git\` then \`scoop install ${entry.bucketName}/${entry.name}\``,
        chocolatey: `\`choco install ${entry.name}\``,
        apt: `add the ${entry.ppa} PPA, then \`apt install ${entry.name}\``,
        rpm: `enable COPR ${entry.coprProject}, then \`dnf install ${entry.name}\``,
      })[entry.id],
  );
}
