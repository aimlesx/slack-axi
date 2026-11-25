import { access, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const expectedPackageFiles = [
  "dist/**/*.js",
  "completions/_slky",
  "completions/slky.bash",
  "docs/slky.1",
  "skills/slky/SKILL.md",
  "slack-app-manifest.json",
  "npm-shrinkwrap.json",
  "README.md",
  "PRIVACY.md",
  "SECURITY.md",
  "LICENSE",
];

const expectedUserScopes = [
  "channels:history",
  "channels:read",
  "channels:write",
  "chat:write",
  "emoji:read",
  "files:read",
  "files:write",
  "groups:history",
  "groups:read",
  "groups:write",
  "im:history",
  "im:read",
  "im:write",
  "mpim:history",
  "mpim:read",
  "mpim:write",
  "reactions:read",
  "reactions:write",
  "search:read",
  "usergroups:read",
  "users:read",
  "users:read.email",
];

describe("package contract", () => {
  it("keeps local credential sources out of version control", async () => {
    const ignored = (await readFile(".gitignore", "utf8")).split(/\r?\n/);
    expect(ignored).toContain(".env");
    expect(ignored).toContain(".env.*");
    expect(ignored).toContain(".npmrc");
  });

  it("tests the executable installed from the packed artifact on both macOS architectures", async () => {
    const workflow = await readFile(".github/workflows/ci.yml", "utf8");
    expect(workflow).toContain("permissions:\n  contents: read");
    expect(workflow).toContain("macos-15-intel");
    expect(workflow).toContain("macos-15");
    expect(workflow).toContain("node-version: 24");
    expect(workflow).toContain("npm install --prefix");
    expect(workflow).toContain("node_modules/.bin/slky");
    expect(workflow).toContain("node_modules/@aimlesx/slky/skills/slky/SKILL.md");
    expect(workflow).not.toMatch(/uses:\s+[^\s]+@v\d/);
  });

  it("publishes exact version tags through a protected, non-cached npm release job", async () => {
    const workflow = await readFile(".github/workflows/publish.yml", "utf8");
    const verifyStart = workflow.indexOf("  verify:");
    const publishStart = workflow.indexOf("  publish:");
    const verifyJob = workflow.slice(verifyStart, publishStart);
    const publishJob = workflow.slice(publishStart);
    expect(verifyStart).toBeGreaterThan(-1);
    expect(publishStart).toBeGreaterThan(verifyStart);
    expect(workflow).toContain('tags:\n      - "v*"');
    expect(workflow).toContain("verify:");
    expect(workflow).toContain("publish:\n    needs: verify");
    expect(workflow).toMatch(/publish:[\s\S]+permissions:\n      contents: read\n      id-token: write/);
    expect(workflow).toContain("runs-on: macos-15");
    expect(workflow).toContain("environment: npm");
    expect(workflow).toContain("node-version: 24.18.1");
    expect(workflow).toContain("package-manager-cache: false");
    expect(workflow).not.toMatch(/^\s+cache:/m);
    expect(verifyJob).toContain("fetch-depth: 0");
    expect(verifyJob).toContain("persist-credentials: false");
    expect(verifyJob).not.toContain("id-token: write");
    expect(verifyJob).not.toContain("NODE_AUTH_TOKEN");
    expect(publishJob).not.toContain("actions/checkout");
    expect(publishJob).not.toContain("npm ci");
    expect(publishJob).not.toContain("npm install");
    expect(publishJob).not.toContain("npm run");
    expect(publishJob).not.toContain("npm test");
    expect(workflow).toContain('expected_tag="v${package_version}"');
    expect(workflow).toContain('"$GITHUB_REF_NAME" != "$expected_tag"');
    expect(workflow).toContain("git merge-base --is-ancestor");
    expect(workflow).not.toContain("npm install --global npm@");
    expect(workflow.match(/test "\$\(npm --version\)" = "11\.16\.0"/g)).toHaveLength(2);
    expect(workflow).toContain("npm ci");
    expect(workflow).toContain("npm run check");
    expect(workflow).toContain("npm test");
    expect(workflow).toContain("npm audit --audit-level=low");
    expect(workflow).toContain("npm pack --json");
    expect(workflow).toContain('npm install --prefix "$install_root"');
    expect(workflow).toContain('node_modules/.bin/slky');
    expect(workflow).toContain("release runner is not clean");
    expect(workflow).toContain("actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a");
    expect(workflow).toContain("actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c");
    expect(workflow).toContain("EXPECTED_SHA256");
    expect(workflow).toContain('.schema == "slky/v1" and .data.status == "setup_required"');
    expect(workflow).toContain("npm publish");
    expect(publishJob).toContain('test "$(npm --version)" = "11.16.0"');
    expect(workflow).toContain("--access public --provenance");
    expect(workflow).not.toContain("NODE_AUTH_TOKEN");
    expect(workflow).not.toContain("NPM_TOKEN");
    expect(workflow).toContain("group: npm-publish");
    expect(workflow).toContain("is already published; refusing to publish it again");
    expect(workflow).not.toMatch(/uses:\s+[^\s]+@v\d/);
  });

  it("publishes only the public runtime surface with public-source release metadata", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8"));
    const shrinkwrap = JSON.parse(await readFile("npm-shrinkwrap.json", "utf8"));
    expect(packageJson.name).toBe("@aimlesx/slky");
    expect(packageJson.bin).toEqual({ slky: "dist/index.js" });
    expect(shrinkwrap).toMatchObject({ name: packageJson.name, version: packageJson.version });
    expect(shrinkwrap.packages[""]).toMatchObject({ name: packageJson.name, version: packageJson.version, bin: packageJson.bin });
    expect(packageJson.files).toEqual(expectedPackageFiles);
    expect(packageJson.man).toBe("docs/slky.1");
    expect(packageJson.publishConfig).toEqual({ access: "public", provenance: true });
    expect(packageJson.repository).toEqual({ type: "git", url: "git+https://github.com/aimlesx/slky.git" });
    expect(packageJson.homepage).toBe("https://github.com/aimlesx/slky#readme");
    expect(packageJson.bugs).toEqual({ url: "https://github.com/aimlesx/slky/issues" });
    await expect(access("package-lock.json")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("ships the optional xoxp fallback manifest with no hosted integration surface", async () => {
    const manifest = JSON.parse(await readFile("slack-app-manifest.json", "utf8"));
    expect(manifest.oauth_config.scopes.user).toEqual(expectedUserScopes);
    expect(manifest.oauth_config.scopes).not.toHaveProperty("bot");
    expect(manifest).not.toHaveProperty("event_subscriptions");
    expect(manifest).not.toHaveProperty("interactivity");
    expect(manifest.oauth_config).not.toHaveProperty("redirect_urls");
    expect(manifest.settings).toMatchObject({ socket_mode_enabled: false, token_rotation_enabled: false });
  });
});
