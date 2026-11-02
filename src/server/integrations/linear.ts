import "server-only";
import { z } from "zod";

const LINEAR_URL = "https://api.linear.app/graphql";
const TIMEOUT_MS = 15_000;

const issueSchema = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  description: z.string().nullable().optional(),
  priority: z.number().nullable().optional(),
  url: z.string(),
});

export type LinearIssue = z.infer<typeof issueSchema>;

async function graphql(apiKey: string, query: string, variables: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(LINEAR_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: apiKey },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (response.status === 401) throw new Error("Linear recusou a API key");
  if (!response.ok) throw new Error(`Linear respondeu ${response.status}`);
  const body = (await response.json()) as { data?: unknown; errors?: { message: string }[] };
  if (body.errors?.length) throw new Error(`Linear: ${body.errors[0]?.message ?? "erro"}`);
  return body.data;
}

/** Open issues assigned to the API key owner. */
export async function listMyIssues(apiKey: string): Promise<readonly LinearIssue[]> {
  const data = await graphql(
    apiKey,
    `query { viewer { assignedIssues(first: 30, filter: { state: { type: { nin: ["completed", "canceled"] } } }) {
      nodes { id identifier title description priority url } } } }`,
    {},
  );
  const nodes = z
    .object({ viewer: z.object({ assignedIssues: z.object({ nodes: z.array(issueSchema) }) }) })
    .parse(data).viewer.assignedIssues.nodes;
  return nodes;
}

export async function getIssue(apiKey: string, id: string): Promise<LinearIssue> {
  const data = await graphql(apiKey, `query($id: String!) { issue(id: $id) { id identifier title description priority url } }`, { id });
  return z.object({ issue: issueSchema }).parse(data).issue;
}

export async function commentOnIssue(apiKey: string, issueId: string, body: string): Promise<void> {
  await graphql(apiKey, `mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }`, {
    input: { issueId, body },
  });
}

export async function verifyKey(apiKey: string): Promise<string> {
  const data = await graphql(apiKey, "query { viewer { name } }", {});
  return z.object({ viewer: z.object({ name: z.string() }) }).parse(data).viewer.name;
}

/** Linear priority 1..4 (0 = none) → Carbon priority. */
export function mapPriority(priority: number | null | undefined): "urgent" | "high" | "medium" | "low" {
  if (priority === 1) return "urgent";
  if (priority === 2) return "high";
  if (priority === 4) return "low";
  return "medium";
}
