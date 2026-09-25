import { docRoute } from "../lib/routes.js";

export type DocGroup =
  | "Start here"
  | "Use cases"
  | "Compare"
  | "Understand"
  | "Deploy and operate"
  | "Reference";

export type DocMeta = {
  id: string;
  title: string;
  description: string;
  group: DocGroup;
  order: number;
  keywords?: string[];
  featured?: boolean;
};

export const docs: DocMeta[] = [
  {
    id: "quickstart",
    title: "Quickstart",
    description:
      "Install ThimbleDB, choose an authority, connect external identity, and create the browser client.",
    group: "Start here",
    order: 10,
    featured: true,
  },
  {
    id: "development",
    title: "Local development",
    description:
      "Scaffold a local app, use the safe development identity, and move to production OIDC.",
    group: "Start here",
    order: 12,
    featured: true,
  },
  {
    id: "use-cases",
    title: "Use cases",
    description:
      "Check whether a small web application fits ThimbleDB before choosing a storage model.",
    group: "Start here",
    order: 20,
    featured: true,
  },
  {
    id: "vibe-coded-apps",
    title: "Should you use ThimbleDB?",
    description:
      "Use an exact fit check to decide whether a vibe-coded or AI-assisted small app matches ThimbleDB.",
    group: "Start here",
    order: 15,
    featured: true,
  },
  {
    id: "tradeoffs",
    title: "Tradeoffs",
    description:
      "Review verified behaviour, open questions, introduced costs, and workloads that need another database.",
    group: "Start here",
    order: 30,
    featured: true,
  },
  {
    id: "implementation-prompts",
    title: "Implementation prompts",
    description:
      "Copy practical integration, deployment, migration, and security-review prompts into a coding tool.",
    group: "Start here",
    order: 40,
  },
  {
    id: "examples",
    title: "Starter examples",
    description:
      "Use maintained Node and Cloudflare repository templates or run the checked-in package examples.",
    group: "Start here",
    order: 45,
    featured: true,
  },
  {
    id: "use-cases/per-user-workspace",
    title: "Per-user workspace and drafts",
    description:
      "Model settings, drafts, and user-owned records with stable identity scopes and bounded collections.",
    group: "Use cases",
    order: 10,
  },
  {
    id: "use-cases/tenant-operations",
    title: "Multi-tenant operations portal",
    description:
      "Separate tenant and user records for a read-heavy internal operations application.",
    group: "Use cases",
    order: 20,
  },
  {
    id: "use-cases/field-guide",
    title: "Field guide and inspections",
    description:
      "Keep reference material available from browser cache while submitting connected inspection records.",
    group: "Use cases",
    order: 30,
  },
  {
    id: "use-cases/catalogue",
    title: "Catalogue or reference library",
    description:
      "Serve a small bounded catalogue with snapshot reads and measured growth thresholds.",
    group: "Use cases",
    order: 40,
  },
  {
    id: "use-cases/progress-journal",
    title: "Progress or activity journal",
    description:
      "Store user-owned entries, summaries, and profile data without a separate database engine.",
    group: "Use cases",
    order: 50,
  },
  {
    id: "use-cases/ai-context",
    title: "Structured AI application context",
    description:
      "Keep bounded preferences and task context separate from model prompts and provider tokens.",
    group: "Use cases",
    order: 60,
  },
  {
    id: "comparisons",
    title: "Database comparisons",
    description:
      "Compare ThimbleDB with D1, SQLite, Firestore, lowdb, and direct object storage by workload.",
    group: "Compare",
    order: 10,
    featured: true,
  },
  {
    id: "compare/cloudflare-d1",
    title: "ThimbleDB and Cloudflare D1",
    description:
      "Choose between an object-storage protocol and Cloudflare's managed SQLite-compatible database.",
    group: "Compare",
    order: 20,
  },
  {
    id: "compare/sqlite",
    title: "ThimbleDB and SQLite",
    description:
      "Compare browser-cached object storage with a mature embedded transactional SQL engine.",
    group: "Compare",
    order: 30,
  },
  {
    id: "compare/firestore",
    title: "ThimbleDB and Firestore",
    description:
      "Compare application-owned object storage with managed document queries, listeners, and offline writes.",
    group: "Compare",
    order: 40,
  },
  {
    id: "compare/lowdb",
    title: "ThimbleDB and lowdb",
    description:
      "Compare a hosted browser-and-authority protocol with a lightweight local JSON database.",
    group: "Compare",
    order: 50,
  },
  {
    id: "compare/object-storage",
    title: "ThimbleDB and direct object storage",
    description:
      "Decide whether direct JSON objects are enough or a versioned storage protocol is justified.",
    group: "Compare",
    order: 60,
  },
  {
    id: "architecture",
    title: "Architecture",
    description:
      "Understand the browser cache, authority boundary, object storage source of truth, and scope model.",
    group: "Understand",
    order: 10,
    featured: true,
  },
  {
    id: "authority-deployment",
    title: "Authority deployment modes",
    description:
      "Choose an embedded or separately deployed authority and preserve the browser origin, secret, and operations boundaries.",
    group: "Understand",
    order: 15,
    featured: true,
  },
  {
    id: "diagrams",
    title: "System diagrams",
    description:
      "Review trust boundaries, query and index flows, key rotation, service access, migration, and provider topology.",
    group: "Understand",
    order: 20,
  },
  {
    id: "storage-providers",
    title: "Storage providers",
    description:
      "Compare Cloudflare R2, local files, Azure Blob Storage, Amazon S3, and S3-compatible systems.",
    group: "Understand",
    order: 30,
  },
  {
    id: "authentication",
    title: "Authentication and identity",
    description:
      "Use external OIDC identities, stable internal user IDs, revocable sessions, and explicit scope grants.",
    group: "Understand",
    order: 40,
  },
  {
    id: "service-access",
    title: "Machine and service access",
    description:
      "Generate Entra roles, authenticate service principals, and keep live viewers within explicit scope grants.",
    group: "Understand",
    order: 45,
    featured: true,
  },
  {
    id: "studio",
    title: "ThimbleDB Studio",
    description:
      "Host the packaged management frontend for scoped browsing, queries, index health, exports, and guarded operations.",
    group: "Start here",
    order: 18,
    featured: true,
  },
  {
    id: "security",
    title: "Security model",
    description:
      "Review trust boundaries, encryption, key handling, revocation limits, browser risks, and threat assumptions.",
    group: "Understand",
    order: 50,
    featured: true,
  },
  {
    id: "protocol",
    title: "Object protocol",
    description:
      "Inspect the TDB1 envelope, authenticated object keys, trie and snapshot layouts, and conditional writes.",
    group: "Understand",
    order: 60,
  },
  {
    id: "adaptive-layouts",
    title: "Adaptive collection layouts",
    description:
      "Choose snapshots or tries from measured collection size, access patterns, and write concurrency.",
    group: "Understand",
    order: 70,
  },
  {
    id: "queries-indexes",
    title: "Queries and secondary indexes",
    description:
      "Define typed collections, bounded predicates, deterministic query plans, explicit indexes, and covering projections.",
    group: "Understand",
    order: 75,
    featured: true,
  },
  {
    id: "deletion-retention",
    title: "Deletion and retention",
    description:
      "Understand tombstones, restore windows, purge grace, scope erasure, and quiescent physical collection.",
    group: "Understand",
    order: 80,
  },
  {
    id: "deployment-cloudflare",
    title: "Deploy to Cloudflare",
    description:
      "Deploy the reference Worker authority with private R2 buckets and an external OIDC application.",
    group: "Deploy and operate",
    order: 10,
    featured: true,
  },
  {
    id: "deployment-azure",
    title: "Deploy to Azure",
    description:
      "Run the Node authority in Azure Container Apps with separate private Blob containers.",
    group: "Deploy and operate",
    order: 20,
  },
  {
    id: "deployment-aws",
    title: "Deploy to AWS",
    description:
      "Run the Lambda container authority with private S3 data and authentication buckets.",
    group: "Deploy and operate",
    order: 30,
  },
  {
    id: "operations",
    title: "Operations",
    description:
      "Plan keys, backups, monitoring, incidents, retention maintenance, and provider lifecycle rules.",
    group: "Deploy and operate",
    order: 40,
  },
  {
    id: "migration",
    title: "Logical migration",
    description:
      "Move data through checksummed NDJSON archives and JSON, CSV, lowdb, SQLite, PostgreSQL, or Firestore adapters.",
    group: "Deploy and operate",
    order: 50,
    featured: true,
  },
  {
    id: "public-api",
    title: "Public package API",
    description:
      "Use stable root, authentication, authority, and provider package exports.",
    group: "Reference",
    order: 10,
  },
  {
    id: "versioning",
    title: "Versioning and compatibility",
    description:
      "Understand package semver, TDB1 protocol compatibility, key versions, and provider adapter changes.",
    group: "Reference",
    order: 20,
  },
  {
    id: "evaluation",
    title: "Evaluation harness",
    description:
      "Run the sample store, local provider, browser harness, and reproducible workload measurements.",
    group: "Reference",
    order: 30,
  },
  {
    id: "benchmarks",
    title: "R2 browser benchmarks",
    description:
      "Read multi-region browser results, raw evidence references, limitations, and layout findings.",
    group: "Reference",
    order: 40,
    featured: true,
  },
  {
    id: "changelog",
    title: "Changelog",
    description:
      "Review package releases and user-visible changes across the ThimbleDB project.",
    group: "Reference",
    order: 50,
  },
  {
    id: "faq",
    title: "Frequently asked questions",
    description:
      "Get direct answers about fit, security, providers, performance, identity, deletion, and limitations.",
    group: "Start here",
    order: 50,
  },
];

export const docGroups: DocGroup[] = [
  "Start here",
  "Use cases",
  "Compare",
  "Understand",
  "Deploy and operate",
  "Reference",
];

const docsById = new Map(docs.map((doc) => [doc.id, doc]));

export function getDocMeta(id: string): DocMeta {
  const meta = docsById.get(id);
  if (meta) {
    return meta;
  }
  const title = id
    .split("/")
    .at(-1)!
    .split("-")
    .map((word) => `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`)
    .join(" ");
  return {
    id,
    title,
    description: `ThimbleDB documentation for ${title}.`,
    group: "Reference",
    order: 999,
  };
}

export function getDocsByGroup(group: DocGroup): DocMeta[] {
  return docs
    .filter((doc) => doc.group === group && doc.id !== "faq")
    .sort((left, right) => left.order - right.order);
}

export function getFeaturedDocs(): DocMeta[] {
  return docs.filter((doc) => doc.featured);
}

export function getRelatedDocs(id: string): DocMeta[] {
  const current = getDocMeta(id);
  return docs
    .filter(
      (doc) =>
        doc.id !== id &&
        doc.id !== "faq" &&
        doc.group === current.group,
    )
    .sort((left, right) => left.order - right.order)
    .slice(0, 3);
}

export function getDocHref(id: string): string {
  return docRoute(id);
}
