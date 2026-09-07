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

export const systemPackageConfigSchema = z
  .object({
    id: z.enum(SYSTEM_PACKAGE_IDS),
    path: z
      .string()
      .min(1)
      .refine(
        (value) => !value.startsWith("/") && !value.split("/").includes(".."),
        "path must stay inside the repository.",
      ),
    identity: z
      .string()
      .min(1)
      .refine(
        (value) => !value.startsWith("/") && !value.split("/").includes(".."),
        "identity must be relative to path.",
      ),
    name: z
      .string()
      .min(1)
      .describe("Native package/catalog identity; never inferred from Toolfactory name."),
    versionCommand: z
      .string()
      .min(1)
      .describe("Command run in path that prints only the authored package version."),
    asset: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Repository-relative, author-built archive or installer when the manager consumes one.",
      ),
    tap: z
      .string()
      .min(1)
      .optional()
      .describe("Author-controlled Homebrew tap (owner/homebrew-tap)."),
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
    if (entry.id === "homebrew" && !entry.tap)
      context.addIssue({
        code: "custom",
        path: ["tap"],
        message: "Homebrew requires an author-controlled tap.",
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
  })
  .strict();
export type SystemPackageConfig = z.infer<typeof systemPackageConfigSchema>;

type SystemTool = Project["tool"] & { systemPackages?: SystemPackageConfig[] };
function quote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
function powershellQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
function all(project: Project): SystemPackageConfig[] {
  const values = ((project.tool as SystemTool).systemPackages ?? []).map((value) =>
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
  return (project.tool.surfaces as string[]).includes(id);
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
function destination(entry: SystemPackageConfig): string {
  return `dist/release/system/${entry.id}`;
}

const validators: Record<SystemPackageId, (entry: SystemPackageConfig) => Command[]> = {
  homebrew: (entry) => [
    {
      label: "Homebrew audit",
      command: "brew",
      args: ["audit", "--new", "--formula", `./${entry.identity}`],
      cwd: entry.path,
    },
    {
      label: "Homebrew source build",
      command: "brew",
      args: ["install", "--build-from-source", `./${entry.identity}`],
      cwd: entry.path,
    },
  ],
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
        `Get-Content -Raw ${entry.identity} | ConvertFrom-Json | Out-Null`,
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

export const systemPackageSurfaces: Surface[] = SYSTEM_PACKAGE_IDS.map((id) => ({
  id: id as Surface["id"],
  plan(project) {
    one(project, id);
    return [];
  },
  validate(project) {
    const entry = one(project, id);
    return validators[id](entry);
  },
}));

/** Required CLI preflight for local gate/package runs; CI jobs below install distro tooling where needed. */
export function systemToolchainSteps(project: Project): GateStep[] {
  const tool: Record<SystemPackageId, string> = {
    homebrew: "brew",
    winget: "winget",
    scoop: "powershell",
    chocolatey: "choco",
    apt: "dpkg-buildpackage",
    rpm: "rpmbuild",
  };
  return active(project).map((entry) => ({
    name: `${entry.id} upstream toolchain`,
    run: `command -v ${tool[entry.id]} >/dev/null || { echo "${entry.id}: install ${tool[entry.id]} before packaging" >&2; exit 1; }`,
  }));
}

/** Build actual package artifacts or stage the authored catalog submission, all at portable paths. */
export function systemPackageSteps(project: Project): GateStep[] {
  return active(project).flatMap((entry) => {
    const out = destination(entry);
    const asset = entry.asset ? quote(entry.asset) : undefined;
    const steps: GateStep[] = [
      { name: `${entry.id} version matches release`, run: versionAssert(project, entry) },
    ];
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
          run: `mkdir -p ${quote(out)} && (cd ${quote(entry.path)} && dpkg-buildpackage -S -sa -us -uc) && find ${quote(`${entry.path}/..`)} -maxdepth 1 -name '*.changes' -exec cp {} ${quote(out)} \\;`,
        });
        break;
      case "rpm":
        steps.push({
          name: "RPM source package",
          run: `mkdir -p ${quote(out)} && rpmbuild -bs ${quote(`${entry.path}/${entry.identity}`)} --define ${quote(`_sourcedir ${entry.path}`)} --define ${quote(`_srcrpmdir ${out}`)}`,
        });
        break;
    }
    return steps;
  });
}

function registry(project: Project, entry: SystemPackageConfig): Registry {
  const v = version(project, entry);
  const shared = {
    id: entry.id,
    surfaces: [entry.id],
    url: {
      homebrew: `https://github.com/${entry.tap}`,
      winget: "https://github.com/microsoft/winget-pkgs",
      scoop: "https://github.com/ScoopInstaller/Scoop",
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
      } as unknown as Registry;
    case "apt":
      return {
        ...shared,
        secrets: ["APT_GPG_PRIVATE_KEY", "APT_GPG_KEY_ID"],
        gate: '[ -n "$APT_GPG_PRIVATE_KEY" ] && [ -n "$APT_GPG_KEY_ID" ]',
        retractUrl: shared.url,
      } as unknown as Registry;
    case "rpm":
      return {
        ...shared,
        secrets: ["COPR_LOGIN", "COPR_TOKEN"],
        gate: '[ -n "$COPR_LOGIN" ] && [ -n "$COPR_TOKEN" ]',
        retractUrl: shared.url,
      } as unknown as Registry;
    case "homebrew":
    case "winget":
    case "scoop":
      return {
        ...shared,
        secrets: [],
        gate: "true",
        retractUrl: shared.url,
      } as unknown as Registry;
  }
}
export function systemRegistryRows(project: Project): Registry[] {
  return active(project).map((entry) => registry(project, entry));
}

type Job = Record<string, unknown>;
const download = (artifactDir: string) => ({
  uses: "actions/download-artifact@v8",
  with: { name: "release-assets", path: artifactDir },
});
const checkout = (sha: string) => ({ uses: "actions/checkout@v7", with: { ref: sha } });

/** Direct publication exists only for Chocolatey, Launchpad PPA and COPR. Catalogs remain reviewed submissions. */
export function systemPublishJobs(
  project: Project,
  artifactDir: string,
  releaseSha: string,
): Record<string, Job> {
  const jobs: Record<string, Job> = {};
  for (const entry of active(project)) {
    const base = {
      needs: ["gate", "package"],
      if: `needs.gate.outputs.${entry.id.replace(/-/g, "_")} == 'true'`,
      "runs-on": "ubuntu-latest",
      permissions: { contents: "read" },
    };
    const out = `${artifactDir}/system/${entry.id}`;
    if (entry.id === "chocolatey") {
      const packageName = powershellQuote(entry.name);
      const packageVersion = powershellQuote(version(project, entry));
      const published = powershellQuote(`${entry.name}|${version(project, entry)}`);
      jobs["publish-chocolatey"] = {
        ...base,
        "runs-on": "windows-latest",
        env: { CHOCOLATEY_API_KEY: "${{ secrets.CHOCOLATEY_API_KEY }}" },
        steps: [
          download(artifactDir),
          {
            run: `if (choco search ${packageName} --exact --version ${packageVersion} --limit-output | Select-String -SimpleMatch ${published}) { exit 0 }; Get-ChildItem ${powershellQuote(out)} -Filter *.nupkg | ForEach-Object { choco push $_.FullName --source https://push.chocolatey.org/ --api-key $env:CHOCOLATEY_API_KEY }`,
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
          checkout(releaseSha),
          { run: "sudo apt-get update && sudo apt-get install -y devscripts dput gnupg" },
          { run: 'printf "%s" "$APT_GPG_PRIVATE_KEY" | base64 --decode | gpg --batch --import' },
          {
            run: `cd ${quote(entry.path)} && debuild -S -sa -k"$APT_GPG_KEY_ID" && dput ${quote(`ppa:${entry.ppa ?? ""}`)} ../*.changes`,
          },
        ],
      };
    }
    if (entry.id === "rpm") {
      const spec = `${entry.path}/${entry.identity}`;
      jobs["publish-rpm"] = {
        ...base,
        container: "fedora:latest",
        env: { COPR_LOGIN: "${{ secrets.COPR_LOGIN }}", COPR_TOKEN: "${{ secrets.COPR_TOKEN }}" },
        steps: [
          checkout(releaseSha),
          { run: "dnf -y install rpm-build copr-cli" },
          {
            run: 'mkdir -p ~/.config && printf \'[copr-cli]\\nlogin = %s\\ntoken = %s\\n\' "$COPR_LOGIN" "$COPR_TOKEN" > ~/.config/copr',
          },
          {
            run: `rpmbuild -bs ${quote(spec)} --define ${quote(`_sourcedir ${entry.path}`)} --define ${quote("_srcrpmdir /tmp")}`,
          },
          { run: `copr-cli build --nowait ${quote(entry.coprProject ?? "")} /tmp/*.src.rpm` },
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
        homebrew: `\`brew install ${entry.tap}/${entry.name}\``,
        winget: `\`winget install ${entry.name}\``,
        scoop: `\`scoop install <bucket>/${entry.name}\``,
        chocolatey: `\`choco install ${entry.name}\``,
        apt: `add the ${entry.ppa} PPA, then \`apt install ${entry.name}\``,
        rpm: `enable COPR ${entry.coprProject}, then \`dnf install ${entry.name}\``,
      })[entry.id],
  );
}
