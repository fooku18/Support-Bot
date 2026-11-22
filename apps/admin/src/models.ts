import {
  parseModelCatalog,
  stubModelCatalog,
  type CatalogEntry,
} from './generated/model-catalog.js';

export interface ModelKeys {
  keys: string[];
  defaultKey: string;
  entries?: CatalogEntry[];
}

export function parseModelKeys(rawModels: string, rawDefault: string, stub = false) {
  try {
    // Isolated admin fixtures can run without an execution deployment.
    if (!rawModels && !rawDefault) return { models: null, problems: [] };
    const catalog = parseModelCatalog(rawModels, rawDefault);
    const effective = stub ? stubModelCatalog(catalog) : catalog;
    return {
      models: {
        keys: effective.models.map(({ key }) => key),
        defaultKey: effective.defaultKey,
        entries: effective.models,
      },
      problems: [],
    };
  } catch (error) {
    return { models: null, problems: [`- ${(error as Error).message}`] };
  }
}
