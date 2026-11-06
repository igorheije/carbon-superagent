import { describe, expect, it } from "vitest";
import { renderK8s } from "./k8s";
import { FAKE_TOKEN, hasYamlParser, KIT_OPTIONS, REAL_SECRET_PATTERNS, yamlDoc } from "./kit-test-utils";
import { SetupKitError } from "./worker-kit";

const files = renderK8s(KIT_OPTIONS);
const YAML_FILES = ["deployment.yaml", "kustomization.yaml", "namespace.yaml", "networkpolicy.yaml", "secret.yaml"];
type Obj = Record<string, unknown>;
const at = (value: unknown, ...keys: (string | number)[]): unknown => keys.reduce<unknown>((cur, key) => (cur as Obj | undefined)?.[key as string], value);

describe("renderK8s", () => {
  it("renders the expected files (snapshot)", () => {
    expect(Object.keys(files).sort()).toEqual(["README.md", ...YAML_FILES]);
    expect(files).toMatchSnapshot();
  });

  it.each(YAML_FILES)("%s is valid YAML", (name) => {
    const doc = yamlDoc(files[name]);
    if (hasYamlParser) expect(doc).toHaveProperty("kind");
  });

  it("deployment: replicas, resources, grace period, non-root, emptyDir work dir, envFrom secret", () => {
    const doc = yamlDoc(files["deployment.yaml"]);
    expect(files["deployment.yaml"]).toContain("terminationGracePeriodSeconds: 600");
    if (!hasYamlParser) return;
    expect(at(doc, "spec", "replicas")).toBe(2);
    const pod = at(doc, "spec", "template", "spec") as Obj;
    expect(pod.terminationGracePeriodSeconds).toBe(600);
    expect(pod.automountServiceAccountToken).toBe(false);
    expect(pod.securityContext).toMatchObject({ runAsNonRoot: true, runAsUser: 10001 });
    expect(pod.volumes).toEqual([
      { name: "home", emptyDir: {} },
      { name: "tmp", emptyDir: {} },
    ]);
    const container = at(pod, "containers", 0) as Obj;
    expect(container.image).toBe(KIT_OPTIONS.image);
    expect(container.envFrom).toEqual([{ secretRef: { name: "carbon-worker" } }]);
    expect(container.resources).toEqual({ requests: { cpu: "1500m", memory: "4Gi" }, limits: { cpu: "1500m", memory: "4Gi" } });
    expect(container.securityContext).toMatchObject({ allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } });
    expect(container.env).toContainEqual({ name: "CARBON_WORKER_DIR", value: "/home/carbon/work" });
    expect(container.env).toContainEqual({ name: "CARBON_WORKER_PARALLEL", value: "3" });
    expect(container.env).toContainEqual({ name: "CARBON_PANEL_URL", value: KIT_OPTIONS.panelUrl });
    expect(at(doc, "spec", "selector", "matchLabels")).toEqual(at(doc, "spec", "template", "metadata", "labels"));
  });

  it("secret: token in stringData, credentials only as commented placeholders", () => {
    const doc = yamlDoc(files["secret.yaml"]);
    if (hasYamlParser) expect(doc.stringData).toEqual({ CARBON_WORKER_TOKEN: FAKE_TOKEN });
    for (const key of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY", "CARBON_GIT_TOKEN"]) {
      expect(files["secret.yaml"]).toContain(`  # ${key}: ""`);
    }
  });

  it("network policy allows no ingress and only egress", () => {
    const doc = yamlDoc(files["networkpolicy.yaml"]);
    if (!hasYamlParser) return;
    expect(doc.spec).toMatchObject({ policyTypes: ["Ingress", "Egress"], ingress: [], egress: [{}] });
  });

  it("kustomization lists every manifest in the worker namespace", () => {
    const doc = yamlDoc(files["kustomization.yaml"]);
    if (!hasYamlParser) return;
    expect(doc.namespace).toBe("carbon-maquina-sp-01");
    expect([...(doc.resources as string[])].sort()).toEqual(YAML_FILES.filter((f) => f !== "kustomization.yaml"));
  });

  it("writes the token only to secret.yaml", () => {
    for (const [name, content] of Object.entries(files)) {
      expect(content.includes(FAKE_TOKEN), name).toBe(name === "secret.yaml");
    }
  });

  it("contains no real AI/git secrets", () => {
    for (const content of Object.values(files)) {
      for (const pattern of REAL_SECRET_PATTERNS) expect(content).not.toMatch(pattern);
    }
  });

  it("rejects a workerName with a newline instead of rendering it", () => {
    expect(() => renderK8s({ ...KIT_OPTIONS, workerName: "a\nkind: ClusterRoleBinding" })).toThrow(SetupKitError);
  });

  it("README explains apply -k and scale", () => {
    expect(files["README.md"]).toContain("kubectl apply -k .");
    expect(files["README.md"]).toContain("kubectl -n carbon-maquina-sp-01 scale deployment/carbon-worker --replicas=N");
  });

  it("README gives the exact image build step: build+push for a registry image, build + registry hint for the default", () => {
    expect(files["README.md"]).toContain(`docker buildx build -f deploy/worker/Dockerfile --platform linux/amd64,linux/arm64 -t ${KIT_OPTIONS.image} --push .`);
    const bare = renderK8s({ ...KIT_OPTIONS, image: "carbon-worker:0.2.0" })["README.md"];
    expect(bare).toContain("docker buildx build -f deploy/worker/Dockerfile --platform linux/amd64,linux/arm64 -t <registry>/carbon-worker:0.2.0 --push .");
    expect(bare).toContain("carbon worker init --image <registry>/carbon-worker:0.2.0");
    expect(bare).toContain("não é publicada em nenhum registry");
  });
});
