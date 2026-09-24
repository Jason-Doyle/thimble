import { describe, expect, it } from "vitest";
import {
  evaluateThimbleQuery,
  pointReadId,
  type ThimbleQuery,
} from "../src/index.js";

type Note = {
  id: string;
  title: string;
  status: "open" | "done";
  priority: number;
  tags: string[];
};

const notes: Note[] = [
  {
    id: "note-1",
    title: "Write tests",
    status: "open",
    priority: 2,
    tags: ["code", "quality"],
  },
  {
    id: "note-2",
    title: "Publish docs",
    status: "done",
    priority: 1,
    tags: ["docs"],
  },
  {
    id: "note-3",
    title: "Review security",
    status: "open",
    priority: 3,
    tags: ["security", "quality"],
  },
];

describe("bounded query evaluator", () => {
  it("filters, orders, and limits documents deterministically", () => {
    const result = evaluateThimbleQuery(notes, {
      version: 1,
      where: {
        and: [
          {
            field: "status",
            operator: "eq",
            value: "open",
          },
          {
            field: "tags",
            operator: "contains",
            value: "quality",
          },
        ],
      },
      orderBy: [
        {
          field: "priority",
          direction: "desc",
        },
      ],
      limit: 1,
      maxScanDocuments: 10,
    });

    expect(result).toEqual({
      documents: [notes[2]],
      plan: "scan",
      indexName: null,
      scannedDocuments: 3,
    });
  });

  it("recognizes ID equality as a point-read plan", () => {
    const query: ThimbleQuery<Note> = {
      version: 1,
      where: {
        field: "id",
        operator: "eq",
        value: "note-2",
      },
    };

    expect(pointReadId(query)).toBe("note-2");
  });

  it("rejects scans above the configured bound", () => {
    expect(() =>
      evaluateThimbleQuery(notes, {
        version: 1,
        maxScanDocuments: 2,
      }),
    ).toThrow("above the configured maximum");
  });

  it("rejects invalid limits and unbounded in lists", () => {
    expect(() =>
      evaluateThimbleQuery(notes, {
        version: 1,
        limit: 0,
      }),
    ).toThrow("between 1 and 1000");

    expect(() =>
      evaluateThimbleQuery(notes, {
        version: 1,
        where: {
          field: "status",
          operator: "in",
          value: [],
        },
      }),
    ).toThrow("between 1 and 100 values");
  });

  it("rejects malformed and excessively large expression trees", () => {
    expect(() =>
      evaluateThimbleQuery(notes, {
        version: 1,
        where: null,
      } as unknown as ThimbleQuery<Note>),
    ).toThrow("expression is malformed");

    expect(() =>
      evaluateThimbleQuery(notes, {
        version: 1,
        orderBy: [
          {
            field: "title",
            direction: "sideways",
          },
        ],
      } as unknown as ThimbleQuery<Note>),
    ).toThrow("ordering is malformed");

    expect(() =>
      evaluateThimbleQuery(notes, {
        version: 1,
        where: {
          field: "priority",
          operator: "gt",
          value: null,
        },
      }),
    ).toThrow("require a string or number");

    expect(() =>
      evaluateThimbleQuery(notes, {
        version: 1,
        where: {
          field: "title",
          operator: "eq",
          value: new Date(),
        },
      } as unknown as ThimbleQuery<Note>),
    ).toThrow("comparison is malformed");
  });
});
