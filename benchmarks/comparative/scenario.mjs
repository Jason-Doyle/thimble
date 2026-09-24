import { performance } from "node:perf_hooks";

export const scenario = {
  name: "bounded-notes-v1",
  documents: 500,
  pointReads: 100,
  repeatedReads: 100,
  updates: 50,
};

export async function runScenario(adapter) {
  const documents = Array.from(
    { length: scenario.documents },
    (_, index) => ({
      id: `note-${String(index).padStart(4, "0")}`,
      title: `Note ${index % 25}`,
      body: `Deterministic body ${index}`,
      lastModified: index,
    }),
  );
  const ids = Array.from(
    { length: scenario.pointReads },
    (_, index) =>
      documents[(index * 37) % documents.length].id,
  );
  const result = {
    adapter: adapter.name,
    scenario: scenario.name,
    environment: adapter.environment,
    phases: {},
  };

  result.phases.seed = await measure(async () => {
    await adapter.seed(documents);
  });
  result.phases.pointReads = await measure(async () => {
    for (const id of ids) {
      await adapter.get(id);
    }
  });
  result.phases.repeatedReads = await measure(async () => {
    const id = documents[0].id;
    for (let index = 0; index < scenario.repeatedReads; index += 1) {
      await adapter.get(id);
    }
  });
  result.phases.titleLookup = await measure(async () => {
    const found = await adapter.findByTitle("Note 7");
    if (found.length !== 20) {
      throw new Error(
        `${adapter.name} title lookup returned ${found.length} documents`,
      );
    }
  });
  result.phases.scan = await measure(async () => {
    const found = await adapter.scan();
    if (found.length !== documents.length) {
      throw new Error(
        `${adapter.name} scan returned ${found.length} documents`,
      );
    }
  });
  result.phases.updates = await measure(async () => {
    for (let index = 0; index < scenario.updates; index += 1) {
      const document = {
        ...documents[index],
        body: `Updated body ${index}`,
        lastModified: documents.length + index,
      };
      await adapter.put(document);
    }
  });

  await adapter.close();
  return result;
}

async function measure(operation) {
  const started = performance.now();
  await operation();
  return {
    durationMs: Number((performance.now() - started).toFixed(3)),
  };
}
