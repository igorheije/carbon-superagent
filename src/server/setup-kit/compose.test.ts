import { describe, expect, it } from "vitest";
import { composeCpus, composeMemory, renderCompose } from "./compose";
import { FAKE_TOKEN, hasYamlParser, KIT_OPTIONS, REAL_SECRET_PATTERNS, yamlDoc } from "./kit-test-utils";
import { SetupKitError } from "./worker-kit";

const files = renderCompose(KIT_OPTIONS);

describe("renderCompose", () => {
  it("renders the expected files (snapshot)", () => {
    expect(Object.keys(files).sort()).toEqual([".env", "README.md", "docker-compose.yml"]);
    expect(files).toMatchSnapshot();
  });

  it("is pure", () => {
    expect(renderCompose(KIT_OPTIONS)).toEqual(files);
  });

  it("docker-compose.yml is valid YAML with the worker service contract", () => {
    const doc = yamlDoc(files["docker-compose.yml"]);
    expect(files["docker-compose.yml"]).not.toMatch(/\bports:/);
    if (!hasYamlParser) return;
    const worker = (doc.services as Record<string, Record<string, unknown>>).worker;
    expect(worker).toMatchObject({
      image: KIT_OPTIONS.image,
      env_file: ".env",
      restart: "unless-stopped",
      stop_grace_period: "150s",
      environment: { CARBON_WORKER_DIR: "/home/carbon/work" },
      volumes: ["carbon-worker-maquina-sp-01:/home/carbon/work"],
      deploy: { replicas: 2, resources: { limits: { cpus: "1.5", memory: "4g" } } },
    });
    expect(worker).not.toHaveProperty("ports");
    expect(worker).not.toHaveProperty("container_name");
    expect(doc.volumes).toEqual({ "carbon-worker-maquina-sp-01": {} });
  });

  it(".env carries the panel config and commented placeholders only", () => {
    const env = files[".env"];
    expect(env).toContain(`CARBON_PANEL_URL=${KIT_OPTIONS.panelUrl}\n`);
    expect(env).toContain(`CARBON_WORKER_TOKEN=${FAKE_TOKEN}\n`);
    expect(env).toContain("CARBON_WORKER_PARALLEL=3\n");
    expect(env).toContain("CARBON_WORKER_EXECUTORS=claude,codex\n");
    for (const key of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY", "CARBON_GIT_TOKEN"]) {
      expect(env).toContain(`# ${key}=\n`);
    }
    const assignments = env.split("\n").filter((line) => line && !line.startsWith("#"));
    expect(assignments.every((line) => /^[A-Z_]+=[^\s"'`$\\]+$/.test(line))).toBe(true);
  });

  it("writes the token only to .env", () => {
    for (const [name, content] of Object.entries(files)) {
      expect(content.includes(FAKE_TOKEN), name).toBe(name === ".env");
    }
  });

  it("contains no real AI/git secrets", () => {
    for (const content of Object.values(files)) {
      for (const pattern of REAL_SECRET_PATTERNS) expect(content).not.toMatch(pattern);
    }
  });

  it("rejects a workerName with a newline instead of rendering it", () => {
    expect(() => renderCompose({ ...KIT_OPTIONS, workerName: "a\nservices: {}" })).toThrow(SetupKitError);
  });

  it("README explains scale, logs and token revocation", () => {
    expect(files["README.md"]).toContain("docker compose up -d --scale worker=N");
    expect(files["README.md"]).toContain("docker compose logs -f worker");
    expect(files["README.md"]).toContain("Revogar");
  });
});

describe("compose resource conversion", () => {
  it("converts Kubernetes quantities", () => {
    expect(composeCpus("500m")).toBe("0.5");
    expect(composeCpus("2")).toBe("2");
    expect(composeMemory("512Mi")).toBe("512m");
    expect(composeMemory("4Gi")).toBe("4g");
  });

  it("README gives the exact image build step: build+push for a registry image, build + registry hint for the default", () => {
    expect(files["README.md"]).toContain(`docker build -f deploy/worker/Dockerfile -t ${KIT_OPTIONS.image} . && docker push ${KIT_OPTIONS.image}`);
    const bare = renderCompose({ ...KIT_OPTIONS, image: "carbon-worker:0.2.0" })["README.md"];
    expect(bare).toContain("docker build -f deploy/worker/Dockerfile -t carbon-worker:0.2.0 .");
    expect(bare).toContain("carbon worker init --image <registry>/carbon-worker:0.2.0");
    expect(bare).toContain("não é publicada em nenhum registry");
  });
});
