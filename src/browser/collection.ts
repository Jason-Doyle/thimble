import type { JsonDocument } from "../core.js";
import {
  evaluateThimbleQuery,
  pointReadId,
  type QueryExpression,
  type QueryOrder,
  type ThimbleQuery,
  type ThimbleQueryResult,
  validateThimbleQuery,
} from "../query.js";
import type { TrieReadBundle } from "../trie-protocol.js";
import {
  createDictionary,
  validateName,
} from "../shared-utils.js";
import {
  validateIndexConfiguration,
  type CollectionIndexConfiguration,
  type SecondaryIndexDefinition,
} from "../secondary-index.js";

export type ThimbleSchema<T> = {
  parse(value: unknown): T;
};

export type CollectionDefinition<T extends { id: string }> = {
  name: string;
  schema?: ThimbleSchema<T>;
  indexes?: SecondaryIndexDefinition[];
};

export type QueryFieldExpression<
  T extends { id: string },
  K extends Extract<keyof T, string>,
> = {
  eq(value: T[K]): QueryExpression<T>;
  ne(value: T[K]): QueryExpression<T>;
  lt(value: T[K]): QueryExpression<T>;
  lte(value: T[K]): QueryExpression<T>;
  gt(value: T[K]): QueryExpression<T>;
  gte(value: T[K]): QueryExpression<T>;
  in(values: T[K][]): QueryExpression<T>;
  contains(
    value: T[K] extends Array<infer Item>
      ? Item
      : T[K] extends string
        ? string
        : never,
  ): QueryExpression<T>;
  asc(): QueryOrder<T>;
  desc(): QueryOrder<T>;
};

export type QueryFields<T extends { id: string }> = {
  [K in Extract<keyof T, string>]: QueryFieldExpression<T, K>;
};

export type QueryPlan = {
  plan: "point" | "index" | "scan";
  indexName: string | null;
  reason: string;
};

export interface CollectionClient {
  get(collection: string, id: string): Promise<JsonDocument | null>;
  scan(collection: string): Promise<JsonDocument[]>;
  write(
    collection: string,
    id: string,
    document: JsonDocument,
  ): Promise<TrieReadBundle>;
  delete(collection: string, id: string): Promise<TrieReadBundle>;
  restore(collection: string, id: string): Promise<TrieReadBundle>;
  queryDocuments?<T extends { id: string }>(
    collection: string,
    query: ThimbleQuery<T>,
  ): Promise<ThimbleQueryResult<T>>;
  explainQuery?<T extends { id: string }>(
    collection: string,
    query: ThimbleQuery<T>,
  ): QueryPlan;
}

export function defineCollection<T extends { id: string }>(
  name: string,
  options?: {
    schema?: ThimbleSchema<T>;
    indexes?: SecondaryIndexDefinition[];
  },
): CollectionDefinition<T>;
export function defineCollection<T extends { id: string }>(
  name: string,
  schema?: ThimbleSchema<T>,
  options?: {
    indexes?: SecondaryIndexDefinition[];
  },
): CollectionDefinition<T>;
export function defineCollection<T extends { id: string }>(
  name: string,
  schemaOrOptions?:
    | ThimbleSchema<T>
    | {
        schema?: ThimbleSchema<T>;
        indexes?: SecondaryIndexDefinition[];
      },
  legacyOptions: {
    indexes?: SecondaryIndexDefinition[];
  } = {},
): CollectionDefinition<T> {
  const normalizedName = validateName(name, "Collection");
  const schema =
    schemaOrOptions && "parse" in schemaOrOptions
      ? schemaOrOptions
      : schemaOrOptions?.schema;
  const indexes =
    schemaOrOptions && "parse" in schemaOrOptions
      ? legacyOptions.indexes
      : schemaOrOptions?.indexes;
  return {
    name: normalizedName,
    ...(schema ? { schema } : {}),
    ...(indexes
      ? {
          indexes: validateIndexConfiguration({
            [normalizedName]: indexes,
          })[normalizedName],
        }
      : {}),
  };
}

export function collectionIndexConfiguration(
  definitions: Array<{
    name: string;
    indexes?: SecondaryIndexDefinition[];
  }>,
): CollectionIndexConfiguration {
  const configuration =
    createDictionary<SecondaryIndexDefinition[]>();
  for (const definition of definitions) {
    if (!definition.indexes) {
      continue;
    }
    if (Object.hasOwn(configuration, definition.name)) {
      throw new Error(
        `Duplicate collection definition: ${definition.name}`,
      );
    }
    configuration[definition.name] = definition.indexes;
  }
  return validateIndexConfiguration(configuration);
}

export class ThimbleCollection<T extends { id: string }> {
  constructor(
    private readonly client: CollectionClient,
    readonly definition: CollectionDefinition<T>,
  ) {}

  async get(id: string): Promise<T | null> {
    const document = await this.client.get(
      this.definition.name,
      id,
    );
    return document ? this.parse(document) : null;
  }

  async scan(): Promise<T[]> {
    return Promise.all(
      (await this.client.scan(this.definition.name)).map(
        (document) => this.parse(document),
      ),
    );
  }

  async put(document: T): Promise<TrieReadBundle> {
    const parsed = this.parse(document);
    return this.client.write(
      this.definition.name,
      parsed.id,
      parsed as unknown as JsonDocument,
    );
  }

  async delete(id: string): Promise<TrieReadBundle> {
    return this.client.delete(this.definition.name, id);
  }

  async restore(id: string): Promise<TrieReadBundle> {
    return this.client.restore(this.definition.name, id);
  }

  async query(
    query: ThimbleQuery<T>,
  ): Promise<ThimbleQueryResult<T>> {
    validateThimbleQuery(query);
    if (this.client.queryDocuments) {
      const result = await this.client.queryDocuments(
        this.definition.name,
        query,
      );
      return {
        ...result,
        documents: result.documents.map((document) =>
          this.parse(document as unknown as JsonDocument),
        ),
      };
    }
    const pointId = pointReadId(query);
    if (pointId) {
      const document = await this.get(pointId);
      return {
        documents: document ? [document] : [],
        plan: "point",
        indexName: null,
        scannedDocuments: document ? 1 : 0,
      };
    }
    return evaluateThimbleQuery(await this.scan(), query);
  }

  where(
    predicate: (fields: QueryFields<T>) => QueryExpression<T>,
  ): ThimbleQueryBuilder<T> {
    return new ThimbleQueryBuilder(this).where(predicate);
  }

  orderBy(
    selector: (fields: QueryFields<T>) => QueryOrder<T>,
  ): ThimbleQueryBuilder<T> {
    return new ThimbleQueryBuilder(this).orderBy(selector);
  }

  async filter(
    predicate: (document: T) => boolean,
    maxScanDocuments = 1_000,
  ): Promise<T[]> {
    validateThimbleQuery({
      version: 1,
      maxScanDocuments,
    });
    const documents = await this.scan();
    if (documents.length > maxScanDocuments) {
      throw new Error(
        `Local filter contains ${documents.length} documents, above the configured maximum of ${maxScanDocuments}`,
      );
    }
    return documents.filter(predicate);
  }

  explain(query: ThimbleQuery<T>): QueryPlan {
    validateThimbleQuery(query);
    if (this.client.explainQuery) {
      return this.client.explainQuery(
        this.definition.name,
        query,
      );
    }
    return pointReadId(query)
      ? {
          plan: "point",
          indexName: null,
          reason: "ID equality resolves to a direct document read",
        }
      : {
          plan: "scan",
          indexName: null,
          reason:
            "No matching secondary index is configured; the bounded collection is scanned locally",
        };
  }

  private parse(value: JsonDocument): T {
    try {
      return this.definition.schema
        ? this.definition.schema.parse(value)
        : (value as T);
    } catch (error) {
      throw new Error(
        `Document validation failed in collection ${this.definition.name} for ${value.id}`,
        { cause: error },
      );
    }
  }
}

export class ThimbleQueryBuilder<T extends { id: string }> {
  private queryValue: ThimbleQuery<T> = {
    version: 1,
  };

  constructor(private readonly collection: ThimbleCollection<T>) {}

  where(
    predicate: (fields: QueryFields<T>) => QueryExpression<T>,
  ): this {
    const expression = predicate(queryFields<T>());
    this.queryValue = {
      ...this.queryValue,
      where: this.queryValue.where
        ? {
            and: [this.queryValue.where, expression],
          }
        : expression,
    };
    return this;
  }

  orWhere(
    predicate: (fields: QueryFields<T>) => QueryExpression<T>,
  ): this {
    const expression = predicate(queryFields<T>());
    this.queryValue = {
      ...this.queryValue,
      where: this.queryValue.where
        ? {
            or: [this.queryValue.where, expression],
          }
        : expression,
    };
    return this;
  }

  orderBy(
    selector: (fields: QueryFields<T>) => QueryOrder<T>,
  ): this {
    this.queryValue = {
      ...this.queryValue,
      orderBy: [selector(queryFields<T>())],
    };
    return this;
  }

  thenBy(
    selector: (fields: QueryFields<T>) => QueryOrder<T>,
  ): this {
    this.queryValue = {
      ...this.queryValue,
      orderBy: [
        ...(this.queryValue.orderBy ?? []),
        selector(queryFields<T>()),
      ],
    };
    return this;
  }

  take(limit: number): this {
    this.queryValue = {
      ...this.queryValue,
      limit,
    };
    return this;
  }

  maxScan(maxScanDocuments: number): this {
    this.queryValue = {
      ...this.queryValue,
      maxScanDocuments,
    };
    return this;
  }

  get(): Promise<ThimbleQueryResult<T>> {
    return this.collection.query(this.queryValue);
  }

  explain(): QueryPlan {
    return this.collection.explain(this.queryValue);
  }

  toJSON(): ThimbleQuery<T> {
    return structuredClone(this.queryValue);
  }
}

function queryFields<T extends { id: string }>(): QueryFields<T> {
  return new Proxy(
    {},
    {
      get: (_target, property) => {
        if (typeof property !== "string") {
          return undefined;
        }
        return fieldExpression<T>(property);
      },
    },
  ) as QueryFields<T>;
}

function fieldExpression<T extends { id: string }>(
  field: string,
): QueryFieldExpression<T, Extract<keyof T, string>> {
  const comparison =
    (operator: QueryExpressionOperator) =>
    (value: unknown): QueryExpression<T> => ({
      field: field as Extract<keyof T, string>,
      operator,
      value: value as never,
    });
  const order = (direction: "asc" | "desc"): QueryOrder<T> => ({
    field: field as Extract<keyof T, string>,
    direction,
  });
  return {
    eq: comparison("eq"),
    ne: comparison("ne"),
    lt: comparison("lt"),
    lte: comparison("lte"),
    gt: comparison("gt"),
    gte: comparison("gte"),
    in: comparison("in"),
    contains: comparison("contains"),
    asc: () => order("asc"),
    desc: () => order("desc"),
  } as QueryFieldExpression<
    T,
    Extract<keyof T, string>
  >;
}

type QueryExpressionOperator =
  QueryExpression<JsonDocument> extends infer Expression
    ? Expression extends { operator: infer Operator }
      ? Operator
      : never
    : never;
