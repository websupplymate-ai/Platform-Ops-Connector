/**
 * SupplyMate AI Platform — Platform Ops Connector
 * Powers three Founder Tools from one service: Repository Overview,
 * Deployment Overview, and Infrastructure Monitoring.
 * Same principle as platform-data-connector (Doc 03 §10): apps never talk
 * to GitHub or Cloudflare directly, they talk to this Worker.
 *
 * Routes:
 *   GET /health
 *   GET /repos           -> GitHub: every repo in the org, latest commit
 *   GET /deployments     -> Cloudflare: every Worker, last deployed
 *   GET /infrastructure  -> Cloudflare: requests/errors per Worker, last 24h
 */

const GITHUB_ORG = "websupplymate-ai";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

async function githubFetch(path, token) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "supplymate-platform-ops-connector",
      Accept: "application/vnd.github+json",
    },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
  return res.json();
}

async function cloudflareFetch(path, token, method = "GET", body) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok || !data.success) {
    throw new Error(`Cloudflare API error: ${JSON.stringify(data.errors || data)}`);
  }
  return data;
}

async function getRepos(env) {
  // websupplymate-ai might be a GitHub Organization or a personal account —
  // these use different API endpoints. Try org first, fall back to user.
  let repos;
  try {
    repos = await githubFetch(`/orgs/${GITHUB_ORG}/repos?per_page=50`, env.GITHUB_TOKEN);
  } catch (err) {
    if (!String(err.message).includes("404")) throw err;
    repos = await githubFetch(`/users/${GITHUB_ORG}/repos?per_page=50`, env.GITHUB_TOKEN);
  }
  const withCommits = await Promise.all(
    repos.map(async (r) => {
      let latestCommit = null;
      try {
        const commits = await githubFetch(
          `/repos/${GITHUB_ORG}/${r.name}/commits?per_page=1`,
          env.GITHUB_TOKEN
        );
        if (commits[0]) {
          latestCommit = {
            sha: commits[0].sha.slice(0, 7),
            message: commits[0].commit.message.split("\n")[0],
            author: commits[0].commit.author.name,
            date: commits[0].commit.author.date,
          };
        }
      } catch {
        // empty repo or no commits yet — leave latestCommit null
      }
      return {
        name: r.name,
        description: r.description,
        defaultBranch: r.default_branch,
        url: r.html_url,
        language: r.language,
        updatedAt: r.updated_at,
        latestCommit,
      };
    })
  );
  return withCommits;
}

async function getDeployments(env) {
  const data = await cloudflareFetch(
    `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts`,
    env.CLOUDFLARE_API_TOKEN
  );
  return data.result.map((w) => ({
    name: w.id,
    createdOn: w.created_on,
    modifiedOn: w.modified_on,
  }));
}

async function getInfrastructure(env) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const until = new Date().toISOString();
  const query = `
    query {
      viewer {
        accounts(filter: { accountTag: "${env.CLOUDFLARE_ACCOUNT_ID}" }) {
          workersInvocationsAdaptive(
            limit: 100
            filter: { datetime_geq: "${since}", datetime_leq: "${until}" }
          ) {
            sum { requests errors }
            dimensions { scriptName }
          }
        }
      }
    }`;
  const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  });
  const data = await res.json();
  if (data.errors) throw new Error(`Cloudflare GraphQL error: ${JSON.stringify(data.errors)}`);

  const rows = data.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive || [];
  return rows.map((r) => {
    const requests = r.sum.requests || 0;
    const errors = r.sum.errors || 0;
    return {
      name: r.dimensions.scriptName,
      requests24h: requests,
      errors24h: errors,
      errorRatePct: requests > 0 ? +((errors / requests) * 100).toFixed(2) : 0,
      status: errors === 0 ? "Operational" : errors / Math.max(requests, 1) > 0.05 ? "Degraded" : "Operational",
    };
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    if (url.pathname === "/health") {
      return jsonResponse({ status: "ok", service: "platform-ops-connector" });
    }

    const cache = caches.default;
    const cacheKey = new Request(url.toString(), request);
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    try {
      let payload;
      if (url.pathname === "/repos") {
        payload = { repos: await getRepos(env) };
      } else if (url.pathname === "/deployments") {
        payload = { deployments: await getDeployments(env) };
      } else if (url.pathname === "/infrastructure") {
        payload = { workers: await getInfrastructure(env) };
      } else {
        return jsonResponse(
          { error: "Use /repos, /deployments, or /infrastructure" },
          400
        );
      }
      const response = jsonResponse({ ...payload, cachedAt: new Date().toISOString() });
      response.headers.set("Cache-Control", "public, max-age=120");
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
      return response;
    } catch (err) {
      return jsonResponse({ error: err.message }, 502);
    }
  },
};
