/**
 * Native package registries are deliberately an escape hatch, not bindings.  A project may
 * carry a real Cargo/.NET/JVM/Ruby/PHP/Go package beside a Toolfactory TypeScript or Python
 * kernel, but Toolfactory never translates that kernel into another language or invents a
 * launcher to enter a registry.
 */
import { z } from "zod";
import type { Command, Project, Surface } from "../model.js";
import type { GateStep, Registry } from "../project/gate.js";

export const NATIVE_PACKAGE_IDS = [
  "cargo",
  "nuget",
  "maven-central",
  "rubygems",
  "packagist",
  "go-module",
] as const;
export type NativePackageId = (typeof NATIVE_PACKAGE_IDS)[number];

/**
 * `name` is intentionally not derived from the Toolfactory identity: package namespaces have
 * their own ownership rules. A standard per-ecosystem version read is used unless the author
 * needs a `versionCommand` escape hatch.
 */
export const nativePackageConfigSchema = z
  .object({
    id: z.enum(NATIVE_PACKAGE_IDS),
    path: z
      .string()
      .min(1)
      .refine(
        (path) => !path.startsWith("/") && !path.split("/").includes(".."),
        "path must stay inside the repository.",
      ),
    identity: z
      .string()
      .min(1)
      .refine(
        (path) => !path.startsWith("/") && !path.split("/").includes(".."),
        "identity must be relative to path.",
      ),
    name: z
      .string()
      .min(1)
      .describe("Registry package identity, including its required namespace."),
    versionCommand: z
      .string()
      .min(1)
      .optional()
      .describe("Command run in path that prints exactly the authored native package version."),
  })
  .superRefine((entry, context) => {
    if (entry.id === "maven-central" && entry.name.split(":").length !== 2)
      context.addIssue({
        code: "custom",
        path: ["name"],
        message: "Maven Central name must be groupId:artifactId.",
      });
    if ((entry.id === "packagist" || entry.id === "go-module") && entry.path !== ".")
      context.addIssue({
        code: "custom",
        path: ["path"],
        message: `${entry.id} is VCS/tag-discovered and currently requires package path ".".`,
      });
  })
  .strict();
export type NativePackageConfig = z.infer<typeof nativePackageConfigSchema>;

type NativeTool = Project["tool"] & { nativePackages?: NativePackageConfig[] };
function configs(project: Project): NativePackageConfig[] {
  const raw = (project.tool as NativeTool).nativePackages ?? [];
  const parsed = raw.map((entry) => nativePackageConfigSchema.parse(entry));
  const duplicates = parsed.filter(
    (entry, index) => parsed.findIndex((other) => other.id === entry.id) !== index,
  );
  if (duplicates.length)
    throw new Error(
      `Native package configuration repeats: ${[...new Set(duplicates.map((entry) => entry.id))].join(", ")}.`,
    );
  return parsed;
}
function selected(project: Project, id: NativePackageId): boolean {
  return (project.tool.surfaces as string[]).includes(id);
}
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
function defaultVersionCommand(entry: NativePackageConfig): string {
  const identity = shellQuote(entry.identity);
  switch (entry.id) {
    case "cargo":
      return `cargo metadata --no-deps --format-version 1 --manifest-path ${identity} | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).packages[0].version))'`;
    case "nuget":
      return `dotnet msbuild ${identity} -nologo -getProperty:Version | sed -n 's/^Version=//p'`;
    case "maven-central":
      return `mvn --quiet --file ${identity} -DforceStdout help:evaluate -Dexpression=project.version`;
    case "rubygems":
      return `ruby -e 'puts Gem::Specification.load(ARGV[0]).version' ${identity}`;
    case "packagist":
    case "go-module":
      return "git describe --tags --abbrev=0 | sed 's/^v//'";
  }
}
function versionAssert(entry: NativePackageConfig, version: string | undefined): string {
  if (!version)
    throw new Error(
      `Native package "${entry.name}" requires the shared identity to declare version.`,
    );
  return `test "$(${entry.versionCommand ?? defaultVersionCommand(entry)})" = ${shellQuote(version)}`;
}
function configFor(project: Project, id: NativePackageId): NativePackageConfig {
  const matches = configs(project).filter((entry) => entry.id === id);
  if (matches.length !== 1)
    throw new Error(
      `Surface "${id}" requires exactly one tool.nativePackages entry with id "${id}".`,
    );
  const entry = matches[0] as NativePackageConfig;
  if ((id === "packagist" || id === "go-module") && !project.identity.repository)
    throw new Error(
      `Surface "${id}" requires identity.repository because it is discovered from the final Git tag.`,
    );
  return entry;
}
function activeConfigs(project: Project): NativePackageConfig[] {
  return NATIVE_PACKAGE_IDS.filter((id) => selected(project, id)).map((id) =>
    configFor(project, id),
  );
}
function entryVersion(project: Project, entry: NativePackageConfig): string {
  if (!project.identity.version)
    throw new Error(
      `Native package "${entry.name}" requires the shared identity to declare version.`,
    );
  return project.identity.version;
}

const commands: Record<NativePackageId, (entry: NativePackageConfig) => Command[]> = {
  cargo: (entry) => [
    {
      label: "Cargo package",
      command: "cargo",
      args: ["package", "--manifest-path", entry.identity],
      cwd: entry.path,
    },
  ],
  nuget: (entry) => [
    {
      label: "NuGet pack",
      command: "dotnet",
      args: ["pack", entry.identity, "--configuration", "Release"],
      cwd: entry.path,
    },
  ],
  "maven-central": (entry) => [
    {
      label: "Maven verify",
      command: "mvn",
      args: ["--batch-mode", "--file", entry.identity, "verify"],
      cwd: entry.path,
    },
  ],
  rubygems: (entry) => [
    {
      label: "RubyGems build",
      command: "gem",
      args: ["build", "--strict", entry.identity],
      cwd: entry.path,
    },
  ],
  packagist: (entry) => [
    {
      label: "Composer validate",
      command: "composer",
      args: ["validate", "--strict", "--no-check-publish"],
      cwd: entry.path,
    },
  ],
  "go-module": (entry) => [
    { label: "Go module tidy", command: "go", args: ["mod", "tidy"], cwd: entry.path },
    { label: "Go module tests", command: "go", args: ["test", "./..."], cwd: entry.path },
  ],
};

/** External registries do not generate files: their package metadata remains author-owned. */
export const nativePackageSurfaces: Surface[] = NATIVE_PACKAGE_IDS.map((id) => ({
  // Root extends SurfaceId with this tuple. Keep this module independently type-checkable first.
  id: id as Surface["id"],
  plan(project) {
    configFor(project, id);
    return [];
  },
  validate(project) {
    const entry = configFor(project, id);
    return commands[id](entry).map((command) => ({ ...command, cwd: entry.path }));
  },
}));

/**
 * Release packaging happens after the main package build. VCS registries deliberately have no
 * artifact: their published object is the signed Git tag and repository contents.
 */
export function nativePackageSteps(project: Project): GateStep[] {
  return activeConfigs(project).flatMap((entry) => {
    const directory = shellQuote(entry.path);
    const out = `dist/release/native/${entry.id}`;
    const check = versionAssert(entry, project.identity.version);
    const steps: GateStep[] = [
      { name: `${entry.id} version matches release`, run: `cd ${directory} && ${check}` },
    ];
    switch (entry.id) {
      case "cargo":
        steps.push({
          name: "Cargo crate",
          run: `mkdir -p ${shellQuote(out)} && cargo package --manifest-path ${shellQuote(`${entry.path}/${entry.identity}`)} && cp ${shellQuote(`${entry.path}/target/package`)}/*.crate ${shellQuote(out)}/`,
        });
        break;
      case "nuget":
        steps.push({
          name: "NuGet package",
          run: `mkdir -p ${shellQuote(out)} && dotnet pack ${shellQuote(`${entry.path}/${entry.identity}`)} --configuration Release --output ${shellQuote(out)}`,
        });
        break;
      case "maven-central":
        steps.push({
          name: "Maven package",
          run: `mkdir -p ${shellQuote(out)} && mvn --batch-mode --file ${shellQuote(`${entry.path}/${entry.identity}`)} package && find ${shellQuote(`${entry.path}/target`)} -maxdepth 1 -type f \\( -name '*.jar' -o -name '*.pom' \\) -exec cp {} ${shellQuote(out)} \\;`,
        });
        break;
      case "rubygems":
        steps.push({
          name: "Ruby gem",
          run: `mkdir -p ${shellQuote(out)} && gem build --strict ${shellQuote(`${entry.path}/${entry.identity}`)} --output ${shellQuote(`${out}/${entry.name}-${project.identity.version}.gem`)}`,
        });
        break;
      case "packagist":
      case "go-module":
        // A tag is the package. Packaging an archive here would falsely imply an upload protocol.
        break;
    }
    return steps;
  });
}

/**
 * Kept with the release contract so local `gate` and the package job fail before a package
 * command with a clear missing-tool message. GitHub's hosted Linux image supplies these upstream
 * clients; callers that use another runner can install its normal distro packages first.
 */
export function nativeToolchainSteps(project: Project): GateStep[] {
  const tools: Record<NativePackageId, string> = {
    cargo: "cargo",
    nuget: "dotnet",
    "maven-central": "mvn",
    rubygems: "gem",
    packagist: "composer",
    "go-module": "go",
  };
  return activeConfigs(project).map((entry) => ({
    name: `${entry.id} upstream toolchain`,
    run: `command -v ${tools[entry.id]} >/dev/null || { echo "${entry.id}: install its upstream ${tools[entry.id]} CLI before packaging" >&2; exit 1; }`,
  }));
}

function row(project: Project, entry: NativePackageConfig): Registry {
  const version = entryVersion(project, entry);
  const [groupId = "", artifactId = ""] = entry.name.split(":");
  const mavenSearch = `https://search.maven.org/solrsearch/select?q=${encodeURIComponent(`g:"${groupId}" AND a:"${artifactId}" AND v:"${version}"`)}&rows=1&wt=json`;
  const shared = {
    id: entry.id,
    surfaces: [entry.id],
    url: {
      cargo: "https://crates.io/settings/tokens",
      nuget: "https://www.nuget.org/account/apikeys",
      "maven-central": "https://central.sonatype.com/account",
      rubygems: "https://rubygems.org/profile/edit",
      packagist: "https://packagist.org/about",
      "go-module": "https://go.dev/doc/modules/publishing",
    }[entry.id],
  };
  switch (entry.id) {
    case "cargo":
      return {
        ...shared,
        secrets: ["CARGO_REGISTRY_TOKEN"],
        exists: `curl -fsS -o /dev/null ${shellQuote(`https://crates.io/api/v1/crates/${encodeURIComponent(entry.name)}/${encodeURIComponent(version)}`)}`,
        gate: '[ -n "$CARGO_REGISTRY_TOKEN" ]',
        retract: `cargo yank ${shellQuote(entry.name)} --vers ${shellQuote(version)} --token "$CARGO_REGISTRY_TOKEN"`,
      } as unknown as Registry;
    case "nuget":
      return {
        ...shared,
        secrets: ["NUGET_API_KEY"],
        exists: `curl -fsS -o /dev/null ${shellQuote(`https://api.nuget.org/v3-flatcontainer/${entry.name.toLowerCase()}/${version.toLowerCase()}/${entry.name.toLowerCase()}.${version.toLowerCase()}.nupkg`)}`,
        gate: '[ -n "$NUGET_API_KEY" ]',
        retract: `dotnet nuget delete ${shellQuote(entry.name)} ${shellQuote(version)} --api-key "$NUGET_API_KEY" --source https://api.nuget.org/v3/index.json --non-interactive`,
      } as unknown as Registry;
    case "maven-central":
      return {
        ...shared,
        secrets: [
          "MAVEN_CENTRAL_USERNAME",
          "MAVEN_CENTRAL_PASSWORD",
          "MAVEN_GPG_PRIVATE_KEY",
          "MAVEN_GPG_PASSPHRASE",
        ],
        exists: `curl -fsS ${shellQuote(mavenSearch)} | node -e ${shellQuote("let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.exit(JSON.parse(s).response.numFound>0?0:1))")}`,
        gate: '[ -n "$MAVEN_CENTRAL_USERNAME" ] && [ -n "$MAVEN_CENTRAL_PASSWORD" ] && [ -n "$MAVEN_GPG_PRIVATE_KEY" ] && [ -n "$MAVEN_GPG_PASSPHRASE" ]',
        retractUrl: "https://central.sonatype.com/publishing/deployments",
      } as unknown as Registry;
    case "rubygems":
      return {
        ...shared,
        secrets: ["RUBYGEMS_API_KEY"],
        exists: `curl -fsS ${shellQuote(`https://rubygems.org/api/v1/versions/${encodeURIComponent(entry.name)}.json`)} | node -e ${shellQuote(`let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.exit(JSON.parse(s).some(v=>v.number===${JSON.stringify(version)})?0:1))`)}`,
        gate: '[ -n "$RUBYGEMS_API_KEY" ]',
        retract: `GEM_HOST_API_KEY="$RUBYGEMS_API_KEY" gem yank ${shellQuote(entry.name)} -v ${shellQuote(version)}`,
      } as unknown as Registry;
    case "packagist":
      return {
        ...shared,
        secrets: [],
        gate: "true",
        retractUrl: "https://packagist.org/packages",
      } as unknown as Registry;
    case "go-module":
      return {
        ...shared,
        secrets: [],
        gate: "true",
        retractUrl: "https://go.dev/ref/mod#go-mod-file-retract-directive",
      } as unknown as Registry;
  }
}

export function nativeRegistryRows(project: Project): Registry[] {
  return activeConfigs(project).map((entry) => row(project, entry));
}

type Job = Record<string, unknown>;
const checkout = (releaseSha: string) => ({
  uses: "actions/checkout@v7",
  with: { ref: releaseSha },
});
const download = (artifactDir: string) => ({
  uses: "actions/download-artifact@v8",
  with: { name: "release-assets", path: artifactDir },
});

/** GitHub Actions jobs use the upstream language tool and package client directly. */
export function nativePublishJobs(
  project: Project,
  artifactDir: string,
  releaseSha: string,
): Record<string, Job> {
  return Object.fromEntries(
    activeConfigs(project).flatMap((entry) => {
      if (entry.id === "packagist" || entry.id === "go-module") return [];
      const path = entry.path;
      const base = {
        needs: ["gate", "package"],
        if: `needs.gate.outputs.${entry.id.replace(/-/g, "_")} == 'true'`,
        "runs-on": "ubuntu-latest",
        permissions: { contents: "read", "id-token": "write" },
      };
      let job: Job;
      switch (entry.id) {
        case "cargo":
          job = {
            ...base,
            env: { CARGO_REGISTRY_TOKEN: "${{ secrets.CARGO_REGISTRY_TOKEN }}" },
            steps: [
              checkout(releaseSha),
              { run: "cargo --version" },
              {
                run: `cd ${shellQuote(path)} && ${versionAssert(entry, project.identity.version)} && cargo publish --manifest-path ${shellQuote(entry.identity)} --token "$CARGO_REGISTRY_TOKEN"`,
              },
            ],
          };
          break;
        case "nuget":
          job = {
            ...base,
            env: { NUGET_API_KEY: "${{ secrets.NUGET_API_KEY }}" },
            steps: [
              { uses: "actions/setup-dotnet@v5" },
              { run: "dotnet --info" },
              download(artifactDir),
              {
                run: `find ${shellQuote(`${artifactDir}/native/nuget`)} -maxdepth 1 -name '*.nupkg' -print0 | xargs -0 -r -n1 sh -c 'dotnet nuget push "$0" --api-key "$NUGET_API_KEY" --source https://api.nuget.org/v3/index.json --skip-duplicate'`,
              },
            ],
          };
          break;
        case "maven-central":
          job = {
            ...base,
            env: {
              MAVEN_CENTRAL_USERNAME: "${{ secrets.MAVEN_CENTRAL_USERNAME }}",
              MAVEN_CENTRAL_PASSWORD: "${{ secrets.MAVEN_CENTRAL_PASSWORD }}",
              MAVEN_GPG_PRIVATE_KEY: "${{ secrets.MAVEN_GPG_PRIVATE_KEY }}",
              MAVEN_GPG_PASSPHRASE: "${{ secrets.MAVEN_GPG_PASSPHRASE }}",
            },
            steps: [
              checkout(releaseSha),
              {
                uses: "actions/setup-java@v5",
                with: {
                  distribution: "temurin",
                  "java-version": "21",
                  cache: "maven",
                  "server-id": "central",
                  "server-username": "MAVEN_CENTRAL_USERNAME",
                  "server-password": "MAVEN_CENTRAL_PASSWORD",
                },
              },
              { run: 'echo "$MAVEN_GPG_PRIVATE_KEY" | base64 --decode | gpg --batch --import' },
              {
                run: `cd ${shellQuote(path)} && ${versionAssert(entry, project.identity.version)} && mvn --batch-mode --file ${shellQuote(entry.identity)} -DskipTests -Dgpg.passphrase="$MAVEN_GPG_PASSPHRASE" deploy`,
              },
            ],
          };
          break;
        case "rubygems":
          job = {
            ...base,
            env: { GEM_HOST_API_KEY: "${{ secrets.RUBYGEMS_API_KEY }}" },
            steps: [
              { run: "gem --version" },
              download(artifactDir),
              {
                run: `gem push ${shellQuote(`${artifactDir}/native/rubygems/${entry.name}-${project.identity.version}.gem`)}`,
              },
            ],
          };
          break;
      }
      return [[`publish-${entry.id}`, job]];
    }),
  );
}

export function nativeInstallLines(project: Project): string[] {
  return activeConfigs(project).map(
    (entry) =>
      ({
        cargo: `\`cargo install ${entry.name}\``,
        nuget: `\`dotnet add package ${entry.name}\``,
        "maven-central": `add \`${entry.name}\` as a Maven dependency`,
        rubygems: `\`gem install ${entry.name}\``,
        packagist: `\`composer require ${entry.name}\``,
        "go-module": `\`go get ${entry.name}@v${project.identity.version ?? "latest"}\``,
      })[entry.id],
  );
}
