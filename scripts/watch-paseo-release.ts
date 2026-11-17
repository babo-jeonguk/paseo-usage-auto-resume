/**
 * Announces new Paseo releases as issues on this repository: see `paseo-release.ts` for which ones.
 * `--dry-run` reads npm and the issues but only prints what it would post.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import {
  commentBody,
  issueBody,
  issueTitle,
  planActions,
  readIssue,
  type DistTags,
  type WatchIssue,
} from "./paseo-release";

const TAGS_URL = "https://registry.npmjs.org/-/package/@getpaseo%2Fplugin/dist-tags";
const LABEL = "paseo-release";

function gh(args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile("gh", args, { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`gh ${args[0]} ${args[1]} failed: ${stderr.trim() || error.message}`));
      else resolve(stdout);
    });
    child.stdin?.end(input ?? "");
  });
}

async function fetchTags(): Promise<DistTags> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  let body: Record<string, unknown>;
  try {
    const response = await fetch(TAGS_URL, { signal: controller.signal });
    if (!response.ok) throw new Error(`npm registry answered ${response.status}`);
    body = (await response.json()) as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
  }
  const tag = (name: string) => (typeof body[name] === "string" ? (body[name] as string) : undefined);
  return { latest: tag("latest"), beta: tag("beta") };
}

async function readPinned(): Promise<string> {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
    devDependencies?: Record<string, string>;
  };
  const pinned = pkg.devDependencies?.["@getpaseo/plugin"];
  if (!pinned) throw new Error("@getpaseo/plugin is not a devDependency");
  return pinned;
}

async function readIssues(): Promise<WatchIssue[]> {
  const listed = JSON.parse(
    await gh(["issue", "list", "--state", "all", "--label", LABEL, "--limit", "200", "--json", "number,body,comments"]),
  ) as Array<{ number: number; body: string; comments: Array<{ body: string }> }>;
  return listed.flatMap((issue) => {
    const read = readIssue(issue.number, [issue.body, ...issue.comments.map((comment) => comment.body)]);
    return read ? [read] : [];
  });
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const owner = process.env.GITHUB_REPOSITORY_OWNER || undefined;
  const [tags, pinned, issues] = await Promise.all([fetchTags(), readPinned(), readIssues()]);
  const actions = planActions(tags, pinned, issues);
  console.log(JSON.stringify({ tags, pinned, issues, actions }));
  if (dryRun) return;
  for (const action of actions) {
    if (action.kind === "open") {
      await gh(["label", "create", LABEL, "--color", "0366d6", "--description", "New Paseo releases", "--force"]);
      const body = issueBody(action.line, action.version, pinned, owner);
      console.log(await gh(["issue", "create", "--title", issueTitle(action.line), "--label", LABEL, "--body-file", "-"], body));
    } else {
      console.log(await gh(["issue", "comment", String(action.issue), "--body-file", "-"], commentBody(action.version, owner)));
    }
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
